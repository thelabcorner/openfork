export * as OfxpTransport from "./transport"

import { randomUUID } from "node:crypto"
import { createServer as createTlsServer, connect as tlsConnect, type Server as TlsServer, type TLSSocket } from "node:tls"
import { Schema } from "effect"
import { OfxpPairing } from "@opencode-ai/core/ofxp-peer/pairing"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpCertificate, type Material, type PeerCertificateIdentity } from "./certificate"
import { PairRateLimiter } from "./pair-rate-limit"

export const ALPN = "ofxp/1"
export const WIRE_VERSION = 1
export const MAX_FRAME_BYTES = 2 * 1024 * 1024
export const MAX_CONNECTIONS = 128
export const MAX_INFLIGHT_PER_CONNECTION = 64
export const CONNECT_TIMEOUT_MS = 5_000
export const REQUEST_TIMEOUT_MS = 10_000

type WireRequest = {
  readonly v: typeof WIRE_VERSION
  readonly id: string
  readonly kind: "request"
  readonly method: string
  readonly body?: unknown
}

type WireCancel = {
  readonly v: typeof WIRE_VERSION
  readonly id: string
  readonly kind: "cancel"
}

type WireResponse =
  | {
      readonly v: typeof WIRE_VERSION
      readonly id: string
      readonly kind: "response"
      readonly ok: true
      readonly body?: unknown
    }
  | {
      readonly v: typeof WIRE_VERSION
      readonly id: string
      readonly kind: "response"
      readonly ok: false
      readonly error: string
    }

type WireEnvelope = WireRequest | WireCancel | WireResponse

export interface Endpoint {
  readonly host: string
  readonly port: number
  readonly peerID: Ofxp.PeerID
  readonly stop: () => Promise<void>
}

export interface StartOptions {
  readonly material: Material
  readonly identity: Ofxp.PeerIdentity
  readonly hello: Ofxp.Hello
  readonly pairing: OfxpPairing.Coordinator
  /** Optional local old-key continuity proof; emitted only while still valid. */
  readonly localRekeyProof?: Ofxp.RekeyProof
  readonly host?: string
  readonly port?: number
  readonly application?: ApplicationHandler
  readonly onError?: (error: unknown) => void
}

export interface ApplicationRequest {
  readonly method: string
  readonly body?: unknown
  /** Identity derived from the TLS client certificate; never caller JSON. */
  readonly peer: PeerCertificateIdentity
  /** Aborted when the authenticated peer connection closes. */
  readonly signal: AbortSignal
}

export type ApplicationHandler = (request: ApplicationRequest) => Promise<unknown>

export interface RequestOptions {
  readonly material: Material
  readonly endpoint: { readonly host: string; readonly port: number }
  readonly expectedPeerID: Ofxp.PeerID
  readonly method: string
  readonly body?: unknown
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface Response<T> {
  readonly peer: PeerCertificateIdentity
  readonly body: T
}

function peerFromSocket(socket: TLSSocket, now = Date.now()) {
  // Bun's Node TLS compatibility can omit a custom negotiated ALPN value. A
  // negotiated wrong value is rejected; an absent value is tolerated because
  // this is a dedicated OFXP TLS listener and every frame is protocol-versioned.
  if (socket.alpnProtocol && socket.alpnProtocol !== ALPN) {
    throw new Error(`OFXP TLS ALPN mismatch: ${socket.alpnProtocol}`)
  }
  const cert = socket.getPeerCertificate(true)
  if (!cert || !cert.raw || cert.raw.byteLength === 0) throw new Error("OFXP TLS peer did not present a certificate")
  if (!OfxpCertificate.validAt(cert.raw, now)) throw new Error("OFXP TLS peer certificate is expired or not yet valid")
  return OfxpCertificate.identity(cert.raw)
}

function samePeerIdentity(declared: Ofxp.PeerIdentity, transport: PeerCertificateIdentity) {
  return (
    declared.id === transport.peerID &&
    declared.fingerprint === transport.fingerprint &&
    declared.publicKeySpki.trim() === transport.publicKeySpki.trim()
  )
}

function encodeFrame(value: WireEnvelope) {
  const payload = Buffer.from(JSON.stringify(value), "utf8")
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error("OFXP frame exceeds byte limit")
  const frame = Buffer.allocUnsafe(4 + payload.byteLength)
  frame.writeUInt32BE(payload.byteLength, 0)
  payload.copy(frame, 4)
  return frame
}

class FrameDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  push(chunk: Buffer) {
    if (chunk.byteLength === 0) return [] as WireEnvelope[]
    if (this.buffer.byteLength + chunk.byteLength > MAX_FRAME_BYTES + 4) {
      throw new Error("OFXP buffered frame exceeds byte limit")
    }
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const result: WireEnvelope[] = []
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length <= 0 || length > MAX_FRAME_BYTES) throw new Error("OFXP frame length is invalid")
      if (this.buffer.byteLength < 4 + length) break
      const raw = this.buffer.subarray(4, 4 + length).toString("utf8")
      this.buffer = this.buffer.subarray(4 + length)
      result.push(parseEnvelope(JSON.parse(raw)))
    }
    return result
  }
}

function parseEnvelope(value: unknown): WireEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OFXP frame is not an object")
  const row = value as Record<string, unknown>
  if (row.v !== WIRE_VERSION) throw new Error("OFXP wire protocol version mismatch")
  if (typeof row.id !== "string" || row.id.length < 1 || row.id.length > 96) throw new Error("OFXP frame ID is invalid")
  if (row.kind === "request") {
    if (typeof row.method !== "string" || row.method.length < 1 || row.method.length > 128) {
      throw new Error("OFXP request method is invalid")
    }
    const keys = Object.keys(row)
    if (keys.some((key) => !["v", "id", "kind", "method", "body"].includes(key))) throw new Error("OFXP request has unknown fields")
    return {
      v: WIRE_VERSION,
      id: row.id,
      kind: "request",
      method: row.method,
      ...(Object.hasOwn(row, "body") ? { body: row.body } : {}),
    }
  }
  if (row.kind === "cancel") {
    const keys = Object.keys(row)
    if (keys.some((key) => !["v", "id", "kind"].includes(key))) throw new Error("OFXP cancel has unknown fields")
    return { v: WIRE_VERSION, id: row.id, kind: "cancel" }
  }
  if (row.kind === "response") {
    const keys = Object.keys(row)
    if (row.ok === true) {
      if (keys.some((key) => !["v", "id", "kind", "ok", "body"].includes(key))) throw new Error("OFXP response has unknown fields")
      return { v: WIRE_VERSION, id: row.id, kind: "response", ok: true, ...(Object.hasOwn(row, "body") ? { body: row.body } : {}) }
    }
    if (row.ok === false && typeof row.error === "string" && row.error.length <= 1024) {
      if (keys.some((key) => !["v", "id", "kind", "ok", "error"].includes(key))) throw new Error("OFXP response has unknown fields")
      return { v: WIRE_VERSION, id: row.id, kind: "response", ok: false, error: row.error }
    }
  }
  throw new Error("OFXP frame kind is invalid")
}

async function dispatch(
  request: WireRequest,
  socket: TLSSocket,
  peer: PeerCertificateIdentity,
  options: StartOptions,
  limiter: PairRateLimiter,
  signal: AbortSignal,
) {
  if (request.method === "hello") return options.hello

  if (request.method === "pair.offer") {
    if (!limiter.allow(socket.remoteAddress)) throw new Error("pairing_rate_limited")
    const offer = Schema.decodeUnknownSync(Ofxp.PairingOffer)(request.body, { onExcessProperty: "error" })
    if (!samePeerIdentity(offer.initiator, peer)) throw new Error("pairing_tls_identity_mismatch")
    const localRekeyProof =
      options.localRekeyProof && options.localRekeyProof.expiresAt > Date.now() ? options.localRekeyProof : undefined
    const accepted = options.pairing.acceptOffer(offer, Date.now(), localRekeyProof)
    return { answer: accepted.answer }
  }

  if (!options.application) throw new Error("method_not_found")
  return options.application({
    method: request.method,
    ...(Object.hasOwn(request, "body") ? { body: request.body } : {}),
    peer,
    signal,
  })
}

export async function start(options: StartOptions): Promise<Endpoint> {
  const localCertificate = OfxpCertificate.identity(options.material.cert)
  if (localCertificate.peerID !== options.identity.id || options.hello.peerID !== options.identity.id) {
    throw new Error("OFXP listener identity, certificate, and hello peer IDs must match")
  }
  if (options.pairing.local.id !== options.identity.id) throw new Error("OFXP pairing coordinator belongs to another peer")

  const limiter = new PairRateLimiter()
  const sockets = new Set<TLSSocket>()
  const server = createTlsServer({
    key: options.material.key,
    cert: options.material.cert,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: false,
    ALPNProtocols: [ALPN],
  })

  server.maxConnections = MAX_CONNECTIONS
  server.on("secureConnection", (socket) => {
    let peer: PeerCertificateIdentity
    try {
      peer = peerFromSocket(socket)
    } catch (error) {
      options.onError?.(error)
      socket.destroy()
      return
    }

    sockets.add(socket)
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 15_000)
    socket.setTimeout(30_000, () => socket.destroy(new Error("OFXP idle connection timeout")))
    const requests = new Map<string, AbortController>()
    socket.once("close", () => {
      sockets.delete(socket)
      for (const controller of requests.values()) controller.abort()
      requests.clear()
    })
    const decoder = new FrameDecoder()
    let inflight = 0

    socket.on("data", (raw) => {
      try {
        const frames = decoder.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))
        for (const frame of frames) {
          if (frame.kind === "cancel") {
            requests.get(frame.id)?.abort()
            continue
          }
          if (frame.kind !== "request") throw new Error("OFXP server received an unexpected response frame")
          if (inflight >= MAX_INFLIGHT_PER_CONNECTION) throw new Error("OFXP connection has too many in-flight requests")
          if (requests.has(frame.id)) throw new Error("OFXP connection reused an in-flight request ID")
          inflight++
          const controller = new AbortController()
          requests.set(frame.id, controller)
          void dispatch(frame, socket, peer, options, limiter, controller.signal)
            .then(
              (body) => {
                if (!socket.destroyed && socket.writable) {
                  socket.write(encodeFrame({ v: WIRE_VERSION, id: frame.id, kind: "response", ok: true, body }))
                }
              },
              (error) => {
                const message = error instanceof Error ? error.message : "invalid_request"
                if (!socket.destroyed && socket.writable) {
                  socket.write(
                    encodeFrame({ v: WIRE_VERSION, id: frame.id, kind: "response", ok: false, error: message.slice(0, 1024) }),
                  )
                }
              },
            )
            .finally(() => {
              requests.delete(frame.id)
              inflight--
            })
        }
      } catch (error) {
        options.onError?.(error)
        socket.destroy(error instanceof Error ? error : undefined)
      }
    })
    socket.on("error", (error) => options.onError?.(error))
  })
  server.on("tlsClientError", (error) => options.onError?.(error))

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1")
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    await closeServer(server, sockets)
    throw new Error("OFXP listener did not bind a TCP address")
  }

  let stopped = false
  return {
    host: address.address,
    port: address.port,
    peerID: options.identity.id,
    async stop() {
      if (stopped) return
      stopped = true
      await closeServer(server, sockets)
    },
  }
}

async function closeServer(server: TlsServer, sockets: Set<TLSSocket>) {
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ])
  for (const socket of sockets) socket.destroy()
}

export function connectVerified(options: {
  readonly material: Material
  readonly host: string
  readonly port: number
  readonly expectedPeerID: Ofxp.PeerID
  readonly timeoutMs?: number
}): Promise<{ readonly socket: TLSSocket; readonly peer: PeerCertificateIdentity }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let handshakeComplete = false
    const socket = tlsConnect({
      host: options.host,
      port: options.port,
      cert: options.material.cert,
      key: options.material.key,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: false,
      servername: "",
      ALPNProtocols: [ALPN],
    })
    const timeout = setTimeout(() => fail(new Error("OFXP TLS connect timeout")), options.timeoutMs ?? CONNECT_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timeout)
      socket.off("error", fail)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (!handshakeComplete || socket.destroyed) {
        socket.destroy()
        reject(error)
        return
      }
      // Bun/Windows TLS can crash when an authenticated socket is force-destroyed
      // and the server is torn down immediately afterward. Complete TLS shutdown
      // first and reject only after native socket ownership has settled.
      let done = false
      const finish = () => {
        if (done) return
        done = true
        reject(error)
      }
      socket.once("close", finish)
      socket.once("error", () => {})
      socket.end()
      setTimeout(() => {
        if (!socket.destroyed) socket.destroy()
        finish()
      }, 250)
    }
    socket.once("error", fail)
    socket.once("secureConnect", () => {
      handshakeComplete = true
      try {
        const peer = peerFromSocket(socket)
        if (peer.peerID !== options.expectedPeerID) {
          return fail(new Error(`OFXP TLS peer identity mismatch: expected ${options.expectedPeerID}, got ${peer.peerID}`))
        }
        settled = true
        cleanup()
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 15_000)
        resolve({ socket, peer })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

export class ClientConnection {
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<
    string,
    {
      readonly resolve: (value: unknown) => void
      readonly reject: (error: Error) => void
      readonly timer: ReturnType<typeof setTimeout>
      readonly signal?: AbortSignal
      readonly onAbort?: () => void
    }
  >()
  private closed = false

  get isOpen() {
    return !this.closed && !this.socket.destroyed
  }

  get pendingCount() {
    return this.pending.size
  }

  private constructor(
    readonly peer: PeerCertificateIdentity,
    private readonly socket: TLSSocket,
  ) {
    socket.on("data", (raw) => {
      try {
        for (const frame of this.decoder.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))) {
          if (frame.kind !== "response") throw new Error("OFXP client received an unexpected request frame")
          const pending = this.pending.get(frame.id)
          if (!pending) continue
          this.pending.delete(frame.id)
          clearTimeout(pending.timer)
          if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort)
          if (frame.ok) pending.resolve(frame.body)
          else pending.reject(new Error(frame.error))
        }
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      }
    })
    socket.once("close", () => this.failAll(new Error("OFXP connection closed")))
    socket.on("error", (error) => this.failAll(error))
  }

  static async connect(options: {
    readonly material: Material
    readonly host: string
    readonly port: number
    readonly expectedPeerID: Ofxp.PeerID
    readonly timeoutMs?: number
  }) {
    const connected = await connectVerified(options)
    return new ClientConnection(connected.peer, connected.socket)
  }

  request<T = unknown>(method: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
    if (this.closed || this.socket.destroyed) return Promise.reject(new Error("OFXP connection is closed"))
    if (this.pending.size >= MAX_INFLIGHT_PER_CONNECTION) return Promise.reject(new Error("OFXP connection has too many in-flight requests"))
    if (!method || method.length > 128) return Promise.reject(new Error("OFXP request method is invalid"))
    if (signal?.aborted) return Promise.reject(new Error(`OFXP request cancelled: ${method}`))
    const id = randomUUID()
    const frame = encodeFrame({ v: WIRE_VERSION, id, kind: "request", method, ...(body === undefined ? {} : { body }) })
    return new Promise<T>((resolve, reject) => {
      const cancelRemote = () => {
        if (!this.closed && !this.socket.destroyed && this.socket.writable) {
          this.socket.write(encodeFrame({ v: WIRE_VERSION, id, kind: "cancel" }))
        }
      }
      const finishLocal = (error: Error) => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort)
        cancelRemote()
        reject(error)
      }
      const timer = setTimeout(() => {
        finishLocal(new Error(`OFXP request timed out: ${method}`))
      }, timeoutMs)
      const onAbort = signal ? () => finishLocal(new Error(`OFXP request cancelled: ${method}`)) : undefined
      if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, ...(signal ? { signal } : {}), ...(onAbort ? { onAbort } : {}) })
      this.socket.write(frame, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort)
        reject(error)
      })
    })
  }

  async close() {
    if (this.closed && this.socket.destroyed) return
    this.closed = true
    this.failAll(new Error("OFXP connection closed"))
    if (this.socket.destroyed) return
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      this.socket.once("close", finish)
      this.socket.once("error", () => {})
      this.socket.end()
      setTimeout(() => {
        if (!this.socket.destroyed) this.socket.destroy()
        finish()
      }, 250)
    })
  }

  private failAll(error: Error) {
    if (!this.closed) this.closed = true
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export async function requestJson<T = unknown>(options: RequestOptions): Promise<Response<T>> {
  const connection = await ClientConnection.connect({
    material: options.material,
    host: options.endpoint.host,
    port: options.endpoint.port,
    expectedPeerID: options.expectedPeerID,
    timeoutMs: options.timeoutMs,
  })
  try {
    const body = await connection.request<T>(options.method, options.body, options.timeoutMs, options.signal)
    return { peer: connection.peer, body }
  } finally {
    await connection.close()
  }
}

export async function hello(options: Omit<RequestOptions, "method" | "body">) {
  const response = await requestJson<unknown>({ ...options, method: "hello" })
  const value = Schema.decodeUnknownSync(Ofxp.Hello)(response.body, { onExcessProperty: "error" })
  if (value.peerID !== response.peer.peerID) throw new Error("OFXP hello identity does not match the TLS certificate")
  return { peer: response.peer, hello: value }
}

export async function offerPairing(options: Omit<RequestOptions, "method" | "body"> & { readonly offer: Ofxp.PairingOffer }) {
  const response = await requestJson<unknown>({ ...options, method: "pair.offer", body: options.offer })
  const envelope = Schema.decodeUnknownSync(Schema.Struct({ answer: Ofxp.PairingAnswer }))(response.body, {
    onExcessProperty: "error",
  })
  if (!samePeerIdentity(envelope.answer.responder, response.peer)) {
    throw new Error("OFXP pairing answer identity does not match the TLS certificate")
  }
  return { peer: response.peer, answer: envelope.answer }
}
