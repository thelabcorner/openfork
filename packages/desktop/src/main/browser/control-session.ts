import type { WebContents } from "electron"
import { BrowserDebuggerConflictError, BrowserNotAttachedError } from "./errors"
import { ControlArbiter, ControlEpoch, createEpochGuardedSender, type DebuggerCommand } from "./arbitration"

// One CDP control session per guest webContents. Serializes agent actions with
// a one-permit semaphore, attaches `wc.debugger` on protocol 1.3, and
// detaches/re-attaches cleanly around DevTools. Persistent event domains stay
// disabled: the operations layer issues direct commands, and turning on
// Accessibility/Network/Runtime/Log globally creates continuous bookkeeping
// and event traffic that this implementation does not consume.
//
// ControlSessionManager is the facade the operations layer consumes: it owns
// the per-webContents ControlSessions, the pointer sequence counter, and the
// screencast frame fan-out.

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

export function createControlSession(options: ControlSessionOptions): ControlSession {
  const { webContents: wc, tabId, epoch, colorScheme } = options
  const permit = new Permit()
  let attached = false
  let command: DebuggerCommand | undefined
  let appliedColorScheme: "light" | "dark" | undefined
  let messageWired = false
  const messageListeners = new Set<(method: string, params: Record<string, unknown>) => void>()

  const onDebuggerMessage = (event: unknown, method: string, params: Record<string, unknown>) => {
    void event
    for (const listener of messageListeners) listener(method, params)
  }

  const wireMessages = () => {
    if (messageWired || messageListeners.size === 0) return
    wc.debugger.on("message", onDebuggerMessage)
    messageWired = true
  }

  const unwireMessages = () => {
    if (!messageWired) return
    wc.debugger.removeListener("message", onDebuggerMessage)
    messageWired = false
  }

  const applyAppearance = async () => {
    if (!command) return
    const next = colorScheme()
    if (appliedColorScheme === next) return
    await command(`Emulation.setEmulatedMedia`, {
      features: [{ name: "prefers-color-scheme", value: next }],
    })
    appliedColorScheme = next
  }

  const ensureAttached = async () => {
    if (wc.isDestroyed()) throw new BrowserNotAttachedError()
    if (wc.isDevToolsOpened()) throw new BrowserDebuggerConflictError()
    if (wc.debugger.isAttached()) {
      if (attached) {
        // Already our session. Check the desired appearance on each entry,
        // but only send CDP when it actually changed.
        await applyAppearance().catch(() => undefined)
        return
      }
      throw new BrowserDebuggerConflictError("The guest debugger is already attached by another client")
    }
    try {
      wc.debugger.attach("1.3")
    } catch (error) {
      throw new BrowserDebuggerConflictError(`Failed to attach guest debugger: ${(error as Error).message}`)
    }
    attached = true
    appliedColorScheme = undefined
    wireMessages()
    const send = async (method: string, params?: Record<string, unknown>) => wc.debugger.sendCommand(method, params)
    command = send
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
    isAttached: () => attached,
    ensureAttached,
    detachForDevTools: () => {
      if (!attached) return
      unwireMessages()
      try {
        wc.debugger.detach()
      } catch {
        // already detached by DevTools taking over
      }
      attached = false
      command = undefined
      appliedColorScheme = undefined
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
      if (attached) wireMessages()
      return () => {
        messageListeners.delete(listener)
        if (messageListeners.size === 0) unwireMessages()
      }
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
  private readonly screencastListeners = new Set<(tabId: string, params: Record<string, unknown>) => void>()
  private readonly screencastWires = new Map<number, () => void>()

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
    this.screencastWires.get(webContentsId)?.()
    this.screencastWires.delete(webContentsId)
    this.sessions.delete(webContentsId)
    return Promise.resolve()
  }

  async detachAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.detach(id)
  }

  /** Re-create (if detached) and re-attach the control session for a
   * webContents after DevTools has released the debugger target. Appearance
   * emulation belongs to the CDP SESSION, not the WebContents, so
   * ensureAttached() re-applies the live desired scheme here — this is the
   * only place that repairs appearance after webview replacement, DevTools
   * open/close, or any other session churn (see operations.openDevtools). */
  async reattach(wc: WebContents, tabId: string): Promise<void> {
    const session = this.obtain(tabId, wc as unknown as WebContentsLike)
    await session.reattach()
  }

  nextPointerSequence(): number {
    this.pointerSequence += 1
    return this.pointerSequence
  }

  /** Subscribe to Page.screencastFrame params across every live session. CDP
   * message listeners are wired lazily only while at least one recording is
   * active, so ordinary browser automation pays no event-listener overhead. */
  onScreencastFrame(cb: (tabId: string, params: Record<string, unknown>) => void): () => void {
    const wasEmpty = this.screencastListeners.size === 0
    this.screencastListeners.add(cb)
    if (wasEmpty) {
      for (const [id, session] of this.sessions) this.wireScreencast(id, session)
    }
    return () => {
      this.screencastListeners.delete(cb)
      if (this.screencastListeners.size !== 0) return
      for (const dispose of this.screencastWires.values()) dispose()
      this.screencastWires.clear()
    }
  }

  private wireScreencast(webContentsId: number, session: ControlSession): void {
    if (this.screencastWires.has(webContentsId)) return
    this.screencastWires.set(
      webContentsId,
      session.onDebuggerMessage((method, params) => {
        if (method !== "Page.screencastFrame") return
        for (const listener of this.screencastListeners) listener(session.tabId, params)
      }),
    )
  }

  private obtain(tabId: string, wc: WebContentsLike): ControlSession {
    const existing = this.sessions.get(wc.id)
    if (existing) {
      if (existing.tabId !== tabId) {
        // Same webContents re-bound to a new tab after a crash remount.
        // Detach our old debugger session before replacing the record; leaving
        // it attached makes the replacement look like an external debugger
        // conflict and retains its message listener indefinitely.
        existing.detachForDevTools()
        this.screencastWires.get(wc.id)?.()
        this.screencastWires.delete(wc.id)
        this.sessions.delete(wc.id)
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
    if (this.screencastListeners.size > 0) this.wireScreencast(wc.id, session)
    return session
  }
}
