// BrowserHost: the desktop-host half of the BrowserHostBroker bridge.
//
// Topology (deliverable/browser-phase0-protocol v4):
// - host listens on 127.0.0.1:<ephemeral> (loopback only)
// - host registers OUT to the sidecar: POST {sidecar}/api/browser/host/hello
//   with HostRegistration (HostHello + session context + callbackUrl +
//   callbackToken), Basic auth
// - sidecar forwards BrokerRequest envelopes IN: POST {callbackUrl}/v1/browser/request
//   with Authorization: Bearer <callbackToken>; host answers BrokerResponse (HTTP 200)
// - abort: POST {callbackUrl}/v1/browser/request/:requestId/abort (same Bearer)
// - host pushes state/events OUT: POST {sidecar}/api/browser/event
//
// Request/response ownership: each in-flight request has ONE responder
// (flight.respond) — timeout, abort, success, and failure all funnel through
// it, so exactly one HTTP response is ever written per request.

import { createServer } from "node:http"
import type { Server, IncomingMessage, ServerResponse } from "node:http"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"

import { toBrokerErrorBody, BrowserControlInterruptedError, BrowserOperationFailedError, BrowserTimeoutError } from "./errors"
import {
  BROKER_REQUEST_PATH,
  BROWSER_PROTOCOL_VERSION,
  isBrokerRequest,
  type BrokerRequest,
  type BrokerResponse,
  type BrokerResponseErrorBody,
  type BrowserOperation,
  type HostCapabilities,
  type HostEvent,
} from "./contracts"

const HELLO_PATH = "/api/browser/host/hello"
const EVENT_PATH = "/api/browser/event"
const HELLO_INTERVAL_MS = 30_000
const HELLO_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

export interface BrowserHostOptions {
  hostId: string
  hostEpoch: number
  windowId: string
  capabilities: HostCapabilities
  /** Latest sidecar endpoint+auth; null until the app server is ready. */
  sidecarProvider: () => { url: string; username: string; password: string } | null
  /** Stickiness context (sessionId + optional workspace/directory) reported in hello. */
  getSessionContext: () => { sessionId: string; workspaceId?: string; directory?: string }
  getGuestSnapshot: () => { attached: boolean; activeTabId: string | null; url: string | null }
  /** Execute a broker operation; rejects with typed errors (./errors). */
  dispatch: (tabId: string | undefined, operation: BrowserOperation) => Promise<Record<string, unknown>>
  /** Called for every settled request (for host events). */
  onSettled?: (request: BrokerRequest, response: BrokerResponse) => void
  onConnectedChange?: (connected: boolean) => void
  logger?: { log: (message: string, meta?: Record<string, unknown>) => void; error: (message: string, meta?: Record<string, unknown>) => void }
}

interface InFlight {
  request: BrokerRequest
  timer: ReturnType<typeof setTimeout>
  /** Single owner of the HTTP response for this request. */
  respond: (response: BrokerResponse) => void
}

export class BrowserHost {
  private server: Server | null = null
  private port = 0
  private callbackToken = randomUUID()
  private connected = false
  private readonly inFlight = new Map<string, InFlight>()
  private helloTimer: ReturnType<typeof setInterval> | null = null
  private helloRetryTimer: ReturnType<typeof setTimeout> | null = null
  private helloInFlight = false
  private pendingHelloAttempt: number | undefined
  private stopping = false
  private readonly options: BrowserHostOptions

  constructor(options: BrowserHostOptions) {
    this.options = options
  }

  get isConnected(): boolean {
    return this.connected
  }

  get callbackUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get callbackUrlToken(): string {
    return this.callbackToken
  }

  /** Start the loopback listener, then register with the sidecar (retry+heartbeat). */
  async start(): Promise<void> {
    this.stopping = false
    const server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
    this.server = server
    const address = server.address()
    this.port = typeof address === "object" && address !== null ? address.port : 0
    this.log(`browser host listening on ${this.callbackUrl}`)
    this.registerHello(0)
    this.helloTimer = setInterval(() => this.registerHello(0), HELLO_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.helloTimer) clearInterval(this.helloTimer)
    this.helloTimer = null
    if (this.helloRetryTimer) clearTimeout(this.helloRetryTimer)
    this.helloRetryTimer = null
    this.pendingHelloAttempt = undefined
    for (const flight of this.inFlight.values()) {
      clearTimeout(flight.timer)
      flight.respond(
        responseError(flight.request.requestId, 0, new BrowserControlInterruptedError("Host stopping")),
      )
    }
    this.inFlight.clear()
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    this.setConnected(false)
    this.emitHostEvent({ type: "host.stopping", timestamp: new Date().toISOString() })
  }

  /** Re-register immediately (e.g. after the session context changes). */
  reRegister(): void {
    if (this.server === null) return
    this.registerHello(0)
  }

  /** Fire a host event to the sidecar (best-effort; logged on failure). */
  emitHostEvent(event: HostEvent): void {
    const sidecar = this.options.sidecarProvider()
    if (!sidecar) return
    void this.postSidecar(sidecar, EVENT_PATH, event).catch((error) => {
      this.logError("browser host event failed", { event: event.type, error: String(error) })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", this.callbackUrl)
      const method = req.method ?? "GET"

      if (method === "GET" && url.pathname === "/health") {
        respondJson(res, 200, { ok: true, connected: this.connected })
        return
      }

      if (method === "POST" && url.pathname === BROKER_REQUEST_PATH) {
        if (!authorizeRequest(req, this.callbackToken)) {
          respondJson(res, 401, { ok: false, error: "Unauthorized" })
          return
        }
        const body = await readJson(req)
        await this.handleRequest(body, res)
        return
      }

      const abortMatch = url.pathname.match(/^\/v1\/browser\/request\/([^/]+)\/abort$/)
      if (method === "POST" && abortMatch) {
        if (!authorizeRequest(req, this.callbackToken)) {
          respondJson(res, 401, { ok: false, error: "Unauthorized" })
          return
        }
        this.handleAbort(abortMatch[1]!, res)
        return
      }

      respondJson(res, 404, { ok: false, error: "Not found" })
    } catch (error) {
      this.logError("browser host request failed", { error: String(error) })
      respondJson(res, 200, responseError("", 0, error))
    }
  }

  private async handleRequest(body: unknown, res: ServerResponse): Promise<void> {
    const startedAt = Date.now()
    if (!isBrokerRequest(body)) {
      respondJson(
        res,
        200,
        responseError("", 0, new BrowserOperationFailedError("Invalid BrokerRequest envelope")),
      )
      return
    }
    const request = body as BrokerRequest

    const timer = setTimeout(() => {
      const flight = this.inFlight.get(request.requestId)
      flight?.respond(
        responseError(request.requestId, Date.now() - startedAt, new BrowserTimeoutError("request", request.timeoutMs)),
      )
    }, request.timeoutMs)
    this.inFlight.set(request.requestId, {
      request,
      timer,
      respond: (response) => {
        const flight = this.inFlight.get(request.requestId)
        if (!flight || flight.timer !== timer) return
        clearTimeout(timer)
        this.inFlight.delete(request.requestId)
        this.options.onSettled?.(request, response)
        respondJson(res, 200, response)
      },
    })

    try {
      const result = await this.options.dispatch(request.tabId, request.operation)
      const response: BrokerResponse = {
        ok: true,
        requestId: request.requestId,
        result,
        elapsedMs: Date.now() - startedAt,
      }
      this.inFlight.get(request.requestId)?.respond(response)
    } catch (error) {
      const response = responseError(request.requestId, Date.now() - startedAt, error)
      this.inFlight.get(request.requestId)?.respond(response)
    }
  }

  private handleAbort(requestId: string, res: ServerResponse): void {
    const flight = this.inFlight.get(requestId)
    if (flight) {
      flight.respond(
        responseError(requestId, 0, new BrowserControlInterruptedError("Request aborted by caller")),
      )
      this.log("browser request aborted", { requestId })
    }
    respondJson(res, 200, { ok: true, aborted: true })
  }

  private registerHello(attempt: number): void {
    if (this.stopping || this.server === null) return
    if (this.helloInFlight) {
      this.pendingHelloAttempt = Math.min(this.pendingHelloAttempt ?? attempt, attempt)
      return
    }
    const sidecar = this.options.sidecarProvider()
    if (!sidecar) {
      this.scheduleHelloRetry(attempt)
      return
    }
    const registration = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      hostId: this.options.hostId,
      hostEpoch: this.options.hostEpoch,
      connectionId: this.callbackToken,
      windowId: this.options.windowId,
      capabilities: this.options.capabilities,
      guest: this.options.getGuestSnapshot(),
      ...this.options.getSessionContext(),
      callbackUrl: this.callbackUrl,
      callbackToken: this.callbackToken,
    }
    this.helloInFlight = true
    this.postSidecar(sidecar, HELLO_PATH, registration)
      .then((reply) => {
        const parsed = reply as { data?: { accepted?: boolean; brokerProtocolVersion?: number; hostId?: string; replacement?: boolean } }
        const accepted = parsed?.data?.accepted === true
        this.setConnected(accepted)
        if (!accepted) {
          this.log("browser host hello rejected", { reason: parsed?.data })
          this.scheduleHelloRetry(attempt)
        }
      })
      .catch((error) => {
        this.setConnected(false)
        this.logError("browser host hello failed", { attempt, error: String(error) })
        this.scheduleHelloRetry(attempt)
      })
      .finally(() => {
        this.helloInFlight = false
        const pending = this.pendingHelloAttempt
        this.pendingHelloAttempt = undefined
        if (pending !== undefined) this.registerHello(pending)
      })
  }

  private scheduleHelloRetry(attempt: number): void {
    if (this.stopping || this.server === null) return
    const delay = HELLO_BACKOFF_MS[Math.min(attempt, HELLO_BACKOFF_MS.length - 1)] ?? HELLO_BACKOFF_MS[0]!
    if (this.helloRetryTimer) clearTimeout(this.helloRetryTimer)
    this.helloRetryTimer = setTimeout(() => {
      this.helloRetryTimer = null
      this.registerHello(attempt + 1)
    }, delay)
    this.helloRetryTimer.unref?.()
  }

  private async postSidecar(
    sidecar: { url: string; username: string; password: string },
    path: string,
    body: unknown,
  ): Promise<unknown> {
    const response = await fetch(`${sidecar.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${sidecar.username}:${sidecar.password}`).toString("base64")}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`sidecar ${path} responded ${response.status}`)
    // Event acks can come back 200 with an empty body (emitHostEvent doesn't
    // use the return value); unconditionally calling response.json() on an
    // empty body throws "Unexpected end of JSON input" for every single
    // event. Only hello's response is actually parsed.
    const text = await response.text()
    if (!text) return undefined
    return JSON.parse(text) as unknown
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    this.options.onConnectedChange?.(connected)
  }

  private log(message: string, meta?: Record<string, unknown>): void {
    this.options.logger?.log(message, meta)
  }

  private logError(message: string, meta?: Record<string, unknown>): void {
    this.options.logger?.error(message, meta)
  }
}

// --- helpers ---------------------------------------------------------------

/** Read Authorization: Bearer <token> and compare timing-safe against the callback token. */
const authorizeRequest = (req: IncomingMessage, expected: string): boolean => {
  const header = req.headers["authorization"]
  if (typeof header !== "string") return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return false
  return safeEqual(match[1]!, expected)
}

const safeEqual = (left: string, right: string): boolean => {
  const a = createHash("sha256").update(left).digest()
  const b = createHash("sha256").update(right).digest()
  return timingSafeEqual(a, b)
}

const readJson = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8")
        resolve(text ? (JSON.parse(text) as unknown) : null)
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })

const respondJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

const responseError = (requestId: string, elapsedMs: number, error: unknown): BrokerResponse => {
  const body: BrokerResponseErrorBody = toBrokerErrorBody(error)
  return { ok: false, requestId, elapsedMs, error: body }
}
