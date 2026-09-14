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
}

export class DebuggerManager {
  private readonly attached = new Map<number, AttachedTab>()
  /** Coalesce concurrent operations racing to attach the same Chrome tab. */
  private readonly attaching = new Map<number, Promise<void>>()
  private readonly opts: DebuggerOptions

  constructor(opts: DebuggerOptions) {
    this.opts = opts
    // Only detach events are lifecycle-significant. Target auto-attach used to
    // wire every OOP iframe into this manager even though no extension-lane
    // operation consumes child sessions; that produced avoidable CDP events.
    this.opts.debuggerApi.onDetach.addListener(this.handleDebuggerDetach)
  }

  dispose(): void {
    this.opts.debuggerApi.onDetach.removeListener(this.handleDebuggerDetach)
  }

  getAttachedTabIds(): number[] {
    return [...this.attached.keys()]
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId)
  }

  // ---- attach / detach ----------------------------------------------------

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return
    const pending = this.attaching.get(tabId)
    if (pending) return pending

    const attach = new Promise<void>((resolve, reject) => {
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
        this.attached.set(tabId, { tabId })
        this.opts.log?.("debugger attached", { tabId })
        resolve()
      })
    })
    this.attaching.set(tabId, attach)
    try {
      await attach
    } finally {
      if (this.attaching.get(tabId) === attach) this.attaching.delete(tabId)
    }
  }

  async detach(tabId: number): Promise<void> {
    // A close/detach can race the first operation that is attaching. Waiting
    // here prevents a completed attach from resurrecting local debugger state.
    const pending = this.attaching.get(tabId)
    if (pending) await pending.catch(() => undefined)
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
    if (!this.attached.has(tabId)) throw new BrowserNotAttachedError()

    // Keep explicit session routing available for future callers without
    // maintaining a persistent Target.setAutoAttach event stream. Today all
    // production calls target the top-level tab.
    const effectiveTarget: { tabId: number } | Record<string, unknown> = opts?.sessionId
      ? { tabId, sessionId: opts.sessionId }
      : { tabId }

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

  private handleDebuggerDetach = (source: { tabId: number }, reason: string): void => {
    // reason ∈ {target_closed, canceled_by_user, ...} per docs
    this.attached.delete(source.tabId)
    this.opts.log?.("debugger onDetach", { tabId: source.tabId, reason })
  }
}
