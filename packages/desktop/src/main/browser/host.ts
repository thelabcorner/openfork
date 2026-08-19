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

import {
  toBrokerErrorBody,
  BrowserControlInterruptedError,
  BrowserOperationFailedError,
  BrowserTimeoutError,
} from "./errors"
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
// Steady-state re-register cadence. The broker never expires registrations,
// but the heartbeat revives connections it marked dead after a transport
// failure and re-syncs the guest snapshot, so it is worth keeping — it just
// must never restart or reset an active retry chain (see registerHello).
const HELLO_INTERVAL_MS = 30_000
// Per-attempt POST timeout: while the sidecar has never answered, probe with a
// short timeout so a booting sidecar doesn't hold a 10s request hostage per
// attempt; once connected, give the heartbeat a full round-trip budget.
const HELLO_PROBE_TIMEOUT_MS = 3_000
const HELLO_TIMEOUT_MS = 10_000
// Consecutive transient failures (timeout/network) before a previously
// connected host reports itself disconnected. A single slow heartbeat must
// not flap the connection; a sidecar that is truly gone crosses this in a
// few probe cycles.
const HELLO_DISCONNECT_AFTER = 3
const HELLO_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
type HelloReason = "start" | "manual" | "heartbeat" | "retry"

export interface BrowserHostOptions {
  hostId: string
  hostEpoch: number
  windowId: string
  capabilities: HostCapabilities
  /** Latest sidecar endpoint+auth; null until the app server is ready. */
  sidecarProvider: () => { url: string; username: string; password: string } | null
  getGuestSnapshot: () => { attached: boolean; activeTabId: string | null; url: string | null }
  /** Execute a broker operation; rejects with typed errors (./errors). The
   * requesting session is passed so operations can attribute tab ownership. */
  dispatch: (
    tabId: string | undefined,
    operation: BrowserOperation,
    sessionId: string,
  ) => Promise<Record<string, unknown>>
  /** Called for every settled request (for host events). */
  onSettled?: (request: BrokerRequest, response: BrokerResponse) => void
  onConnectedChange?: (connected: boolean) => void
  /** Test hooks: override the per-attempt hello POST timeout and the retry
   * backoff schedule (production uses HELLO_PROBE/HELLO_TIMEOUT and HELLO_BACKOFF). */
  helloTimeoutMs?: number
  helloBackoffMs?: readonly number[]
  logger?: {
    log: (message: string, meta?: Record<string, unknown>) => void
    error: (message: string, meta?: Record<string, unknown>) => void
  }
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
  /** Highest failed attempt merged in while a hello was in flight — the retry
   * that must run once the in-flight hello settles. Keeps the counter
   * monotonic when entries overlap. */
  private pendingRetryAttempt: number | undefined
  /** A start/manual re-register was requested while the chain was active. It
   * is consumed as ONE immediate idempotent re-register after the chain
   * settles successfully — never as a chain restart. */
  private pendingKick = false
  /** Consecutive transient hello failures since the last success; drives the
   * disconnect-after-threshold policy (transient failures never flap). */
  private consecutiveFailures = 0
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
    this.registerHello(0, "start")
    this.helloTimer = setInterval(() => this.registerHello(0, "heartbeat"), HELLO_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.helloTimer) clearInterval(this.helloTimer)
    this.helloTimer = null
    if (this.helloRetryTimer) clearTimeout(this.helloRetryTimer)
    this.helloRetryTimer = null
    this.pendingRetryAttempt = undefined
    this.pendingKick = false
    this.consecutiveFailures = 0
    for (const flight of this.inFlight.values()) {
      clearTimeout(flight.timer)
      flight.respond(responseError(flight.request.requestId, 0, new BrowserControlInterruptedError("Host stopping")))
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

  /** Re-register immediately (e.g. after the session context changes). Merges
   * into the active chain as a single idempotent re-register — it never
   * restarts or resets an in-flight retry chain. */
  reRegister(): void {
    if (this.server === null) return
    this.registerHello(0, "manual")
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
      respondJson(res, 200, responseError("", 0, new BrowserOperationFailedError("Invalid BrokerRequest envelope")))
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
      const result = await this.options.dispatch(request.tabId, request.operation, request.sessionId)
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
      flight.respond(responseError(requestId, 0, new BrowserControlInterruptedError("Request aborted by caller")))
      this.log("browser request aborted", { requestId })
    }
    respondJson(res, 200, { ok: true, aborted: true })
  }

  private registerHello(attempt: number, reason: HelloReason): void {
    if (this.stopping || this.server === null) return
    // One serialized registration chain at a time. While a hello is in flight
    // or a retry is scheduled, further entries are merged — never started —
    // so the attempt counter stays monotonic and chains cannot overlap. The
    // heartbeat is idempotent (the broker treats the same hostId+connectionId
    // as a revive) so it is simply dropped during an active chain.
    if (this.helloInFlight) {
      if (reason === "retry") {
        this.pendingRetryAttempt = Math.max(this.pendingRetryAttempt ?? 0, attempt)
      } else if (reason === "heartbeat") {
        return
      } else {
        this.pendingKick = true
      }
      return
    }
    if (this.helloRetryTimer !== null) {
      if (reason === "heartbeat") return
      // Defer a start/manual re-register to the settled chain instead of
      // cancelling it (cancelling resets the backoff attempt).
      this.pendingKick = true
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
      callbackUrl: this.callbackUrl,
      callbackToken: this.callbackToken,
    }
    this.helloInFlight = true
    let succeeded = false
    this.postSidecar(sidecar, HELLO_PATH, registration, this.helloTimeoutMs())
      .then((reply) => {
        const parsed = reply as {
          data?: { accepted?: boolean; brokerProtocolVersion?: number; hostId?: string; replacement?: boolean }
        }
        const accepted = parsed?.data?.accepted === true
        this.setConnected(accepted)
        if (accepted) {
          succeeded = true
          this.consecutiveFailures = 0
        } else {
          // Definite rejection (protocol mismatch / superseded): disconnect
          // and keep probing with backoff — the sidecar may recover.
          this.log("browser host hello rejected", { reason: parsed?.data })
          this.scheduleHelloRetry(attempt)
        }
      })
      .catch((error) => {
        this.handleHelloFailure(attempt, error)
      })
      .finally(() => {
        this.helloInFlight = false
        const kick = this.pendingKick
        this.pendingKick = false
        const failedAttempt = this.pendingRetryAttempt
        this.pendingRetryAttempt = undefined
        if (failedAttempt !== undefined) {
          // A higher retry was merged in while this hello was in flight; run
          // it instead of the retry the failure path may have scheduled.
          if (this.helloRetryTimer) {
            clearTimeout(this.helloRetryTimer)
            this.helloRetryTimer = null
          }
          this.scheduleHelloRetry(failedAttempt)
        } else if (kick && succeeded) {
          // One immediate idempotent re-register, only after a successful
          // settle — never a chain restart.
          this.registerHello(0, "manual")
        }
      })
  }

  private handleHelloFailure(attempt: number, error: unknown): void {
    if (error instanceof SidecarResponseError) {
      // The sidecar answered but rejected the request (auth/route/5xx): the
      // connection is not live. A definite failure — report it immediately.
      this.setConnected(false)
      this.logError("browser host hello failed", { attempt, error: String(error) })
    } else {
      // Transient failure (timeout/network). Never flap a healthy connection:
      // only after HELLO_DISCONNECT_AFTER consecutive failures is the sidecar
      // effectively gone. Log the first failure of a chain, then every third
      // attempt — not every attempt.
      this.consecutiveFailures += 1
      if (this.connected && this.consecutiveFailures >= HELLO_DISCONNECT_AFTER) {
        this.setConnected(false)
      }
      if (attempt === 0 || attempt % 3 === 0) {
        this.logError("browser host hello failed", { attempt, error: String(error) })
      }
    }
    this.scheduleHelloRetry(attempt)
  }

  private scheduleHelloRetry(attempt: number): void {
    if (this.stopping || this.server === null) return
    const backoff = this.options.helloBackoffMs ?? HELLO_BACKOFF_MS
    const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? backoff[0]!
    if (this.helloRetryTimer) clearTimeout(this.helloRetryTimer)
    this.helloRetryTimer = setTimeout(() => {
      this.helloRetryTimer = null
      this.registerHello(attempt + 1, "retry")
    }, delay)
    this.helloRetryTimer.unref?.()
  }

  private helloTimeoutMs(): number {
    if (this.options.helloTimeoutMs !== undefined) return this.options.helloTimeoutMs
    // Probe fast while the sidecar has never answered; give the heartbeat a
    // full round-trip budget once connected.
    return this.connected ? HELLO_TIMEOUT_MS : HELLO_PROBE_TIMEOUT_MS
  }

  private async postSidecar(
    sidecar: { url: string; username: string; password: string },
    path: string,
    body: unknown,
    timeoutMs: number = HELLO_TIMEOUT_MS,
  ): Promise<unknown> {
    const response = await fetch(`${sidecar.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${sidecar.username}:${sidecar.password}`).toString("base64")}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new SidecarResponseError(`sidecar ${path} responded ${response.status}`, response.status)
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

/** postSidecar's marker for a non-2xx response: the sidecar IS reachable but
 * refused the request — a definite failure, distinct from the timeout/network
 * transients that must not flap a healthy connection. */
class SidecarResponseError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "SidecarResponseError"
    this.status = status
  }
}

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
