import { app, BrowserWindow, nativeTheme, session, webContents } from "electron"
import type { WebContents } from "electron"

import { ControlArbiter } from "./arbitration"
import {
  BROWSER_PARTITION,
  HUMAN_INPUT_CHANNEL,
  type Appearance,
  type Controller,
  type GuestTabState,
  type HumanInputSignal,
  isHumanInputSignal,
  toWireGuestTabState,
  type WireGuestTabState,
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
  onStateChange: (tab: WireGuestTabState | null) => void
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
  private readonly wired = new WeakSet<WebContents>()
  private appearance: Appearance = "system"
  private recording: { active: boolean; recordingId?: string } = { active: false }

  constructor(private readonly options: GuestRegistryOptions) {}

  get activeTab(): GuestRecord | undefined {
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
    const rest = [...this.tabs.entries()].filter(([tabId]) => tabId !== runtimeTabId)
    this.tabs.clear()
    this.tabs.set(runtimeTabId, record)
    rest.forEach(([tabId, existing]) => this.tabs.set(tabId, existing))
    return record
  }

  /** Map an engine record to the wire tab state broadcast to the renderer. */
  tabState(record: GuestRecord): WireGuestTabState {
    return toWireGuestTabState(record)
  }

  /** Push the current wire state for a tab to the onStateChange consumer. */
  sync(runtimeTabId: string): void {
    const record = this.tabs.get(runtimeTabId)
    if (record) this.options.onStateChange(toWireGuestTabState(record))
  }

  /** Resolve a tab for an operation; undefined when unknown or crashed. */
  requireTab(runtimeTabId?: string): GuestRecord | undefined {
    const record = runtimeTabId ? this.tabs.get(runtimeTabId) : undefined
    if (!record) return undefined
    if (record.crashed) return undefined
    return record
  }

  /**
   * The renderer mounts the <webview> and reports it here. Creates the tab
   * record on first registration (open requests flow through the renderer, so
   * the record may not exist yet) and wires the guest lifecycle events.
   */
  register(runtimeTabId: string, webContentsId: number, generation = 0): GuestRecord {
    const existing = this.tabs.get(runtimeTabId)
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

    const record: GuestRecord =
      existing ??
      (({
        runtimeTabId,
        windowId: this.options.windowId,
        sessionId: "",
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
        snapshotVersion: 0,
      } satisfies GuestTabState) as GuestRecord)
    record.webContents = wc
    record.generation = generation
    record.webContentsId = webContentsId
    record.crashed = false
    record.attached = true
    record.url = wc.getURL() || record.url
    record.loading = wc.isLoading()
    if (!this.tabs.has(runtimeTabId)) {
      this.tabs.set(runtimeTabId, record)
      this.touchPartition(BROWSER_PARTITION)
    }
    if (!this.wired.has(wc)) {
      this.wired.add(wc)
      this.wireGuest(record, wc)
    }
    this.sync(runtimeTabId)
    return record
  }

  /** Tear down a tab: clear arbitration, refs, and the partition lease. */
  unregister(runtimeTabId: string): void {
    const record = this.tabs.get(runtimeTabId)
    if (!record) return
    this.options.arbiter.reset(runtimeTabId)
    this.snapshotRefs.delete(runtimeTabId)
    this.tabs.delete(runtimeTabId)
    this.releasePartition(BROWSER_PARTITION)
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

  controller(runtimeTabId: string): Controller {
    return this.options.arbiter.controller(runtimeTabId)
  }

  setAppearance(next: Appearance): void {
    this.appearance = next
    for (const record of this.tabs.values()) record.colorScheme = this.resolveColorScheme()
    this.options.onStateChange(this.activeTab ? toWireGuestTabState(this.activeTab) : null)
  }

  getAppearance(): Appearance {
    return this.appearance
  }

  setRecording(next: { active: boolean; recordingId?: string }): void {
    this.recording = next
    this.options.onStateChange(this.activeTab ? toWireGuestTabState(this.activeTab) : null)
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
    for (const runtimeTabId of [...this.tabs.keys()]) this.unregister(runtimeTabId)
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

  private wireGuest(record: GuestRecord, wc: WebContents) {
    wc.on("did-start-loading", () => {
      if (!this.tabs.has(record.runtimeTabId)) return
      record.loading = true
      record.readyState = "loading"
      this.sync(record.runtimeTabId)
    })
    wc.on("did-stop-loading", () => {
      if (!this.tabs.has(record.runtimeTabId)) return
      record.loading = false
      record.readyState = "complete"
      this.sync(record.runtimeTabId)
    })
    wc.on("did-finish-load", () => {
      if (!this.tabs.has(record.runtimeTabId)) return
      record.readyState = "complete"
      record.url = wc.getURL()
      this.sync(record.runtimeTabId)
    })
    wc.on("page-title-updated", (_event, title) => {
      if (!this.tabs.has(record.runtimeTabId)) return
      record.title = title
      this.sync(record.runtimeTabId)
    })
    wc.on("did-navigate", (_event, url) => {
      if (!this.tabs.has(record.runtimeTabId)) return
      record.url = url
      this.sync(record.runtimeTabId)
    })
    wc.on("did-navigate-in-page", (_event, url) => {
      if (!this.tabs.has(record.runtimeTabId)) return
      record.url = url
      this.sync(record.runtimeTabId)
    })
    wc.on("render-process-gone", () => {
      if (!this.tabs.has(record.runtimeTabId)) return
      record.crashed = true
      record.attached = false
      this.options.logger?.error("browser guest render process gone", {
        runtimeTabId: record.runtimeTabId,
        webContentsId: wc.id,
        url: wc.getURL(),
      })
      this.options.onGuestGone(record.runtimeTabId, wc.id)
      this.sync(record.runtimeTabId)
    })
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!this.tabs.has(record.runtimeTabId)) return
      this.options.logger?.error("browser guest failed load", {
        runtimeTabId: record.runtimeTabId,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      })
    })
    wc.on("destroyed", () => {
      if (!this.tabs.has(record.runtimeTabId)) return
      record.attached = false
      this.options.onGuestGone(record.runtimeTabId, wc.id)
      this.sync(record.runtimeTabId)
    })

    // Guest-posted human input (from the sandboxed guest preload). The agent's
    // own CDP-dispatched input echoes back here too — the arbiter matches it
    // against the expected-agent-input queue so only REAL human input preempts.
    wc.on("ipc-message", (_event, channel, ...args) => {
      if (channel !== HUMAN_INPUT_CHANNEL) return
      const signal = args[0] as HumanInputSignal | undefined
      if (!signal || !isHumanInputSignal(signal)) return
      this.options.onHumanInput(record.runtimeTabId, signal)
    })

    // Deny popups inside the hosted guest. Loading the popup target in-place
    // can cause consent/login retry loops on sites that expect a separate tab.
    wc.setWindowOpenHandler(({ url }) => {
      this.options.logger?.log("browser guest blocked popup", { runtimeTabId: record.runtimeTabId, url })
      return { action: "deny" }
    })
    // Restrict guest navigation to http(s) only.
    wc.on("will-navigate", (event, url) => {
      if (isBrowserGuestUrl(url)) return
      event.preventDefault()
      if (url.startsWith("javascript:")) return
      this.options.logger?.log("browser guest blocked navigation", { url })
    })
  }
}
