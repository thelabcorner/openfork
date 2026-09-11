// extension-host.ts — desktop-side relay for the Chrome extension lane.
//
// Chrome owns Native Messaging process lifetime and stdio. Desktop therefore
// cannot "connect" to that pipe directly. Instead, the Chrome-launched native
// host maintains an authenticated loopback long-poll against BrowserHost and
// this class is the in-process queue/resolver on the Desktop side.
//
// Data path:
//   sidecar -> BrowserHost -> ExtensionBridge -> ExtensionHost.send(request)
//   -> BrowserHost /v1/browser/extension/poll -> Chrome native host
//   -> chrome.runtime Port -> service worker -> chrome.debugger
//   -> native host -> BrowserHost /v1/browser/extension/response
//   -> ExtensionHost.acceptResponse(response) -> original sidecar request

import type { BrokerRequest, BrokerResponse } from "../contracts"

export const NATIVE_MESSAGE_MAX_BYTES = 1 * 1024 * 1024
export const NATIVE_MESSAGE_HEADER_SIZE = 4
export const NATIVE_EXTENSION_POLL_MS = 20_000
export const NATIVE_EXTENSION_STALE_MS = 35_000

export function encodeNativeMessage(payload: unknown): Buffer {
  const json = JSON.stringify(payload)
  const body = Buffer.from(json, "utf8")
  if (body.length > NATIVE_MESSAGE_MAX_BYTES) {
    throw new Error(`Native message exceeds ${NATIVE_MESSAGE_MAX_BYTES} bytes (${body.length}) — use HTTP broker path for screenshots`)
  }
  const header = Buffer.alloc(NATIVE_MESSAGE_HEADER_SIZE)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

export function decodeNativeFrames(buffer: Buffer): { messages: unknown[]; remainder: Buffer } {
  const messages: unknown[] = []
  let offset = 0
  while (buffer.length - offset >= NATIVE_MESSAGE_HEADER_SIZE) {
    const length = buffer.readUInt32LE(offset)
    if (length > NATIVE_MESSAGE_MAX_BYTES * 64) throw new Error(`Native message length ${length} exceeds sanity cap`)
    if (buffer.length - offset - NATIVE_MESSAGE_HEADER_SIZE < length) break
    const body = buffer.subarray(offset + NATIVE_MESSAGE_HEADER_SIZE, offset + NATIVE_MESSAGE_HEADER_SIZE + length)
    const text = body.toString("utf8")
    try {
      messages.push(text ? (JSON.parse(text) as unknown) : null)
    } catch (error) {
      throw new Error(`Native message JSON parse failed: ${(error as Error).message}`)
    }
    offset += NATIVE_MESSAGE_HEADER_SIZE + length
  }
  return { messages, remainder: buffer.subarray(offset) }
}

export type ExtensionRelayMessage =
  | { type: "request"; request: BrokerRequest }
  | { type: "abort"; requestId: string }

// Compatibility type retained for the extension-bridge barrel. Desktop no
// longer dispatches Chrome operations locally, but downstream imports should
// not break while the carrier is migrated.
export type DispatchFn = (
  tabId: string | undefined,
  operation: BrokerRequest["operation"],
  sessionId: string,
) => Promise<Record<string, unknown>>

export interface ExtensionHostOptions {
  staleAfterMs?: number
  onConnectedChange?: (connected: boolean) => void
  logger?: { log: (message: string, meta?: unknown) => void; error: (message: string, meta?: unknown) => void }
}

interface PendingRequest {
  request: BrokerRequest
  timer: ReturnType<typeof setTimeout>
  startedAt: number
  resolve: (response: BrokerResponse) => void
}

interface PollWaiter {
  timer: ReturnType<typeof setTimeout>
  resolve: (message: ExtensionRelayMessage | null) => void
}

export class ExtensionHost {
  private readonly options: ExtensionHostOptions
  private readonly pending = new Map<string, PendingRequest>()
  private readonly queue: ExtensionRelayMessage[] = []
  private readonly pollWaiters: PollWaiter[] = []
  private staleTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private connected = false

  constructor(options: ExtensionHostOptions = {}) {
    this.options = options
  }

  get isConnected(): boolean {
    return this.running && this.connected
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get queuedCount(): number {
    return this.queue.length
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.log("extension relay ready")
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.setConnected(false)
    if (this.staleTimer) clearTimeout(this.staleTimer)
    this.staleTimer = null

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve(hostUnavailable(entry.request.requestId, Date.now() - entry.startedAt, "Extension relay stopping"))
    }
    this.pending.clear()
    this.queue.length = 0

    for (const waiter of this.pollWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
  }

  /** Native-host hello/poll heartbeat. BrowserHost calls this on authenticated relay traffic. */
  markConnected(meta?: Record<string, unknown>): void {
    if (!this.running) return
    this.setConnected(true)
    this.armStaleTimer()
    if (meta) this.log("extension relay heartbeat", meta)
  }

  markDisconnected(reason = "native host disconnected"): void {
    if (!this.running) return
    this.setConnected(false)
    if (this.staleTimer) clearTimeout(this.staleTimer)
    this.staleTimer = null
    this.failPending(reason)
    this.queue.length = 0
    this.log("extension relay disconnected", { reason })
  }

  /**
   * Called by BrowserHost's long-poll endpoint. A waiting poll is also the
   * liveness heartbeat, so an idle Chrome connection stays healthy without a
   * separate timer protocol.
   */
  nextMessage(waitMs = NATIVE_EXTENSION_POLL_MS): Promise<ExtensionRelayMessage | null> {
    if (!this.running) return Promise.resolve(null)
    this.markConnected()
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)

    const bounded = Math.max(100, Math.min(waitMs, NATIVE_EXTENSION_POLL_MS + 5_000))
    return new Promise((resolve) => {
      const waiter: PollWaiter = {
        timer: setTimeout(() => {
          const index = this.pollWaiters.indexOf(waiter)
          if (index >= 0) this.pollWaiters.splice(index, 1)
          resolve(null)
        }, bounded),
        resolve,
      }
      waiter.timer.unref?.()
      this.pollWaiters.push(waiter)
    })
  }

  send(request: BrokerRequest): Promise<BrokerResponse> {
    if (!this.running || !this.connected) {
      return Promise.resolve(hostUnavailable(request.requestId, 0, "Chrome extension native host is not connected"))
    }

    const startedAt = Date.now()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(request.requestId)
        if (!entry) return
        this.pending.delete(request.requestId)
        resolve({
          ok: false,
          requestId: request.requestId,
          elapsedMs: Date.now() - startedAt,
          error: { tag: "BrowserTimeout", message: `Extension request ${request.requestId} exceeded ${request.timeoutMs}ms`, retryable: true },
        })
      }, Math.max(1, request.timeoutMs))
      timer.unref?.()
      this.pending.set(request.requestId, { request, timer, startedAt, resolve })
      this.enqueue({ type: "request", request })
    })
  }

  /** Resolve one Desktop -> extension request from the native-host response POST. */
  acceptResponse(response: BrokerResponse): boolean {
    this.markConnected()
    const entry = this.pending.get(response.requestId)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(response.requestId)
    entry.resolve({ ...response, elapsedMs: Date.now() - entry.startedAt })
    return true
  }

  abort(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(requestId)
      entry.resolve({
        ok: false,
        requestId,
        elapsedMs: Date.now() - entry.startedAt,
        error: { tag: "BrowserControlInterrupted", message: "Extension request aborted by caller", retryable: true },
      })
    }
    if (this.connected) this.enqueue({ type: "abort", requestId })
  }

  private enqueue(message: ExtensionRelayMessage): void {
    const waiter = this.pollWaiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(message)
      return
    }
    this.queue.push(message)
  }

  private armStaleTimer(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer)
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null
      this.setConnected(false)
      this.failPending("Extension relay heartbeat expired")
      this.queue.length = 0
      this.log("extension relay heartbeat expired")
    }, this.options.staleAfterMs ?? NATIVE_EXTENSION_STALE_MS)
    this.staleTimer.unref?.()
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    this.options.onConnectedChange?.(connected)
    this.log("extension relay connection changed", { connected })
  }

  private failPending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve(hostUnavailable(entry.request.requestId, Date.now() - entry.startedAt, reason))
    }
    this.pending.clear()
  }

  private log(message: string, meta?: unknown): void {
    this.options.logger?.log(message, meta)
  }
}

function hostUnavailable(requestId: string, elapsedMs: number, message: string): BrokerResponse {
  return {
    ok: false,
    requestId,
    elapsedMs,
    error: { tag: "BrowserHostUnavailable", message, retryable: true },
  }
}
