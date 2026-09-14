import { app, BrowserWindow, nativeTheme, session, webContents } from "electron"
import type { WebContents } from "electron"
import { ControlArbiter } from "./arbitration"
import {
  BROWSER_PARTITION,
  HUMAN_INPUT_CHANNEL,
  type Appearance,
  type Controller,
  type GuestTabState,
  type HostOwner,
  type HumanInputSignal,
  isHumanInputSignal,
  toRendererGuestTabState,
  type RendererGuestTabState,
} from "./contracts"
// Webview guest registry. The renderer owns the <webview> DOM element; this
// registry owns the identity, lifecycle, and state of the guest webContents.
// Registration validates the T3 ownership contract:
//   wc.getType() === "webview" && wc.hostWebContents === the host window's webContents.
// Control arbitration lives in the ControlArbiter and CDP sessions in the
// ControlSessionManager (both injected); this module only observes the guest
// and forwards human input / crash signals to its callbacks.
/** Engine-internal tab record: full guest state plus the live webContents. */
export type GuestRecord = GuestTabState & { webContents: WebContents }
export type GuestRegistryOptions = {
  windowId: string
  arbiter: ControlArbiter
  isTrustedHost: (wc: WebContents) => boolean
  getMainWindowWebContents: () => WebContents | null
  /** Tab state changed (or the tab went away: tab = null). */
  onStateChange: (tab: RendererGuestTabState | null) => void
  /** Guest crashed or its webContents was destroyed. */
  onGuestGone: (runtimeTabId: string, webContentsId: number) => void
  /** Guest-posted human input (from the sandboxed guest preload). */
  onHumanInput: (runtimeTabId: string, signal: HumanInputSignal) => void
  logger?: { log: (message: string, meta?: unknown) => void; error: (message: string, meta?: unknown) => void }
}
export function isValidGuestWebContents(wc: WebContents, hostWebContents: WebContents) {
  if (wc.isDestroyed()) return false
  if (wc.getType() !== "webview") return false
  return wc.hostWebContents === hostWebContents
}
export function isBrowserGuestUrl(value: string) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "http:" || url.protocol === "https:"
}
export class GuestRegistry {
  private readonly tabs = new Map<string, GuestRecord>()
  private readonly snapshotRefs = new Map<string, Map<string, unknown>>()
  private readonly partitionRefs = new Map<string, number>()
  private readonly lastWireState = new Map<string, RendererGuestTabState>()
  private readonly bindings = new WeakMap<
    WebContents,
    { runtimeTabId: string; generation: number; dispose: () => void }
  >()
  private appearance: Appearance = "system"
  private recording: { active: boolean; recordingId?: string } = { active: false }
  /** Explicitly activated tab. Falls back to the first tab so a tab is always
   * active while any exist (and Map ORDER stays insertion order — activation
   * must not reorder the strip the way the session tabs UI keeps positions). */
  private activeTabId: string | null = null
  constructor(private readonly options: GuestRegistryOptions) {}
  get activeTab(): GuestRecord | undefined {
    if (this.activeTabId !== null) {
      const tracked = this.tabs.get(this.activeTabId)
      if (tracked) return tracked
    }
    return this.tabs.values().next().value
  }
  get size(): number {
    return this.tabs.size
  }
  get(runtimeTabId: string): GuestRecord | undefined {
    return this.tabs.get(runtimeTabId)
  }
  list(): GuestRecord[] {
    return [...this.tabs.values()]
  }
  activate(runtimeTabId: string): GuestRecord | undefined {
    const record = this.tabs.get(runtimeTabId)
    if (!record) return undefined
    this.activeTabId = runtimeTabId
    return record
  }
  /** Map an engine record to the wire tab state broadcast to the renderer. */
  tabState(record: GuestRecord): RendererGuestTabState {
    return toRendererGuestTabState(record, record === this.activeTab)
  }
  /** Push the current wire state for a tab to the onStateChange consumer. */
  sync(runtimeTabId: string): void {
    const record = this.tabs.get(runtimeTabId)
    if (!record) return
    const next = this.tabState(record)
    const previous = this.lastWireState.get(runtimeTabId)
    if (previous && sameWireGuestTabState(previous, next)) return
    this.lastWireState.set(runtimeTabId, next)
    this.options.onStateChange(next)
  }
  /** Resolve an attached live tab for an operation. Logical tabs intentionally
   * survive presentation detach, but stale/destroyed WebContents must never be
   * handed to CDP or browser chrome operations. */
  requireTab(runtimeTabId?: string): GuestRecord | undefined {
    const record = runtimeTabId ? this.tabs.get(runtimeTabId) : undefined
    if (!record) return undefined
    if (record.crashed || !record.attached || record.webContentsId === null || record.webContents.isDestroyed()) return undefined
    return record
  }
  /**
   * The renderer mounts the <webview> and reports it here. Creates the tab
   * record on first registration (open requests flow through the renderer, so
   * the record may not exist yet) and wires the guest lifecycle events.
   */
  register(
    runtimeTabId: string,
    webContentsId: number,
    generation = 0,
    lifecycleGeneration = 1,
    beforePublish?: (record: GuestRecord) => void,
  ): GuestRecord {
    const existing = this.tabs.get(runtimeTabId)
    if (existing && lifecycleGeneration !== existing.lifecycleGeneration) {
      throw new Error(`Stale lifecycle registration for tab "${runtimeTabId}"`)
    }
    if (existing && generation < existing.generation) {
      throw new Error(`Stale webview registration for tab "${runtimeTabId}"`)
    }
    const host = this.options.getMainWindowWebContents() ?? BrowserWindow.getAllWindows()[0]?.webContents ?? null
    if (!host) throw new Error("No host window for browser guest")
    const wc = webContents.fromId(webContentsId)
    if (!wc || !isValidGuestWebContents(wc, host)) {
      throw new Error("Invalid webview guest: not a webview or not hosted by this window")
    }
    if (!this.options.isTrustedHost(host)) throw new Error("Untrusted host window for browser guest")
    const previousWebContents = existing?.webContents
    if (previousWebContents && previousWebContents !== wc) {
      const previousBinding = this.bindings.get(previousWebContents)
      if (previousBinding?.runtimeTabId === runtimeTabId) {
        previousBinding.dispose()
        this.bindings.delete(previousWebContents)
      }
    }
    const record: GuestRecord =
      existing ??
      (({
        runtimeTabId,
        lifecycleGeneration,
        windowId: this.options.windowId,
        owner: { kind: "user" },
        webContentsId: null,
        url: "",
        title: "",
        readyState: "loading",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
        colorScheme: this.resolveColorScheme(),
        controller: "none",
        generation,
        crashed: false,
        attached: false,
        muted: false,
        snapshotVersion: 0,
      } satisfies GuestTabState) as GuestRecord)
    wc.setZoomFactor(record.zoomFactor)
    wc.setAudioMuted(record.muted)
    record.webContents = wc
    record.lifecycleGeneration = lifecycleGeneration
    record.generation = generation
    record.webContentsId = webContentsId
    record.crashed = false
    record.attached = true
    record.url = wc.getURL() || record.url
    record.loading = wc.isLoading()
    if (!this.tabs.has(runtimeTabId)) {
      this.tabs.set(runtimeTabId, record)
      if (this.activeTabId === null) this.activeTabId = runtimeTabId
      this.touchPartition(BROWSER_PARTITION)
    }
    const binding = this.bindings.get(wc)
    if (binding?.runtimeTabId !== runtimeTabId || binding?.generation !== generation) {
      binding?.dispose()
      this.bindings.set(wc, {
        runtimeTabId,
        generation,
        dispose: this.wireGuest(record, wc),
      })
    }
    beforePublish?.(record)
    this.sync(runtimeTabId)
    return record
  }
  /** Detach the renderer-owned presentation without deleting the logical tab. */
  detach(runtimeTabId: string, webContentsId?: number, generation?: number): boolean {
    const record = this.tabs.get(runtimeTabId)
    if (!record) return false
    if (webContentsId !== undefined && record.webContentsId !== webContentsId) return false
    if (generation !== undefined && record.generation !== generation) return false
    const binding = this.bindings.get(record.webContents)
    if (binding?.runtimeTabId === runtimeTabId && binding.generation === record.generation) {
      binding.dispose()
      this.bindings.delete(record.webContents)
    }
    this.options.arbiter.reset(runtimeTabId)
    this.snapshotRefs.delete(runtimeTabId)
    record.webContentsId = null
    record.attached = false
    record.loading = false
    this.sync(runtimeTabId)
    return true
  }
  /** Permanently remove a logical tab. Renderer cleanup must never call this. */
  remove(runtimeTabId: string): boolean {
    const record = this.tabs.get(runtimeTabId)
    if (!record) return false
    const binding = this.bindings.get(record.webContents)
    if (binding?.runtimeTabId === runtimeTabId) {
      binding.dispose()
      this.bindings.delete(record.webContents)
    }
    this.options.arbiter.reset(runtimeTabId)
    this.snapshotRefs.delete(runtimeTabId)
    this.lastWireState.delete(runtimeTabId)
    this.tabs.delete(runtimeTabId)
    if (this.activeTabId === runtimeTabId) this.activeTabId = this.tabs.keys().next().value ?? null
    this.releasePartition(BROWSER_PARTITION)
    return true
  }
  /** The agent is about to synthesize input; pre-register it for arbitration. */
  expectAgentInput(signal: HumanInputSignal): void {
    const active = this.activeTab
    if (!active) return
    this.options.arbiter.expectAgentInput(active.runtimeTabId, signal)
  }
  setController(runtimeTabId: string, controller: Controller): void {
    this.options.arbiter.setControllerFor(runtimeTabId, controller)
    const record = this.tabs.get(runtimeTabId)
    if (!record) return
    record.controller = this.options.arbiter.controller(runtimeTabId)
    this.sync(runtimeTabId)
  }
  /** Flip a tab's owner (claim, assign, orphan) and push the wire state out. */
  setOwner(runtimeTabId: string, owner: HostOwner): void {
    const record = this.tabs.get(runtimeTabId)
    if (!record) return
    record.owner = owner
    this.sync(runtimeTabId)
  }
  setMuted(runtimeTabId: string, muted: boolean): void {
    const record = this.tabs.get(runtimeTabId)
    if (!record) return
    record.muted = muted
    this.sync(runtimeTabId)
  }
  controller(runtimeTabId: string): Controller {
    return this.options.arbiter.controller(runtimeTabId)
  }
  setAppearance(next: Appearance): void {
    this.appearance = next
    for (const record of this.tabs.values()) record.colorScheme = this.resolveColorScheme()
    this.options.onStateChange(this.activeTab ? this.tabState(this.activeTab) : null)
  }
  getAppearance(): Appearance {
    return this.appearance
  }
  setRecording(next: { active: boolean; recordingId?: string }): void {
    this.recording = next
    this.options.onStateChange(this.activeTab ? this.tabState(this.activeTab) : null)
  }
  getRecording(): { active: boolean; recordingId?: string } {
    return this.recording
  }
  bumpSnapshotVersion(runtimeTabId: string): number {
    const record = this.tabs.get(runtimeTabId)
    if (!record) return 0
    record.snapshotVersion += 1
    return record.snapshotVersion
  }
  setSnapshotRefs(runtimeTabId: string, refs: Map<string, unknown>): void {
    this.snapshotRefs.set(runtimeTabId, refs)
  }
  getSnapshotRefs(runtimeTabId: string): Map<string, unknown> | undefined {
    return this.snapshotRefs.get(runtimeTabId)
  }
  teardown(): void {
    for (const runtimeTabId of [...this.tabs.keys()]) this.remove(runtimeTabId)
  }
  // --- internals -------------------------------------------------------------
  private resolveColorScheme(): "light" | "dark" {
    if (this.appearance !== "system") return this.appearance
    return app.isReady() ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : "light"
  }
  private touchPartition(partition: string) {
    this.partitionRefs.set(partition, (this.partitionRefs.get(partition) ?? 0) + 1)
  }
  private releasePartition(partition: string) {
    const next = (this.partitionRefs.get(partition) ?? 1) - 1
    if (next > 0) {
      this.partitionRefs.set(partition, next)
      return
    }
    this.partitionRefs.delete(partition)
    // In-memory (non-persist) partitions are torn down when the last guest
    // closes; persist: partitions intentionally keep cookies/navigation state
    // across tab close and app restart.
    if (!partition.startsWith("persist:")) {
      void session.fromPartition(partition).clearStorageData().catch((error) => {
        this.options.logger?.error("browser partition teardown failed", { partition, error })
      })
    }
  }
  private wireGuest(record: GuestRecord, wc: WebContents): () => void {
    const runtimeTabId = record.runtimeTabId
    const webContentsId = wc.id
    const generation = record.generation
    const current = () => {
      const tab = this.tabs.get(runtimeTabId)
      return tab?.webContentsId === webContentsId && tab.generation === generation && tab.webContents === wc
    }
    const onDidStartLoading = () => {
      if (!current()) return
      record.loading = true
      record.readyState = "loading"
      this.sync(runtimeTabId)
    }
    const onDidStopLoading = () => {
      if (!current()) return
      record.loading = false
      record.readyState = "complete"
      this.sync(runtimeTabId)
    }
    const onDidFinishLoad = () => {
      if (!current()) return
      record.readyState = "complete"
      record.url = wc.getURL()
      this.sync(runtimeTabId)
    }
    const onPageTitleUpdated = (_event: Electron.Event, title: string) => {
      if (!current()) return
      record.title = title
      this.sync(runtimeTabId)
    }
    const onDidNavigate = (_event: Electron.Event, url: string) => {
      if (!current()) return
      record.url = url
      this.sync(runtimeTabId)
    }
    const onDidNavigateInPage = (_event: Electron.Event, url: string) => {
      if (!current()) return
      record.url = url
      this.sync(runtimeTabId)
    }
    const onRenderProcessGone = () => {
      if (!current()) return
      record.crashed = true
      record.attached = false
      this.options.logger?.error("browser guest render process gone", {
        runtimeTabId,
        webContentsId: wc.id,
        url: wc.getURL(),
      })
      this.options.onGuestGone(runtimeTabId, wc.id)
      this.sync(runtimeTabId)
    }
    const onDidFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!current()) return
      this.options.logger?.error("browser guest failed load", {
        runtimeTabId,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      })
      if (isMainFrame) {
        record.loading = false
        record.readyState = "complete"
        this.sync(runtimeTabId)
      }
    }
    const onDestroyed = () => {
      if (!current()) return
      record.attached = false
      this.options.onGuestGone(runtimeTabId, wc.id)
      this.sync(runtimeTabId)
    }
    // Guest-posted human input (from the sandboxed guest preload). The agent's
    // own CDP-dispatched input echoes back here too — the arbiter matches it
    // against the expected-agent-input queue so only REAL human input preempts.
    const onIpcMessage = (_event: Electron.Event, channel: string, ...args: unknown[]) => {
      if (!current()) return
      if (channel !== HUMAN_INPUT_CHANNEL) return
      const signal = args[0] as HumanInputSignal | undefined
      if (!signal || !isHumanInputSignal(signal)) return
      this.options.onHumanInput(record.runtimeTabId, signal)
    }

    wc.on("did-start-loading", onDidStartLoading)
    wc.on("did-stop-loading", onDidStopLoading)
    wc.on("did-finish-load", onDidFinishLoad)
    wc.on("page-title-updated", onPageTitleUpdated)
    wc.on("did-navigate", onDidNavigate)
    wc.on("did-navigate-in-page", onDidNavigateInPage)
    wc.on("render-process-gone", onRenderProcessGone)
    wc.on("did-fail-load", onDidFailLoad)
    wc.on("destroyed", onDestroyed)
    wc.on("ipc-message", onIpcMessage)
    // Deny popups inside the hosted guest. Loading the popup target in-place
    // can cause consent/login retry loops on sites that expect a separate tab.
    wc.setWindowOpenHandler(({ url }) => {
      this.options.logger?.log("browser guest blocked popup", { runtimeTabId, url })
      return { action: "deny" }
    })
    // Restrict guest navigation to http(s) only.
    const onWillNavigate = (event: Electron.Event, url: string) => {
      if (isBrowserGuestUrl(url)) return
      event.preventDefault()
      if (url.startsWith("javascript:")) return
      this.options.logger?.log("browser guest blocked navigation", { url })
    }
    wc.on("will-navigate", onWillNavigate)

    return () => {
      // Once Chromium has destroyed the target there is no live native target
      // to detach from; the WebContents object itself will be collected. For a
      // live rebind/unregister, remove every closure that captures tab identity
      // so a reused WebContents cannot report state/input to a stale tab.
      if (wc.isDestroyed()) return
      wc.removeListener("did-start-loading", onDidStartLoading)
      wc.removeListener("did-stop-loading", onDidStopLoading)
      wc.removeListener("did-finish-load", onDidFinishLoad)
      wc.removeListener("page-title-updated", onPageTitleUpdated)
      wc.removeListener("did-navigate", onDidNavigate)
      wc.removeListener("did-navigate-in-page", onDidNavigateInPage)
      wc.removeListener("render-process-gone", onRenderProcessGone)
      wc.removeListener("did-fail-load", onDidFailLoad)
      wc.removeListener("destroyed", onDestroyed)
      wc.removeListener("ipc-message", onIpcMessage)
      wc.removeListener("will-navigate", onWillNavigate)
      // Drop the tab-specific popup closure while preserving the deny policy
      // until this live WebContents is rebound or destroyed.
      wc.setWindowOpenHandler(() => ({ action: "deny" }))
    }
  }
}

function sameWireGuestTabState(a: RendererGuestTabState, b: RendererGuestTabState): boolean {
  const sameOwner =
    a.owner.kind === b.owner.kind &&
    (a.owner.kind !== "agent" || b.owner.kind !== "agent" || a.owner.sessionId === b.owner.sessionId)
  return (
    a.tabId === b.tabId &&
    a.lifecycleGeneration === b.lifecycleGeneration &&
    a.url === b.url &&
    a.title === b.title &&
    a.readyState === b.readyState &&
    a.controller === b.controller &&
    a.zoomFactor === b.zoomFactor &&
    a.attached === b.attached &&
    sameOwner &&
    a.active === b.active &&
    a.muted === b.muted
  )
}
