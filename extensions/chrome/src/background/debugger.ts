// Debugger multiplex for chrome.debugger — typed errors + per-tab attach lifecycle.
// Mirrors desktop's control-session.ts semantics over the extension transport.

// Keep this file free of chrome.* globals at import time so it can be unit-tested with mocks.

export type DebuggerErrorTag = "BrowserDebuggerConflict" | "BrowserNotAttached" | "BrowserOperationFailed"

export class DebuggerError extends Error {
  readonly tag: DebuggerErrorTag
  readonly retryable: boolean
  constructor(tag: DebuggerErrorTag, message: string, retryable: boolean) {
    super(message)
    this.name = tag
    this.tag = tag
    this.retryable = retryable
  }
}

export class BrowserDebuggerConflictError extends DebuggerError {
  constructor(message = "The guest debugger is unavailable (DevTools open or debugger already attached)") {
    super("BrowserDebuggerConflict", message, false)
  }
}

export class BrowserNotAttachedError extends DebuggerError {
  constructor(message = "The browser tab is not attached via chrome.debugger") {
    super("BrowserNotAttached", message, true)
  }
}

// ---------------------------------------------------------------------------
// chrome.debugger surface (injectable for tests)

export interface ChromeDebugger {
  attach: (target: { tabId: number }, version: string, cb: () => void) => void
  detach: (target: { tabId: number }, cb: () => void) => void
  sendCommand: (
    target: { tabId: number } | { targetId: string; sessionId?: string },
    method: string,
    params: Record<string, unknown> | undefined,
    cb: (result?: unknown) => void,
  ) => void
  getTargets: (cb: (targets: Array<{ tabId: number; attached: boolean }>) => void) => void
  onEvent: {
    addListener: (cb: (source: { tabId: number; sessionId?: string }, method: string, params?: unknown) => void) => void
    removeListener: (cb: (...args: unknown[]) => void) => void
  }
  onDetach: {
    addListener: (cb: (source: { tabId: number }, reason: string) => void) => void
    removeListener: (cb: (...args: unknown[]) => void) => void
  }
}

// Runtime lastError indirection — Chrome sets chrome.runtime.lastError synchronously
// inside the callback turn.
export interface ChromeRuntime {
  get lastError(): { message: string } | undefined
}

// ---------------------------------------------------------------------------

export interface DebuggerOptions {
  debuggerApi: ChromeDebugger
  runtime: ChromeRuntime
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

interface AttachedTab {
  tabId: number
  // childTargets: Target.attachedToTarget sessionIds for oop-iframes (flatten:true)
  childSessions: Map<string, { targetId: string; type: string }>
}

export class DebuggerManager {
  private readonly attached = new Map<number, AttachedTab>()
  private readonly opts: DebuggerOptions

  constructor(opts: DebuggerOptions) {
    this.opts = opts
    // Wire global listeners once
    this.opts.debuggerApi.onEvent.addListener(this.handleDebuggerEvent)
    this.opts.debuggerApi.onDetach.addListener(this.handleDebuggerDetach)
  }

  dispose(): void {
    this.opts.debuggerApi.onEvent.removeListener(this.handleDebuggerEvent)
    this.opts.debuggerApi.onDetach.removeListener(this.handleDebuggerDetach)
  }

  getAttachedTabIds(): number[] {
    return [...this.attached.keys()]
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId)
  }

  getChildSessions(tabId: number): Map<string, { targetId: string; type: string }> | undefined {
    return this.attached.get(tabId)?.childSessions
  }

  // ---- attach / detach ----------------------------------------------------

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return
    await new Promise<void>((resolve, reject) => {
      this.opts.debuggerApi.attach({ tabId }, "1.3", () => {
        const err = this.opts.runtime.lastError
        if (err) {
          // Chrome sets lastError.message like "Another debugger is already attached to the tab"
          const msg = err.message ?? "unknown debugger error"
          if (/another debugger/i.test(msg) || /already attached/i.test(msg)) {
            reject(new BrowserDebuggerConflictError(msg))
          } else if (/no tab with id/i.test(msg)) {
            reject(new BrowserNotAttachedError(`No tab with id ${tabId}: ${msg}`))
          } else {
            reject(new DebuggerError("BrowserOperationFailed", msg, true))
          }
          return
        }
        this.attached.set(tabId, { tabId, childSessions: new Map() })
        this.opts.log?.("debugger attached", { tabId })
        resolve()
      })
    })

    // Enable flattened auto-attach for oop-iframes — else child frames are unreachable
    // Do NOT fail attach if this errors (non-fatal).
    try {
      await this.sendCommand(tabId, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }],
      })
    } catch (e) {
      this.opts.log?.("Target.setAutoAttach failed (non-fatal)", { tabId, error: String(e) })
    }
  }

  async detach(tabId: number): Promise<void> {
    const entry = this.attached.get(tabId)
    if (!entry) return
    // Clear locally before chrome call so onDetach is idempotent
    this.attached.delete(tabId)
    await new Promise<void>((resolve) => {
      this.opts.debuggerApi.detach({ tabId }, () => {
        // Swallow lastError — tab may already be closed
        void this.opts.runtime.lastError
        this.opts.log?.("debugger detached", { tabId })
        resolve()
      })
    })
  }

  async detachAll(): Promise<void> {
    const ids = [...this.attached.keys()]
    await Promise.all(ids.map((id) => this.detach(id)))
  }

  // ---- sendCommand multiplex ----------------------------------------------

  async sendCommand(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    opts?: { sessionId?: string },
  ): Promise<unknown> {
    const attached = this.attached.get(tabId)
    if (!attached) throw new BrowserNotAttachedError()

    // For flattened child targets, caller passes opts.sessionId; we route via targetId+sessionId.
    // Otherwise route via tabId.
    const target: { tabId: number } | { targetId: string; sessionId?: string } = opts?.sessionId
      ? (() => {
          const entry = [...attached.childSessions.values()].find((v) => v.targetId) // placeholder: caller supplies sessionId directly
          // Chrome ext API: when flatten:true, sendCommand can still use {tabId} with sessionId param
          // Fallback: use {tabId} envelope + sessionId in sendCommand target
          // Actual extension behavior: chrome.debugger.sendCommand({tabId}, method, params) with flattened sessions auto-routed
          // We keep tabId routing and let Chrome demux; sessionId path is for Target.* drills.
          return { tabId }
        })()
      : { tabId }

    // If caller supplied a sessionId for a child, we need to use the Target-attached routing.
    // Extension API supports {targetId, sessionId} for detached targets; for attached tab's children
    // the tabId+sessionId form is correct per docs: chrome.debugger.sendCommand({tabId}, ...) auto-routes
    // when flatten:true, but explicit sessionId is more precise.
    const effectiveTarget: { tabId: number } | Record<string, unknown> = opts?.sessionId
      ? { tabId, sessionId: opts.sessionId }
      : target

    return await new Promise<unknown>((resolve, reject) => {
      // chrome.debugger.sendCommand tabId variant accepts sessionId as extra field via target object
      // Cast via any to avoid TS double-cast that breaks esbuild bundling
      ;(this.opts.debuggerApi.sendCommand as any)(effectiveTarget, method, params, (result: unknown) => {
        const err = this.opts.runtime.lastError
        if (err) {
          const msg = err.message ?? `CDP ${method} failed`
          if (/not attached/i.test(msg)) reject(new BrowserNotAttachedError(msg))
          else if (/another debugger/i.test(msg) || /already attached/i.test(msg))
            reject(new BrowserDebuggerConflictError(msg))
          else reject(new DebuggerError("BrowserOperationFailed", msg, true))
          return
        }
        resolve(result)
      })
    })
  }

  // ---- event handlers -----------------------------------------------------

  private handleDebuggerEvent = (
    source: { tabId: number; sessionId?: string },
    method: string,
    params?: unknown,
  ): void => {
    if (method === "Target.attachedToTarget") {
      const p = params as { sessionId: string; targetInfo: { targetId: string; type: string } } | undefined
      if (!p) return
      const entry = this.attached.get(source.tabId)
      if (!entry) return
      entry.childSessions.set(p.sessionId, { targetId: p.targetInfo.targetId, type: p.targetInfo.type })
      this.opts.log?.("Target.attachedToTarget", {
        tabId: source.tabId,
        sessionId: p.sessionId,
        targetId: p.targetInfo.targetId,
        type: p.targetInfo.type,
      })
    } else if (method === "Target.detachedFromTarget") {
      const p = params as { sessionId: string } | undefined
      if (!p) return
      this.attached.get(source.tabId)?.childSessions.delete(p.sessionId)
      this.opts.log?.("Target.detachedFromTarget", { tabId: source.tabId, sessionId: p.sessionId })
    }
    // Other events (Page.frameStartedLoading, etc.) are forwarded by sw.js via onEvent
  }

  private handleDebuggerDetach = (source: { tabId: number }, reason: string): void => {
    // reason ∈ {target_closed, canceled_by_user, ...} per docs
    this.attached.delete(source.tabId)
    this.opts.log?.("debugger onDetach", { tabId: source.tabId, reason })
  }
}
