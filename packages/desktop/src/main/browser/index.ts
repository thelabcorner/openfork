// BrowserEngine facade: composes the guest registry, control arbitration, CDP
// control sessions, operations, and the host HTTP bridge; owns the
// renderer-facing IPC surface (window.api.browser) and window broadcasts.
import type { WebContents } from "electron"
import { BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserOperations } from "./operations"
import { GuestRegistry } from "./guest"
import { ControlArbiter } from "./arbitration"
import { ControlSessionManager } from "./control-session"
import { BrowserHost } from "./host"
import { AnnotationController } from "./annotation"
import { BrowserTabLifecycle } from "./tab-lifecycle"
import { ExtensionHost } from "./extension-bridge/extension-host"
import { ExtensionBridge, type ExtensionTabRecord } from "./extension-bridge/extension-bridge"
import { VisualObservationCoordinator } from "./visual/coordinator"
import { runVisualRpcWire } from "./visual/rpc"
import { WebviewVisualController } from "./visual/webview-controller"
import {
  BROWSER_PROTOCOL_VERSION,
  type Appearance,
  type BrowserAnnotationResult,
  type BrowserDispatchContext,
  type BrowserOperation,
  type BrowserState,
  type ExtensionInfo,
  type HostCapabilities,
  type HostOwner,
  type HumanInputSignal,
  type RendererGuestTabState,
  type VisualApprovalOutput,
  type VisualApprovalExpectation,
  type VisualArtifactInput,
  type VisualArtifactOutput,
  type VisualArtifactPreview,
  type VisualHistoryInput,
  type VisualHistoryOutput,
  type VisualProjectContext,
  type WireGuestTabState,
  rangeTargets,
} from "./contracts"
// wireGuest (guest.ts) calls sync() on every micro-transition of a
// navigation (start-loading, title, navigate, stop-loading can all fire
// within the same tick, and SPA pages firing did-navigate-in-page on every
// history.pushState multiply this further). The renderer broadcast stays
// immediate (cheap in-process IPC, and the UI should reflect it promptly);
// only the outbound sidecar POST — a real network round-trip per call — is
// coalesced, since "guest.stateChanged" carries the full current tab state
// and downstream consumers only care about the latest value, not every
// intermediate one.
const GUEST_STATE_EVENT_DEBOUNCE_MS = 80
export interface BrowserEngineOptions {
  windowId: string
  /** Latest sidecar endpoint+auth (from ServerReadyData); null until ready. */
  sidecarProvider: () => { url: string; username: string; password: string } | null
  /** Push a message to every app renderer window. */
  broadcast: (channel: string, payload: unknown) => void
  getLastFocusedWebContents: () => WebContents | null
  recordingDirectory: string
  logger?: { log: (message: string, meta?: unknown) => void; error: (message: string, meta?: unknown) => void }
}
export interface BrowserRenderApi {
  getState: () => BrowserState
  openTab: (url: string, opts?: { activate?: boolean; newTab?: boolean }) => { tabId: string }
  activateTab: (tabId: string) => BrowserState
  closeTab: (tabId: string) => { closed: boolean }
  registerWebview: (runtimeTabId: string, webContentsId: number, generation: number, lifecycleGeneration: number) => { ok: true }
  unregisterWebview: (runtimeTabId: string, webContentsId: number | undefined, generation: number | undefined, lifecycleGeneration: number) => { ok: true }
  humanInput: (runtimeTabId: string, signal: unknown) => void
  /** User-initiated ownership change (D7) — assign/reassign/unassign to ANY owner. */
  assignTab: (tabId: string, owner: HostOwner) => Promise<{ tabId: string; owner: HostOwner }>
  /** User close-range (D8): close tabs left/right/others/all of `tabId`. */
  closeRange: (tabId: string, mode: "left" | "right" | "others" | "all") => { closed: string[] }
  /** Host-level webview reload (D8a). */
  refreshTab: (tabId: string) => Promise<void>
  /** Clone the tab with the same URL; the duplicate INHERITS the source owner (D8). */
  duplicateTab: (tabId: string) => Promise<{ tabId: string; url: string }>
  /** Per-tab audio mute toggle (D8b). */
  setTabMuted: (tabId: string, muted: boolean) => Promise<void>
  /** Chrome chrome ops (D10): detached devtools, cache-bypassing reload, storage clears. */
  openDevtools: (tabId: string) => Promise<void>
  hardReload: (tabId: string) => Promise<void>
  clearCookies: (tabId: string) => Promise<void>
  clearCache: (tabId: string) => Promise<void>
  setAppearance: (appearance: Appearance) => Promise<void>
  listExtensions: (tabId: string) => Promise<ExtensionInfo[]>
  setExtensionEnabled: (tabId: string, extensionId: string, enabled: boolean) => Promise<void>
  startAnnotation: (tabId: string) => Promise<BrowserAnnotationResult | null>
  cancelAnnotation: (tabId: string) => void
  visualHistory: (context: VisualProjectContext, input?: VisualHistoryInput) => Promise<VisualHistoryOutput["history"]>
  visualArtifact: (context: VisualProjectContext, input: VisualArtifactInput) => Promise<VisualArtifactOutput["artifact"]>
  visualArtifactPreview: (context: VisualProjectContext, input: VisualArtifactInput) => Promise<VisualArtifactPreview | null>
  visualApproveRun: (context: VisualProjectContext, runId: string, expected: VisualApprovalExpectation) => Promise<VisualApprovalOutput>
}
export class BrowserEngine {
  readonly arbiter = new ControlArbiter()
  readonly sessions = new ControlSessionManager({ arbiter: this.arbiter })
  readonly registry: GuestRegistry
  readonly operations: BrowserOperations
  readonly host: BrowserHost
  readonly annotation = new AnnotationController()
  readonly visual = new VisualObservationCoordinator()
  readonly visualWebview = new WebviewVisualController(this.visual)
  private readonly tabLifecycle = new BrowserTabLifecycle()
  // Chrome-attach extension lane (optional — present when extension-bridge is bundled)
  readonly extensionHost: ExtensionHost
  readonly extensionBridge: ExtensionBridge
  private readonly chromeTabsMirror: ExtensionTabRecord[] = []
  private readonly chromeTabsById = new Map<string, ExtensionTabRecord>()
  private chromeActiveTabId: string | null = null
  private readonly options: BrowserEngineOptions
  private readonly hostId = randomUUID()
  private readonly hostEpoch = 1
  private readonly pendingActivation = new Set<string>()
  private readonly guestStateEventTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private started = false
  constructor(options: BrowserEngineOptions) {
    this.options = options
    const capabilities: HostCapabilities = {
      maxSnapshotBytes: 256 * 1024,
      maxResultBytes: 64 * 1024,
      supportedAppearances: ["system", "light", "dark"],
      supportsRecording: true,
      cdp: true,
      visual: {
        schemaVersion: 1,
        snapeyeProtocolVersion: 1,
        operations: ["capture", "diff", "record"],
        features: ["history", "artifact"],
      },
      // chrome flag advertised dynamically via getCapabilities; static fallback false
    }
    this.sessions = new ControlSessionManager({
      arbiter: this.arbiter,
      // Live appearance resolver: emulated media belongs to the CDP SESSION,
      // not the WebContents, so the desired scheme must be read from the
      // registry (which the renderer drives via browser-set-appearance) and
      // REAPPLIED on every debugger re-attach — after webview replacement,
      // after DevTools open/close, after any session churn. Never a constant.
      colorScheme: () => this.registry.getAppearance() === "dark" ? "dark" : "light",
    })
    this.registry = new GuestRegistry({
      windowId: options.windowId,
      arbiter: this.arbiter,
      isTrustedHost: (wc) => BrowserWindow.fromWebContents(wc) !== null,
      getMainWindowWebContents: () => options.getLastFocusedWebContents(),
      onStateChange: (tab) => {
        if (!tab) return
        this.options.broadcast("browser-state", tab)
        this.scheduleGuestStateEvent(tab)
      },
      onGuestGone: (runtimeTabId, webContentsId) => {
        const tab = this.registry.get(runtimeTabId)
        if (tab) this.tabLifecycle.markDetached(runtimeTabId, tab.lifecycleGeneration)
        this.arbiter.reset(runtimeTabId)
        this.sessions.detach(webContentsId).catch(() => undefined)
        this.annotation.cancel(runtimeTabId)
        this.visualWebview.cancel(runtimeTabId, "Browser guest went away")
        this.host.emitHostEvent({ type: "guest.crashed", tabId: runtimeTabId, timestamp: new Date().toISOString() })
      },
      onHumanInput: (runtimeTabId, signal) => {
        this.handleHumanInput(runtimeTabId, signal)
      },
      logger: options.logger,
    })
    this.operations = new BrowserOperations({
      registry: this.registry,
      sessions: this.sessions,
      visual: this.visualWebview,
      recordingDirectory: options.recordingDirectory,
      maxResultBytes: capabilities.maxResultBytes,
      getHostState: () => ({
        connected: this.host.isConnected,
        hostId: this.hostId,
        hostEpoch: this.hostEpoch,
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        windowId: options.windowId,
      }),
      onTabRequest: (request) => this.requestTabPresentation(request),
      onTabRequestExpired: (tabId, lifecycleGeneration) => this.expireTabRequest(tabId, lifecycleGeneration),
      onTabClose: (tabId) => {
        const tab = this.registry.get(tabId)
        if (!tab || !this.tabLifecycle.beginClose(tabId, tab.lifecycleGeneration)) return
        // Broker/agent close must own cleanup before the renderer unmounts.
        // Once the lifecycle is closed, that later renderer unregister is
        // intentionally stale and therefore cannot be relied on for cleanup.
        this.arbiter.preempt(tabId)
        if (tab.webContentsId != null) this.sessions.detach(tab.webContentsId).catch(() => undefined)
        this.pendingActivation.delete(tabId)
        this.annotation.cancel(tabId)
        this.visualWebview.cancel(tabId, "Browser tab closed")
        this.options.broadcast("browser-tab-close", { tabId })
      },
      onTabClosed: (tabId) => {
        this.tabLifecycle.finishClose(tabId)
        this.host.emitHostEvent({ type: "tab.closed", tabId, timestamp: new Date().toISOString() })
      },
      onPointerEvent: (event) => this.options.broadcast("browser-pointer-event", event),
      logger: options.logger,
    })
    // Extension lane — shares the same arbiter epoch and operations dispatch
    this.extensionHost = new ExtensionHost({
      onConnectedChange: (connected) => {
        if (!connected) {
          this.chromeTabsMirror.length = 0
          this.chromeTabsById.clear()
          this.chromeActiveTabId = null
        }
        if (this.started) this.host.reRegister()
      },
      logger: options.logger,
    })
    this.extensionBridge = new ExtensionBridge({
      windowId: options.windowId,
      registry: this.registry,
      operations: this.operations,
      extensionHost: this.extensionHost,
      visual: this.visual,
      getAppearance: () => this.registry.getAppearance(),
      getExtensionTabs: () => this.chromeTabsMirror,
      getExtensionTab: (tabId) => this.chromeTabsById.get(tabId),
      getExtensionActiveTabId: () => this.chromeActiveTabId,
      onExtensionSnapshot: (tabs, activeTabId) => {
        this.chromeTabsMirror.splice(0, this.chromeTabsMirror.length, ...tabs)
        this.chromeTabsById.clear()
        for (const tab of tabs) this.chromeTabsById.set(tab.tabId, tab)
        this.chromeActiveTabId = activeTabId
      },
      logger: options.logger,
    })
    this.host = new BrowserHost({
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      windowId: options.windowId,
      capabilities,
      getCapabilities: () => this.extensionBridge.hostHelloCapabilities(capabilities),
      getHealthExtra: () => this.extensionBridge.health() as { chrome: boolean; lanes: string[] },
      extensionRelay: this.extensionHost,
      visualRpc: (request) => runVisualRpcWire(this.visual, request),
      sidecarProvider: options.sidecarProvider,
      getGuestSnapshot: () => {
        const active = this.registry.activeTab
        return {
          attached: this.registry.size > 0,
          activeTabId: active?.runtimeTabId ?? null,
          url: active?.url ?? null,
        }
      },
      dispatch: (tabId, operation, context) => this.extensionBridge.dispatch(tabId, operation, context),
      onConnectedChange: (connected) => {
        this.options.broadcast("browser-host-state", { connected })
        this.options.logger?.log("browser host connected", { connected })
      },
      logger: options.logger,
    })
  }
  /** Human input (guest preload ipc or renderer-forwarded): preemption decision + controller lifecycle. */
  private handleHumanInput(runtimeTabId: string, signal: unknown): void {
    const syncController = () => {
      const tab = this.registry.get(runtimeTabId)
      if (!tab) return
      const controller = this.arbiter.controller(runtimeTabId)
      if (tab.controller === controller) return
      tab.controller = controller
      this.registry.sync(runtimeTabId)
    }

    // handleHumanInput marks a real human takeover synchronously before its
    // promise waits out the preemption window. Publish that immediate state now
    // instead of waiting until the promise resolves (at which point it is
    // already back to "none"), then publish the settled state if it changed.
    const humanSignal = signal as HumanInputSignal
    // Guest preload also sees the agent's own CDP-dispatched pointer/key echo.
    // Consume that expected input first so agent automation cannot self-cancel
    // a visual operation. Anything unmatched is genuine human authority.
    if (this.arbiter.consumeExpectedAgentInput(runtimeTabId, humanSignal)) {
      syncController()
      return
    }
    this.visualWebview.cancel(runtimeTabId, "Human input interrupted visual operation")
    const settled = this.arbiter.handleHumanInput(runtimeTabId, humanSignal)
    syncController()
    void settled.then(syncController)
  }
  /** Called after the app server is ready: start the host bridge. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.extensionHost.start().catch(() => undefined)
    await this.host.start()
  }
  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    for (const timer of this.guestStateEventTimers.values()) clearTimeout(timer)
    this.guestStateEventTimers.clear()
    for (const tab of this.registry.list()) this.annotation.cancel(tab.runtimeTabId)
    this.visualWebview.stop()
    this.registry.teardown()
    this.tabLifecycle.clear()
    await this.sessions.detachAll()
    await this.visual.stop()
    await this.extensionHost.stop().catch(() => undefined)
    await this.host.stop()
  }
  get isHostConnected(): boolean {
    return this.host.isConnected
  }
  getState(): BrowserState {
    const tabs = this.registry.list().map((record) => this.registry.tabState(record))
    const active = this.registry.activeTab
    const baseCapabilities: HostCapabilities = {
      maxSnapshotBytes: 256 * 1024,
      maxResultBytes: 64 * 1024,
      supportedAppearances: ["system", "light", "dark"],
      supportsRecording: true,
      cdp: true,
      visual: {
        schemaVersion: 1,
        snapeyeProtocolVersion: 1,
        operations: ["capture", "diff", "record"],
        features: ["history", "artifact"],
      },
    }
    const capabilities = this.extensionBridge.hostHelloCapabilities(baseCapabilities)
    // Extension lane state — merged into Chrome optional field (no protocol bump)
    const chromeTabs = this.chromeTabsMirror.map((t) => ({
      tabId: t.tabId,
      lifecycleGeneration: 0,
      url: t.url,
      title: t.title,
      readyState: (t.readyState ?? "Success") as WireGuestTabState["readyState"],
      controller: (t.controller ?? "none") as WireGuestTabState["controller"],
      zoomFactor: 1,
      attached: true,
      owner: t.owner ?? { kind: "user" as const },
      active: t.tabId === this.chromeActiveTabId,
      muted: t.muted ?? false,
    }))
    const chromeAttached = this.extensionHost.isConnected || this.chromeTabsMirror.length > 0
    const chromeActive = (this.chromeActiveTabId ? this.chromeTabsById.get(this.chromeActiveTabId) : undefined) ?? this.chromeTabsMirror.find((t) => t.active) ?? null
    return {
      host: {
        connected: this.host.isConnected,
        hostId: this.hostId,
        hostEpoch: this.hostEpoch,
        connectionId: this.host.callbackUrlToken,
        windowId: this.options.windowId,
        capabilities,
      },
      appearance: this.registry.getAppearance(),
      guest: {
        attached: this.registry.size > 0,
        activeTabId: active?.runtimeTabId ?? null,
        url: active?.url ?? null,
        controller: active ? this.arbiter.controller(active.runtimeTabId) : "none",
        zoomFactor: active?.zoomFactor ?? 1,
      },
      tabs,
      ...(chromeTabs.length > 0 || chromeAttached
        ? {
            chrome: {
              attached: chromeAttached,
              activeTabId: chromeActive?.tabId ?? this.chromeActiveTabId,
              url: chromeActive?.url ?? null,
              tabs: chromeTabs,
            },
          }
        : {}),
    }
  }
  /** Renderer/browser-chrome actions do not originate from an agent broker
   * request. Give them an explicit host-local context instead of smuggling an
   * empty session id through the broker dispatch API. Workspace-aware features
   * can therefore reliably reject these calls by the absence of directory. */
  private dispatchInternal(tabId: string | undefined, operation: BrowserOperation): Promise<Record<string, unknown>> {
    const context: BrowserDispatchContext = {
      requestId: "desktop-ui",
      sessionId: "",
      windowId: this.options.windowId,
      messageId: "desktop-ui",
      timeoutMs: 15_000,
    }
    return this.operations.dispatch(tabId, operation, context)
  }
  private visualRendererContext(input: VisualProjectContext, timeoutMs = 15_000): BrowserDispatchContext {
    if (!input?.sessionId || !input?.directory) throw new Error("Visual workflow requires an active project session")
    return {
      requestId: `desktop-ui-visual-${randomUUID()}`,
      sessionId: input.sessionId,
      windowId: this.options.windowId,
      directory: input.directory,
      messageId: "desktop-ui-visual",
      timeoutMs,
    }
  }
  /** Renderer-facing API (window.api.browser). */
  readonly api: BrowserRenderApi = {
    getState: () => this.getState(),
    openTab: (url, opts) => {
      // Human-opened tabs are owner `user` (registry default; D2).
      const tabId = randomUUID()
      if (opts?.activate ?? true) this.pendingActivation.add(tabId)
      this.requestTabPresentation({
        tabId,
        url,
        activate: opts?.activate ?? true,
        newTab: opts?.newTab ?? true,
      })
      return { tabId }
    },
    activateTab: (tabId) => {
      this.registry.activate(tabId)
      return this.getState()
    },
    closeTab: (tabId) => this.closeTabInternal(tabId).length === 1 ? { closed: true } : { closed: false },
    registerWebview: (runtimeTabId, webContentsId, generation, lifecycleGeneration) => {
      if (!this.tabLifecycle.canAttach(runtimeTabId, lifecycleGeneration)) {
        throw new Error(`Rejected stale or unexpected webview registration for tab "${runtimeTabId}"`)
      }
      const current = this.registry.get(runtimeTabId)
      if (
        current?.attached &&
        current.webContentsId === webContentsId &&
        current.generation === generation &&
        current.lifecycleGeneration === lifecycleGeneration
      ) {
        return { ok: true }
      }
      const record = this.registry.register(runtimeTabId, webContentsId, generation, lifecycleGeneration, (attached) => {
        this.operations.prepareOpen(runtimeTabId, attached)
        if (this.pendingActivation.delete(runtimeTabId)) this.registry.activate(runtimeTabId)
      })
      this.tabLifecycle.markAttached(runtimeTabId, lifecycleGeneration)
      this.operations.resolveOpen(runtimeTabId, record)
      return { ok: true }
    },
    unregisterWebview: (runtimeTabId, webContentsId, generation, lifecycleGeneration) => {
      if (!this.tabLifecycle.isCurrent(runtimeTabId, lifecycleGeneration)) return { ok: true }
      const detached = this.registry.detach(runtimeTabId, webContentsId, generation)
      if (detached) {
        this.tabLifecycle.markDetached(runtimeTabId, lifecycleGeneration)
        if (webContentsId !== undefined) this.sessions.detach(webContentsId).catch(() => undefined)
        this.annotation.cancel(runtimeTabId)
        this.visualWebview.cancel(runtimeTabId, "Browser guest detached")
      }
      return { ok: true }
    },
    humanInput: (runtimeTabId, signal) => {
      this.handleHumanInput(runtimeTabId, signal)
    },
    assignTab: async (tabId, owner) => {
      // User-initiated ownership change (D7): fully general — assign/reassign/unassign.
      const sidecar = this.options.sidecarProvider()
      if (!sidecar) throw new Error("No sidecar connection available")
      const response = await fetch(`${sidecar.url}/api/browser/assign`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${sidecar.username}:${sidecar.password}`).toString("base64")}`,
        },
        body: JSON.stringify({ tabId, owner }),
      })
      if (!response.ok) throw new Error(`browser assign responded ${response.status}`)
      const body = (await response.json()) as { data?: { tabId?: string; owner?: HostOwner } }
      return { tabId: body.data?.tabId ?? tabId, owner: body.data?.owner ?? owner }
    },
    closeRange: (tabId, mode) => {
      const ordered = this.registry.list().map((record) => record.runtimeTabId)
      return { closed: this.closeTabs(rangeTargets(ordered, tabId, mode)) }
    },
    refreshTab: async (tabId) => {
      try {
        await this.dispatchInternal(tabId, { name: "refresh", input: { tabId } })
      } catch {
        const activeId = this.registry.activeTab?.runtimeTabId
        if (activeId && activeId !== tabId) await this.dispatchInternal(activeId, { name: "refresh", input: { tabId: activeId } }).catch(() => undefined)
      }
    },
    duplicateTab: async (tabId) => {
      try {
        const result = (await this.dispatchInternal(tabId, { name: "duplicate", input: { tabId } })) as {
          duplicated?: { tabId?: string; url?: string }
        }
        return { tabId: result.duplicated?.tabId ?? tabId, url: result.duplicated?.url ?? "" }
      } catch {
        return { tabId, url: "" }
      }
    },
    setTabMuted: async (tabId, muted) => {
      try {
        await this.dispatchInternal(tabId, { name: "set_muted", input: { tabId, muted } })
      } catch {
        const activeId = this.registry.activeTab?.runtimeTabId
        if (activeId && activeId !== tabId) await this.dispatchInternal(activeId, { name: "set_muted", input: { tabId: activeId, muted } }).catch(() => undefined)
      }
    },
    openDevtools: async (tabId) => {
      try {
        await this.dispatchInternal(tabId, { name: "open_devtools", input: { tabId } })
      } catch {
        const activeId = this.registry.activeTab?.runtimeTabId
        if (activeId && activeId !== tabId) await this.dispatchInternal(activeId, { name: "open_devtools", input: { tabId: activeId } }).catch(() => undefined)
      }
    },
    hardReload: async (tabId) => {
      try {
        await this.dispatchInternal(tabId, { name: "hard_reload", input: { tabId } })
      } catch {
        const activeId = this.registry.activeTab?.runtimeTabId
        if (activeId && activeId !== tabId) await this.dispatchInternal(activeId, { name: "hard_reload", input: { tabId: activeId } }).catch(() => undefined)
      }
    },
    clearCookies: async (tabId) => {
      try {
        await this.dispatchInternal(tabId, { name: "clear_cookies", input: { tabId } })
      } catch {
        const activeId = this.registry.activeTab?.runtimeTabId
        if (activeId && activeId !== tabId) await this.dispatchInternal(activeId, { name: "clear_cookies", input: { tabId: activeId } }).catch(() => undefined)
      }
    },
    clearCache: async (tabId) => {
      try {
        await this.dispatchInternal(tabId, { name: "clear_cache", input: { tabId } })
      } catch {
        const activeId = this.registry.activeTab?.runtimeTabId
        if (activeId && activeId !== tabId) await this.dispatchInternal(activeId, { name: "clear_cache", input: { tabId: activeId } }).catch(() => undefined)
      }
    },
    setAppearance: async (appearance) => {
      await this.dispatchInternal(undefined, { name: "set_appearance", input: { appearance } })
    },
    listExtensions: async (tabId) => {
      try {
        const result = (await this.dispatchInternal(tabId, { name: "extensions_list", input: { tabId } })) as {
          extensions?: ExtensionInfo[]
        }
        return result.extensions ?? []
      } catch (error) {
        // stale tabId (agent session tab closed) must not crash the chrome menu
        const activeId = this.registry.activeTab?.runtimeTabId
        if (activeId && activeId !== tabId) {
          try {
            const fallback = (await this.dispatchInternal(activeId, { name: "extensions_list", input: { tabId: activeId } })) as {
              extensions?: ExtensionInfo[]
            }
            return fallback.extensions ?? []
          } catch {
            return []
          }
        }
        return []
      }
    },
    setExtensionEnabled: async (tabId, extensionId, enabled) => {
      await this.dispatchInternal(
        tabId,
        { name: "extension_set_enabled", input: { tabId, extensionId, enabled } },
      )
    },
    startAnnotation: (tabId) => {
      // Logical records survive renderer detach by design. Annotation is a
      // presentation operation, so never hand a detached/destroyed WebContents
      // to the controller merely because its logical record still exists.
      const tab = this.registry.requireTab(tabId)
      if (!tab) return Promise.resolve(null)
      // Starting an annotation session is the human taking control of this tab.
      // Bump the epoch so any in-flight agent automation on it aborts
      // immediately, and pin the controller to human for the session.
      this.visualWebview.cancel(tabId, "Human took control of the browser tab")
      this.arbiter.acquireHumanControl(tabId)
      tab.controller = this.arbiter.controller(tabId)
      this.registry.sync(tabId)
      return this.annotation.start(tabId, tab.webContents, tab.colorScheme, {
        generation: tab.generation,
        webContentsId: tab.webContentsId ?? tab.webContents.id,
        getCurrentGeneration: (id) => this.registry.get(id)?.generation,
        getCurrentViewport: (id) => {
          const v = this.registry.get(id)?.viewport
          return v ? { width: v.width, height: v.height } : undefined
        },
      })
    },
    cancelAnnotation: (tabId) => {
      this.annotation.cancel(tabId)
      // Release the human control taken for the session (the arbiter opened it
      // on start; release unconditionally rather than via setControllerFor,
      // which would refuse to clobber a human window). A newer live-input
      // preemption window would re-pin it on the next human input anyway.
      this.arbiter.releaseHumanControl(tabId)
      const tab = this.registry.get(tabId)
      if (tab) {
        tab.controller = this.arbiter.controller(tabId)
        this.registry.sync(tabId)
      }
    },
    visualHistory: async (context, input = {}) =>
      this.visual.history(this.visualRendererContext(context, input.timeoutMs ?? 10_000), input),
    visualArtifact: async (context, input) =>
      this.visual.artifact(this.visualRendererContext(context, input.timeoutMs ?? 10_000), input),
    visualArtifactPreview: async (context, input) => {
      const preview = await this.visual.artifactPreview(this.visualRendererContext(context, input.timeoutMs ?? 15_000), input)
      return preview ? { descriptor: preview.descriptor, bytes: new Uint8Array(preview.bytes), sha256: preview.sha256 } : null
    },
    visualApproveRun: async (context, runId, expected) =>
      this.visual.approveRun(this.visualRendererContext(context, 15_000), runId, expected),
  }
  /** User-authority close (D9): preempt the arbiter + detach the CDP session so
   * an in-flight agent op aborts (never hangs), then destroy and emit tab.closed. */
  private closeTabInternal(tabId: string): string[] {
    const tab = this.registry.get(tabId)
    if (!tab) {
      const lifecycle = this.tabLifecycle.snapshot(tabId)
      if (!lifecycle || !this.tabLifecycle.beginClose(tabId, lifecycle.generation)) return []
      this.operations.cancelPendingOpen(tabId)
      this.pendingActivation.delete(tabId)
      this.tabLifecycle.finishClose(tabId, lifecycle.generation)
      this.options.broadcast("browser-tab-close", { tabId })
      this.host.emitHostEvent({ type: "tab.closed", tabId, timestamp: new Date().toISOString() })
      return [tabId]
    }
    if (!this.tabLifecycle.beginClose(tabId, tab.lifecycleGeneration)) return []
    this.arbiter.preempt(tabId)
    this.sessions.detach(tab.webContentsId ?? -1).catch(() => undefined)
    this.pendingActivation.delete(tabId)
    this.annotation.cancel(tabId)
    this.visualWebview.cancel(tabId, "Browser tab closed by user")
    this.registry.remove(tabId)
    this.tabLifecycle.finishClose(tabId, tab.lifecycleGeneration)
    this.host.emitHostEvent({ type: "tab.closed", tabId, timestamp: new Date().toISOString() })
    this.options.broadcast("browser-tab-close", { tabId })
    return [tabId]
  }
  private requestTabPresentation(request: { tabId: string; url: string; activate?: boolean; newTab?: boolean }): number {
    const lifecycleGeneration = this.tabLifecycle.request(request.tabId)
    this.options.broadcast("browser-tab-request", { ...request, lifecycleGeneration })
    return lifecycleGeneration
  }
  private expireTabRequest(tabId: string, lifecycleGeneration: number): void {
    if (!this.tabLifecycle.beginClose(tabId, lifecycleGeneration)) return
    this.pendingActivation.delete(tabId)
    const tab = this.registry.get(tabId)
    if (tab?.webContentsId != null) this.sessions.detach(tab.webContentsId).catch(() => undefined)
    this.annotation.cancel(tabId)
    this.registry.remove(tabId)
    this.tabLifecycle.finishClose(tabId, lifecycleGeneration)
    this.options.broadcast("browser-tab-close", { tabId })
    this.host.emitHostEvent({ type: "tab.closed", tabId, timestamp: new Date().toISOString() })
  }
  private closeTabs(tabIds: readonly string[]): string[] {
    const closed: string[] = []
    for (const tabId of tabIds) closed.push(...this.closeTabInternal(tabId))
    return closed
  }
  private scheduleGuestStateEvent(tab: RendererGuestTabState): void {
    const existing = this.guestStateEventTimers.get(tab.tabId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.guestStateEventTimers.delete(tab.tabId)
      const { lifecycleGeneration: _lifecycleGeneration, ...wireTab } = tab
      this.host.emitHostEvent({ type: "guest.stateChanged", tab: wireTab, timestamp: new Date().toISOString() })
    }, GUEST_STATE_EVENT_DEBOUNCE_MS)
    timer.unref?.()
    this.guestStateEventTimers.set(tab.tabId, timer)
  }
}
/** Absolute path of the browser-guest preload bundle (electron-vite "preview" input). */
export const resolveGuestPreloadPath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "../preload/preview.js")
