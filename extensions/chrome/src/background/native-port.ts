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
  /** Optional metrics/diagnostic tap. Normal host->extension traffic does not need one. */
  onResponse?: (response: BrokerResponse) => void
  onRequest?: (request: BrokerRequest) => void
  onAbort?: (requestId: string) => void
  onDisconnect?: (error: unknown) => void
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

// Duplex native-messaging transport.
export class NativePortV2 {
  private port: PortLike | null = null
  private readonly pending = new Map<string, { request: BrokerRequest; timer: ReturnType<typeof setTimeout>; resolve: (r: BrokerResponse) => void }>()
  private readonly pendingArtifact = new Map<string, { timer: ReturnType<typeof setTimeout>; resolve: (r: unknown) => void }>()
  private connecting = false

  constructor(private readonly opts: NativePortOptions) {}

  get isConnected(): boolean { return this.port !== null }
  get pendingCount(): number { return this.pending.size }
  get pendingArtifactCount(): number { return this.pendingArtifact.size }

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
    this.failPending("Native host disconnected")
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
        resolve(r); this.opts.onResponse?.(r)
      }, request.timeoutMs)
      this.pending.set(request.requestId, { request, timer, resolve })
      try { port.postMessage({ type:"request", request })} catch(e) {
        clearTimeout(timer); this.pending.delete(request.requestId)
        const r: BrokerResponse = { ok:false, requestId: request.requestId, error:{tag:"BrowserHostUnavailable", message:String(e), retryable:true}, elapsedMs: Date.now()-startedAt }
        resolve(r); this.opts.onResponse?.(r)
      }
    })
  }

  abort(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer); this.pending.delete(requestId)
    const r: BrokerResponse = { ok:false, requestId, error:{tag:"BrowserControlInterrupted", message:"Request aborted by caller", retryable:true}, elapsedMs:0 }
    entry.resolve(r); this.opts.onResponse?.(r)
    try { this.port?.postMessage({ type:"abort", requestId })} catch {}
  }

  /** Visual artifact traffic is correlated separately from BrowserRequest. */
  artifactRpc(request: { id: string }, timeoutMs = 30_000): Promise<unknown> {
    if (!request?.id) return Promise.reject(new Error("visual artifact RPC requires an id"))
    if (!this.port) this.connect()
    const port = this.port
    if (!port) return Promise.reject(new Error("Native host not connected"))
    if (this.pendingArtifact.has(request.id)) return Promise.reject(new Error(`duplicate visual artifact RPC id ${request.id}`))
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pendingArtifact.get(request.id)
        if (!entry) return
        this.pendingArtifact.delete(request.id)
        resolve({ ok: false, id: request.id, error: { code: "VISUAL_TIMEOUT", message: `Visual artifact RPC ${request.id} timed out` } })
      }, Math.max(1, timeoutMs))
      this.pendingArtifact.set(request.id, { timer, resolve })
      try {
        port.postMessage({ type: "artifact_rpc", request })
      } catch (error) {
        clearTimeout(timer)
        this.pendingArtifact.delete(request.id)
        resolve({ ok: false, id: request.id, error: { code: "VISUAL_HOST_UNAVAILABLE", message: String(error) } })
      }
    })
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
      entry.resolve(response); this.opts.onResponse?.(response)
    } else if (msg.type === "artifact_rpc_result" && msg.response) {
      const response = msg.response as { id?: unknown }
      if (typeof response.id !== "string") return
      const entry = this.pendingArtifact.get(response.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pendingArtifact.delete(response.id)
      entry.resolve(msg.response)
    } else if (msg.type === "pong" || msg.type === "hello_ack" || msg.type === "event_ack") {
      this.opts.log?.("native control", { type: msg.type })
    } else if (msg.type === "error") {
      const { requestId, code, message } = msg as { requestId?: string; code?: string; message?: string }
      if (requestId) {
        const entry = this.pending.get(requestId)
        if (entry) {
          clearTimeout(entry.timer); this.pending.delete(requestId)
          const r: BrokerResponse = { ok:false, requestId, error:{tag:(code as BrokerResponseErrorBody["tag"]) ?? "BrowserOperationFailed", message: message ?? "host error", retryable:true}, elapsedMs:0 }
          entry.resolve(r); this.opts.onResponse?.(r)
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
    this.failPending("Native host disconnected")
    this.opts.onDisconnect?.(err)
  }

  private failPending(message: string): void {
    for (const { timer, resolve, request } of this.pending.values()) {
      clearTimeout(timer)
      const response: BrokerResponse = {
        ok: false,
        requestId: request.requestId,
        error: { tag: "BrowserHostUnavailable", message, retryable: true },
        elapsedMs: 0,
      }
      resolve(response)
      this.opts.onResponse?.(response)
    }
    this.pending.clear()
    for (const [id, { timer, resolve }] of this.pendingArtifact) {
      clearTimeout(timer)
      resolve({ ok: false, id, error: { code: "VISUAL_HOST_UNAVAILABLE", message } })
    }
    this.pendingArtifact.clear()
  }
}
