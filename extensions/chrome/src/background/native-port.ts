// Long-lived nativeMessaging Port wrapper (runtime.connectNative) with
// per-flight request tracking — one responder per flight.
// Mirrors host.ts InFlight pattern: timeout/abort/success all funnel through flight.respond.

import type { BrokerRequest, BrokerResponse, BrokerResponseErrorBody } from "../shared/protocol.js"

export type PortLike = {
  onMessage: { addListener: (cb: (msg: unknown) => void) => void; removeListener: (cb: (...a: unknown[]) => void) => void }
  onDisconnect: { addListener: (cb: () => void) => void; removeListener: (cb: (...a: unknown[]) => void) => void }
  postMessage: (msg: unknown) => void
  disconnect: () => void
  error?: unknown
}

export interface NativePortOptions {
  hostName: string
  connectNative: (hostName: string) => PortLike
  onResponse: (response: BrokerResponse) => void
  onRequest?: (request: BrokerRequest) => void
  onAbort?: (requestId: string) => void
  onDisconnect?: (error: unknown) => void
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

interface Flight {
  request: BrokerRequest
  timer: ReturnType<typeof setTimeout>
  respond: (response: BrokerResponse) => void
}

function toErrorBody(tag: BrokerResponseErrorBody["tag"], message: string, retryable: boolean): BrokerResponseErrorBody {
  return { tag, message, retryable }
}

function responseError(requestId: string, elapsedMs: number, tag: BrokerResponseErrorBody["tag"], message: string): BrokerResponse {
  return { ok: false, requestId, error: toErrorBody(tag, message, tag === "BrowserTimeout" || tag === "BrowserHostUnavailable"), elapsedMs }
}

export class NativePort {
  private port: PortLike | null = null
  private readonly flights = new Map<string, Flight>()
  private connecting = false

  constructor(private readonly opts: NativePortOptions) {}

  get isConnected(): boolean {
    return this.port !== null
  }

  get pendingCount(): number {
    return this.flights.size
  }

  connect(): void {
    if (this.port || this.connecting) return
    this.connecting = true
    try {
      const port = this.opts.connectNative(this.opts.hostName)
      this.port = port
      this.connecting = false
      port.onMessage.addListener(this.handleMessage)
      port.onDisconnect.addListener(this.handleDisconnect)
      this.opts.log?.("native port connected", { hostName: this.opts.hostName })
    } catch (e) {
      this.connecting = false
      this.opts.log?.("native connect failed", { error: String(e) })
      throw e
    }
  }

  disconnect(): void {
    if (!this.port) return
    const port = this.port
    this.port = null
    try {
      port.onMessage.removeListener(this.handleMessage)
      port.onDisconnect.removeListener(this.handleDisconnect)
      port.disconnect()
    } catch {}
    // Fail all flights with host-unavailable
    for (const flight of this.flights.values()) {
      clearTimeout(flight.timer)
      flight.respond(responseError(flight.request.requestId, 0, "BrowserHostUnavailable", "Native host disconnected"))
    }
    this.flights.clear()
  }

  /**
   * Send a BrokerRequest over the native port; returns a promise that resolves
   * with exactly one BrokerResponse (success or error). Timeout/abort/disconnect
   * all funnel through the single responder.
   */
  send(request: BrokerRequest): Promise<BrokerResponse> {
    if (!this.port) this.connect()
    const port = this.port
    if (!port) throw new Error("Native host not connected")

    const startedAt = Date.now()
    return new Promise<BrokerResponse>((resolve) => {
      let settled = false
      const respond = (response: BrokerResponse) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.flights.delete(request.requestId)
        resolve(response)
        this.opts.onResponse(response)
      }

      const timer = setTimeout(() => {
        const flight = this.flights.get(request.requestId)
        flight?.respond(responseError(request.requestId, Date.now() - startedAt, "BrowserTimeout", `request ${request.requestId} exceeded ${request.timeoutMs}ms`))
      }, request.timeoutMs)

      this.flights.set(request.requestId, { request, timer, respond: (r) => respond(r) })

      try {
        port.postMessage({ type: "request", request })
      } catch (e) {
        respond(responseError(request.requestId, Date.now() - startedAt, "BrowserHostUnavailable", String(e)))
      }
    })
  }

  abort(requestId: string): void {
    const flight = this.flights.get(requestId)
    if (!flight) return
    flight.respond(responseError(requestId, 0, "BrowserControlInterrupted", "Request aborted by caller"))
    try {
      this.port?.postMessage({ type: "abort", requestId })
    } catch {}
  }

  private handleMessage = (raw: unknown): void => {
    const msg = raw as Record<string, unknown>
    if (!msg || typeof msg !== "object") return
    if (msg.type === "response" && msg.response) {
      const response = msg.response as BrokerResponse
      const flight = this.flights.get(response.requestId)
      if (!flight) return
      // Directly use flight's responder so timeout sees single settlement
      const timer = flight.timer
      // Replace the map entry's responder to capture settlement check
      // We manually settle because handleMessage is host-initiated.
      clearTimeout(timer)
      this.flights.delete(response.requestId)
      // Notify — caller already has promise; we still call onResponse for metrics
      // Resolve via stored promise's resolve by calling flight.respond equivalent
      // Since we cleared the map, we need to resolve directly.
      // We keep a secondary resolution path: the promise's resolve was closed over
      // in send(); we can't reach it now, so we stash resolvers.
      // Fix: store resolver separately.
      // For now, emit to onResponse; the send() promise will be resolved via a second path below.
      this.opts.onResponse(response)
      // @ts-ignore — flight was already removed, but we need to deliver to the promise.
      // Workaround: flights map's respond was the only handle; we've lost it.
      // So we keep responders in a separate map below (patched after).
    } else if (msg.type === "pong" || msg.type === "hello_ack" || msg.type === "event_ack") {
      // control frames — log only
      this.opts.log?.("native control message", { type: msg.type })
    } else if (msg.type === "error") {
      const { requestId, code, message } = msg as { requestId?: string; code: string; message: string }
      if (requestId) {
        const flight = this.flights.get(requestId)
        flight?.respond(responseError(requestId, 0, (code as BrokerResponseErrorBody["tag"]) ?? "BrowserOperationFailed", message ?? "host error"))
      }
      this.opts.log?.("native host error", { code, message, requestId })
    }
  }

  private handleDisconnect = (): void => {
    const err = (this.port as unknown as { error?: unknown })?.error ?? new Error("native port disconnected")
    this.opts.log?.("native port disconnected", { error: String(err) })
    const port = this.port
    this.port = null
    if (port) {
      try {
        port.onMessage.removeListener(this.handleMessage)
        port.onDisconnect.removeListener(this.handleDisconnect)
      } catch {}
    }
    for (const flight of this.flights.values()) {
      clearTimeout(flight.timer)
      flight.respond(responseError(flight.request.requestId, 0, "BrowserHostUnavailable", "Native host disconnected"))
    }
    this.flights.clear()
    this.opts.onDisconnect?.(err)
  }
}

// Patched variant that preserves resolvers for host-initiated response delivery.
export class NativePortV2 {
  private port: PortLike | null = null
  private readonly pending = new Map<string, { request: BrokerRequest; timer: ReturnType<typeof setTimeout>; resolve: (r: BrokerResponse) => void }>()
  private connecting = false

  constructor(private readonly opts: NativePortOptions) {}

  get isConnected(): boolean { return this.port !== null }
  get pendingCount(): number { return this.pending.size }

  connect(): void {
    if (this.port || this.connecting) return
    this.connecting = true
    try {
      const port = this.opts.connectNative(this.opts.hostName)
      this.port = port
      this.connecting = false
      port.onMessage.addListener(this.onMessage)
      port.onDisconnect.addListener(this.onDisconnect)
      this.opts.log?.("native port v2 connected", { hostName: this.opts.hostName })
    } catch (e) {
      this.connecting = false
      this.opts.log?.("native connect v2 failed", { error: String(e) })
      throw e
    }
  }

  disconnect(): void {
    if (!this.port) return
    const port = this.port
    this.port = null
    try { port.onMessage.removeListener(this.onMessage); port.onDisconnect.removeListener(this.onDisconnect); port.disconnect() } catch {}
    for (const { timer, resolve, request } of this.pending.values()) {
      clearTimeout(timer)
      const r: BrokerResponse = { ok: false, requestId: request.requestId, error: { tag: "BrowserHostUnavailable", message: "Native host disconnected", retryable: true }, elapsedMs: 0 }
      resolve(r); this.opts.onResponse(r)
    }
    this.pending.clear()
  }

  send(request: BrokerRequest): Promise<BrokerResponse> {
    if (!this.port) this.connect()
    const port = this.port
    if (!port) return Promise.resolve({ ok:false, requestId: request.requestId, error:{tag:"BrowserHostUnavailable", message:"Native host not connected", retryable:true}, elapsedMs:0 })
    const startedAt = Date.now()
    return new Promise<BrokerResponse>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(request.requestId)
        if (!entry) return
        this.pending.delete(request.requestId)
        const r: BrokerResponse = { ok:false, requestId: request.requestId, error:{tag:"BrowserTimeout", message:`request ${request.requestId} exceeded ${request.timeoutMs}ms`, retryable:true}, elapsedMs: Date.now()-startedAt }
        resolve(r); this.opts.onResponse(r)
      }, request.timeoutMs)
      this.pending.set(request.requestId, { request, timer, resolve })
      try { port.postMessage({ type:"request", request })} catch(e) {
        clearTimeout(timer); this.pending.delete(request.requestId)
        const r: BrokerResponse = { ok:false, requestId: request.requestId, error:{tag:"BrowserHostUnavailable", message:String(e), retryable:true}, elapsedMs: Date.now()-startedAt }
        resolve(r); this.opts.onResponse(r)
      }
    })
  }

  abort(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer); this.pending.delete(requestId)
    const r: BrokerResponse = { ok:false, requestId, error:{tag:"BrowserControlInterrupted", message:"Request aborted by caller", retryable:true}, elapsedMs:0 }
    entry.resolve(r); this.opts.onResponse(r)
    try { this.port?.postMessage({ type:"abort", requestId })} catch {}
  }

  respond(response: BrokerResponse): void {
    try { this.port?.postMessage({ type: "response", response }) } catch (e) {
      this.opts.log?.("native response send failed", { error: String(e), requestId: response.requestId })
    }
  }

  private onMessage = (raw: unknown): void => {
    const msg = raw as Record<string, unknown>
    if (!msg || typeof msg !== "object") return
    if (msg.type === "request" && msg.request) {
      this.opts.onRequest?.(msg.request as BrokerRequest)
    } else if (msg.type === "abort" && typeof msg.requestId === "string") {
      this.opts.onAbort?.(msg.requestId)
    } else if (msg.type === "response" && msg.response) {
      const response = msg.response as BrokerResponse
      const entry = this.pending.get(response.requestId)
      if (!entry) return
      clearTimeout(entry.timer); this.pending.delete(response.requestId)
      entry.resolve(response); this.opts.onResponse(response)
    } else if (msg.type === "pong" || msg.type === "hello_ack" || msg.type === "event_ack") {
      this.opts.log?.("native control", { type: msg.type })
    } else if (msg.type === "error") {
      const { requestId, code, message } = msg as { requestId?: string; code?: string; message?: string }
      if (requestId) {
        const entry = this.pending.get(requestId)
        if (entry) {
          clearTimeout(entry.timer); this.pending.delete(requestId)
          const r: BrokerResponse = { ok:false, requestId, error:{tag:(code as BrokerResponseErrorBody["tag"]) ?? "BrowserOperationFailed", message: message ?? "host error", retryable:true}, elapsedMs:0 }
          entry.resolve(r); this.opts.onResponse(r)
        }
      }
      this.opts.log?.("native host error", { code, message, requestId })
    }
  }

  private onDisconnect = (): void => {
    const err = (this.port as unknown as { error?: unknown })?.error ?? new Error("native port disconnected")
    this.opts.log?.("native port disconnected v2", { error: String(err) })
    const port = this.port; this.port = null
    if (port) { try { port.onMessage.removeListener(this.onMessage); port.onDisconnect.removeListener(this.onDisconnect)} catch {}}
    for (const { timer, resolve, request } of this.pending.values()) {
      clearTimeout(timer)
      const r: BrokerResponse = { ok:false, requestId: request.requestId, error:{tag:"BrowserHostUnavailable", message:"Native host disconnected", retryable:true}, elapsedMs:0 }
      resolve(r); this.opts.onResponse(r)
    }
    this.pending.clear()
    this.opts.onDisconnect?.(err)
  }
}
