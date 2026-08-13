// BrowserEngine facade: composes the guest registry, control arbitration, CDP
// control sessions, operations, and the host HTTP bridge; owns the
// renderer-facing IPC surface (window.api.browser) and window broadcasts.

import { BrowserWindow } from "electron"
import type { WebContents } from "electron"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { BrowserOperations } from "./operations"
import { GuestRegistry } from "./guest"
import { ControlArbiter } from "./arbitration"
import { ControlSessionManager } from "./control-session"
import { BrowserHost } from "./host"
import {
  type BrowserState,
  type HostCapabilities,
  type HumanInputSignal,
} from "./contracts"

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
  registerWebview: (runtimeTabId: string, webContentsId: number, generation?: number) => { ok: true }
  unregisterWebview: (runtimeTabId: string) => { ok: true }
  humanInput: (runtimeTabId: string, signal: unknown) => void
  setSessionContext: (sessionId: string, opts?: { workspaceId?: string; directory?: string }) => void
}

export class BrowserEngine {
  readonly arbiter = new ControlArbiter()
  readonly sessions = new ControlSessionManager({ arbiter: this.arbiter })
  readonly registry: GuestRegistry
  readonly operations: BrowserOperations
  readonly host: BrowserHost
  private readonly options: BrowserEngineOptions
  private readonly hostId = randomUUID()
  private readonly hostEpoch = 1
  private readonly pendingActivation = new Set<string>()
  private sessionContext: { sessionId: string; workspaceId?: string; directory?: string } = { sessionId: "" }
  private started = false

  constructor(options: BrowserEngineOptions) {
    this.options = options
    const capabilities: HostCapabilities = {
      maxSnapshotBytes: 256 * 1024,
      maxResultBytes: 64 * 1024,
      supportedAppearances: ["system", "light", "dark"],
      supportsRecording: true,
      cdp: true,
    }
    this.registry = new GuestRegistry({
      windowId: options.windowId,
      arbiter: this.arbiter,
      isTrustedHost: (wc) => BrowserWindow.fromWebContents(wc) !== null,
      getMainWindowWebContents: () => options.getLastFocusedWebContents(),
      onStateChange: (tab) => {
        if (!tab) return
        this.options.broadcast("browser-state", tab)
        this.host.emitHostEvent({ type: "guest.stateChanged", tab, timestamp: new Date().toISOString() })
      },
      onGuestGone: (runtimeTabId, webContentsId) => {
        this.arbiter.reset(runtimeTabId)
        this.sessions.detach(webContentsId).catch(() => undefined)
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
      recordingDirectory: options.recordingDirectory,
      maxResultBytes: capabilities.maxResultBytes,
      onTabRequest: (request) => this.options.broadcast("browser-tab-request", request),
      onTabClose: (tabId) => this.options.broadcast("browser-tab-close", { tabId }),
      onPointerEvent: (event) => this.options.broadcast("browser-pointer-event", event),
    })
    this.host = new BrowserHost({
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      windowId: options.windowId,
      capabilities,
      sidecarProvider: options.sidecarProvider,
      getSessionContext: () => this.sessionContext,
      getGuestSnapshot: () => {
        const active = this.registry.activeTab
        return {
          attached: this.registry.size > 0,
          activeTabId: active?.runtimeTabId ?? null,
          url: active?.url ?? null,
        }
      },
      dispatch: (tabId, operation) => this.operations.dispatch(tabId, operation),
      onConnectedChange: (connected) => {
        this.options.broadcast("browser-host-state", { connected })
        this.options.logger?.log("browser host connected", { connected })
      },
      logger: options.logger,
    })
  }

  /** Human input (guest preload ipc or renderer-forwarded): preemption decision + controller lifecycle. */
  private handleHumanInput(runtimeTabId: string, signal: unknown): void {
    void this.arbiter.handleHumanInput(runtimeTabId, signal as HumanInputSignal).then(() => {
      const tab = this.registry.get(runtimeTabId)
      if (!tab) return
      tab.controller = this.arbiter.controller(runtimeTabId)
      this.registry.sync(runtimeTabId)
    })
  }

  /** Called after the app server is ready: start the host bridge. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.host.start()
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.registry.teardown()
    await this.sessions.detachAll()
    await this.host.stop()
  }

  get isHostConnected(): boolean {
    return this.host.isConnected
  }

  getState(): BrowserState {
    const tabs = this.registry.list().map((record) => this.registry.tabState(record))
    const active = this.registry.activeTab
    return {
      host: {
        connected: this.host.isConnected,
        hostId: this.hostId,
        hostEpoch: this.hostEpoch,
        connectionId: this.host.callbackUrlToken,
        windowId: this.options.windowId,
        capabilities: {
          maxSnapshotBytes: 256 * 1024,
          maxResultBytes: 64 * 1024,
          supportedAppearances: ["system", "light", "dark"],
          supportsRecording: true,
          cdp: true,
        },
      },
      guest: {
        attached: this.registry.size > 0,
        activeTabId: active?.runtimeTabId ?? null,
        url: active?.url ?? null,
        controller: active ? this.arbiter.controller(active.runtimeTabId) : "none",
        zoomFactor: active?.zoomFactor ?? 1,
      },
      tabs,
    }
  }

  /** Renderer-facing API (window.api.browser). */
  readonly api: BrowserRenderApi = {
    getState: () => this.getState(),
    openTab: (url, opts) => {
      const tabId = randomUUID()
      if (opts?.activate ?? true) this.pendingActivation.add(tabId)
      this.options.broadcast("browser-tab-request", {
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
    closeTab: (tabId) => {
      const tab = this.registry.get(tabId)
      if (!tab) return { closed: false }
      this.pendingActivation.delete(tabId)
      this.registry.unregister(tabId)
      this.options.broadcast("browser-tab-close", { tabId })
      return { closed: true }
    },
    registerWebview: (runtimeTabId, webContentsId, generation = 0) => {
      const record = this.registry.register(runtimeTabId, webContentsId, generation)
      if (this.pendingActivation.delete(runtimeTabId)) this.registry.activate(runtimeTabId)
      this.operations.resolveOpen(runtimeTabId, record)
      this.options.broadcast("browser-state", this.registry.tabState(record))
      return { ok: true }
    },
    unregisterWebview: (runtimeTabId) => {
      this.registry.unregister(runtimeTabId)
      return { ok: true }
    },
    humanInput: (runtimeTabId, signal) => {
      this.handleHumanInput(runtimeTabId, signal)
    },
    setSessionContext: (sessionId, opts) => {
      this.sessionContext = { sessionId, workspaceId: opts?.workspaceId, directory: opts?.directory }
      this.host.reRegister()
    },
  }
}

/** Absolute path of the browser-guest preload bundle (electron-vite "preview" input). */
export const resolveGuestPreloadPath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "../preload/preview.js")
