import { BrowserDebuggerConflictError, BrowserNotAttachedError } from "./errors"
import { ControlArbiter, ControlEpoch, createEpochGuardedSender, type DebuggerCommand } from "./arbitration"
import { DIAGNOSTIC_BUFFER_LIMIT } from "./types"

// One CDP control session per guest webContents. Serializes agent actions with
// a one-permit semaphore, attaches `wc.debugger` on protocol 1.3 and enables
// the domains the operations layer needs (Runtime, Accessibility, Network,
// Log), buffers diagnostics, and detaches/re-attaches cleanly around DevTools.
//
// ControlSessionManager is the facade the operations layer consumes: it owns
// the per-webContents ControlSessions, the pointer sequence counter, and the
// screencast frame fan-out.

export type DiagnosticKind = "console" | "exception" | "log" | "network"

export type DiagnosticEntry = {
  kind: DiagnosticKind
  at: number
  detail: string
}

type DebuggerLike = {
  attach(protocolVersion: string): void
  isAttached(): boolean
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: "message", listener: (event: unknown, method: string, params: Record<string, unknown>) => void): void
  removeListener(event: "message", listener: (event: unknown, method: string, params: Record<string, unknown>) => void): void
}

export type WebContentsLike = {
  id: number
  debugger: DebuggerLike
  isDestroyed(): boolean
  isDevToolsOpened(): boolean
}

export type ControlSession = {
  tabId: string
  diagnostics: readonly DiagnosticEntry[]
  isAttached(): boolean
  ensureAttached(): Promise<void>
  detachForDevTools(): void
  reattach(): Promise<void>
  withPermit<T>(fn: (session: SessionHandle) => Promise<T>, waitMs?: number): Promise<T>
  onDebuggerMessage(listener: (method: string, params: Record<string, unknown>) => void): () => void
}

export type SessionHandle = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  sendCleanup: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

/** Two-arg send used by the operations layer inside withSession. */
export type SendCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>

type ControlSessionOptions = {
  webContents: WebContentsLike
  tabId: string
  epoch: ControlEpoch
  colorScheme: () => "light" | "dark"
}

// One-permit semaphore. Acquire returns a release function; a second acquire
// waits for the first to release (or times out).
class Permit {
  private held = false
  private waiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = []

  async acquire(waitMs: number) {
    if (!this.held) {
      this.held = true
      return () => this.release()
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(
          this.waiters.findIndex((w) => w.resolve === resolve),
          1,
        )
        reject(new Error("Timed out waiting for browser control permit"))
      }, waitMs)
      this.waiters.push({ resolve, timer })
    })
    this.held = true
    return () => this.release()
  }

  private release() {
    this.held = false
    const next = this.waiters.shift()
    if (!next) return
    clearTimeout(next.timer)
    next.resolve()
  }
}

function serializeDiagnostic(params: Record<string, unknown>): string {
  try {
    const value = JSON.stringify(params)
    return value.length > 500 ? `${value.slice(0, 500)}…` : value
  } catch {
    return String(params)
  }
}

export function createControlSession(options: ControlSessionOptions): ControlSession {
  const { webContents: wc, tabId, epoch, colorScheme } = options
  const permit = new Permit()
  let attached = false
  let command: DebuggerCommand | undefined
  let diagnostics: DiagnosticEntry[] = []
  const messageListeners = new Set<(method: string, params: Record<string, unknown>) => void>()

  const onDebuggerMessage = (event: unknown, method: string, params: Record<string, unknown>) => {
    void event
    for (const listener of messageListeners) listener(method, params)
  }

  const record = (kind: DiagnosticKind, detail: string) => {
    diagnostics.push({ kind, at: Date.now(), detail })
    if (diagnostics.length > DIAGNOSTIC_BUFFER_LIMIT) diagnostics = diagnostics.slice(-DIAGNOSTIC_BUFFER_LIMIT)
  }

  const wireDiagnostics = () => {
    wc.debugger.on("message", onDebuggerMessage)
  }

  const unwireDiagnostics = () => {
    wc.debugger.removeListener("message", onDebuggerMessage)
  }

  const applyAppearance = async () => {
    await command?.(`Emulation.setEmulatedMedia`, {
      features: [{ name: "prefers-color-scheme", value: colorScheme() }],
    })
  }

  const ensureAttached = async () => {
    if (wc.isDestroyed()) throw new BrowserNotAttachedError()
    if (wc.isDevToolsOpened()) throw new BrowserDebuggerConflictError()
    if (wc.debugger.isAttached()) {
      if (attached) return
      throw new BrowserDebuggerConflictError("The guest debugger is already attached by another client")
    }
    try {
      wc.debugger.attach("1.3")
    } catch (error) {
      throw new BrowserDebuggerConflictError(`Failed to attach guest debugger: ${(error as Error).message}`)
    }
    attached = true
    wireDiagnostics()
    const send = async (method: string, params?: Record<string, unknown>) => wc.debugger.sendCommand(method, params)
    command = send
    const domains = ["Runtime", "Accessibility", "Network", "Log"]
    for (const domain of domains) {
      await send(`${domain}.enable`).catch((error: Error) => {
        throw new BrowserDebuggerConflictError(`Failed to enable ${domain}: ${error.message}`)
      })
    }
    await send("Input.setIgnoreInputEvents", { ignore: false }).catch(() => undefined)
    await applyAppearance()
  }

  const guarded = createEpochGuardedSender(epoch, (method, params) => {
    if (!command) throw new BrowserNotAttachedError()
    return command(method, params)
  })
  // Bind the session's tabId so the operations layer calls send(method, params).
  const send = (method: string, params?: Record<string, unknown>) => guarded.send(tabId, method, params)
  const sendCleanup = (method: string, params?: Record<string, unknown>) => guarded.sendCleanup(tabId, method, params)

  return {
    tabId,
    get diagnostics() {
      return diagnostics
    },
    isAttached: () => attached,
    ensureAttached,
    detachForDevTools: () => {
      if (!attached) return
      unwireDiagnostics()
      try {
        wc.debugger.detach()
      } catch {
        // already detached by DevTools taking over
      }
      attached = false
      command = undefined
    },
    reattach: () => ensureAttached(),
    async withPermit(fn, waitMs = 15_000) {
      const release = await permit.acquire(waitMs)
      try {
        await ensureAttached()
        return await fn({ send, sendCleanup })
      } finally {
        release()
      }
    },
    onDebuggerMessage(listener) {
      messageListeners.add(listener)
      return () => messageListeners.delete(listener)
    },
  }
}

// --- manager facade ----------------------------------------------------------

export interface ControlSessionManagerOptions {
  arbiter: ControlArbiter
  colorScheme?: () => "light" | "dark"
}

/**
 * Owns one ControlSession per webContents id, a per-tab pointer sequence, and
 * the screencast frame fan-out. The operations layer consumes only this facade.
 */
export class ControlSessionManager {
  private readonly sessions = new Map<number, ControlSession>()
  private readonly epoch: ControlEpoch
  private readonly colorScheme: () => "light" | "dark"
  private pointerSequence = 0
  private readonly screencastListeners = new Set<(params: Record<string, unknown>) => void>()
  private readonly wired = new Set<number>()

  constructor(options: ControlSessionManagerOptions) {
    this.epoch = options.arbiter.getEpoch()
    this.colorScheme = options.colorScheme ?? (() => "light")
  }

  /** Acquire the permit for a tab's session and run fn with a bound send. */
  async withSession<T>(
    tabId: string,
    wc: WebContentsLike,
    _operation: string,
    fn: (send: SendCommand, sendCleanup: SendCommand) => Promise<T>,
    waitMs?: number,
  ): Promise<T> {
    const session = this.obtain(tabId, wc)
    return session.withPermit(async (handle) => fn(handle.send, handle.sendCleanup), waitMs)
  }

  detach(webContentsId: number): Promise<void> {
    const session = this.sessions.get(webContentsId)
    if (!session) return Promise.resolve()
    session.detachForDevTools()
    this.sessions.delete(webContentsId)
    this.wired.delete(webContentsId)
    return Promise.resolve()
  }

  async detachAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.detach(id)
  }

  nextPointerSequence(): number {
    this.pointerSequence += 1
    return this.pointerSequence
  }

  /** Subscribe to Page.screencastFrame params across every live session. */
  onScreencastFrame(cb: (params: Record<string, unknown>) => void): () => void {
    this.screencastListeners.add(cb)
    return () => this.screencastListeners.delete(cb)
  }

  private obtain(tabId: string, wc: WebContentsLike): ControlSession {
    const existing = this.sessions.get(wc.id)
    if (existing) {
      if (existing.tabId !== tabId) {
        // Same webContents re-bound to a new tab after a crash remount.
        this.sessions.delete(wc.id)
        this.wired.delete(wc.id)
      } else {
        return existing
      }
    }
    const session = createControlSession({
      webContents: wc,
      tabId,
      epoch: this.epoch,
      colorScheme: this.colorScheme,
    })
    this.sessions.set(wc.id, session)
    if (!this.wired.has(wc.id)) {
      this.wired.add(wc.id)
      session.onDebuggerMessage((method, params) => {
        if (method === "Page.screencastFrame") {
          for (const listener of this.screencastListeners) listener(params)
        }
      })
    }
    return session
  }
}
