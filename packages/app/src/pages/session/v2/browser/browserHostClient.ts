// ─── THE single window.api.browser client module (app bundle) ─────────────────
// Every call to the browser host goes through this module — nothing else in the
// app touches window.api.browser. The engine's preload surface (desktop
// BrowserAPI) is mirrored locally below; this module translates it into the
// app's own shapes so components never see the wire. The engine lane's final
// surface (premium feeds: snapshots, action timeline, navigation ops) lands
// here in exactly one place.
//
// The engine's tab identity IS the runtime identity: `openTab` allocates a
// uuid, the engine broadcasts it back via `onTabRequest`, the renderer mounts
// a <webview> and registers it under that same id.
//
// Desktop-only: in the plain web app `window.api` is absent and the client
// stays in the disconnected state — components render empty states.

import { createSignal } from "solid-js"
import { browserActionStore } from "./browserActionStore"
import { browserPointerStore } from "./browserPointerStore"
import { browserSnapshotStore } from "./browserSnapshotStore"
import { browserSurfaceStore } from "./browserSurfaceStore"
import type { BrowserController, BrowserGuestState, BrowserHostState } from "./types"

export type BrowserAppearance = "light" | "dark" | "system"

// ── local mirror of the engine wire shapes (desktop contracts.ts) ─────────────

export interface GuestTabState {
  tabId: string
  url: string
  title: string
  readyState: "Idle" | "Loading" | "Success" | "LoadFailed"
  controller: BrowserController
  zoomFactor: number
  attached: boolean
}

export interface BrowserState {
  host: { connected: boolean; hostEpoch: number | null }
  guest: { attached: boolean; activeTabId: string | null; url: string | null }
  tabs: GuestTabState[]
}

export interface PreviewPointerEvent {
  tabId: string
  phase: "move" | "click"
  x: number
  y: number
  sequence: number
  createdAt: string
}

export interface BrowserTabRequest {
  tabId: string
  url: string
  activate?: boolean
  newTab?: boolean
}

interface BrowserAPI {
  getState: () => Promise<BrowserState>
  openTab: (url: string, opts?: { activate?: boolean; newTab?: boolean }) => Promise<{ tabId: string }>
  activateTab: (tabId: string) => Promise<BrowserState>
  closeTab: (tabId: string) => Promise<{ closed: boolean }>
  registerWebview: (runtimeTabId: string, webContentsId: number) => Promise<{ ok: true; tabId: string }>
  unregisterWebview: (runtimeTabId: string) => Promise<{ ok: true }>
  getGuestPreloadPath: () => Promise<string>
  setSessionContext: (sessionId: string, opts?: { workspaceId?: string; directory?: string }) => Promise<void>
  onState: (cb: (tab: GuestTabState) => void) => () => void
  onTabRequest: (cb: (request: BrowserTabRequest) => void) => () => void
  onTabClose: (cb: (request: { tabId: string }) => void) => () => void
  onPointerEvent: (cb: (event: PreviewPointerEvent) => void) => () => void
  onHostState: (cb: (state: { connected: boolean }) => void) => () => void
}

const DISCONNECTED_STATE: BrowserHostState = {
  connected: false,
  hostEpoch: 0,
  activeTabId: null,
  guests: [],
}

const noop = () => {}

// The app runs inside the desktop renderer (webviewTag enabled) where preload
// exposes window.api.browser; in the plain web app it is undefined.
function rawBrowser(): BrowserAPI | undefined {
  const api = (window as unknown as { api?: { browser?: BrowserAPI } }).api
  return api?.browser
}

const [hostState, setHostState] = createSignal<BrowserHostState>(DISCONNECTED_STATE)
let initStarted = false

/** Map the engine's per-tab state onto the app guest shape. */
function mapGuestTab(tab: GuestTabState): BrowserGuestState {
  return {
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
    loading: tab.readyState === "Loading",
    canGoBack: false,
    canGoForward: false,
    zoomFactor: tab.zoomFactor,
    controller: tab.controller,
    crashed: tab.readyState === "LoadFailed",
  }
}

/** Apply one full host state snapshot (getState). */
function applyHostState(next: BrowserState) {
  const previous = hostState()
  const epochChanged = next.host.hostEpoch !== previous.hostEpoch
  setHostState({
    connected: next.host.connected,
    hostEpoch: next.host.hostEpoch ?? 0,
    activeTabId: next.guest.activeTabId,
    guests: next.tabs.map(mapGuestTab),
  })

  if (epochChanged) {
    // Snapshot/pointer stores are keyed by tabId; clear per live tab.
    for (const tab of next.tabs) {
      browserSnapshotStore.clear(tab.tabId)
      browserPointerStore.clear(tab.tabId)
    }
  }

  const alive = new Set(next.tabs.map((tab) => tab.tabId))
  for (const tabId of Object.keys(browserSurfaceStore.byTabId)) {
    if (!alive.has(tabId)) browserSurfaceStore.clear(tabId)
  }
}

/** Apply one per-tab state push (onState). */
function applyGuestTab(tab: GuestTabState) {
  const current = hostState()
  const guests = current.guests.filter((guest) => guest.tabId !== tab.tabId)
  setHostState({
    ...current,
    activeTabId: current.activeTabId ?? tab.tabId,
    guests: [...guests, mapGuestTab(tab)],
  })
}

/** Optimistically add a guest on tab request; the engine's browser-state push replaces it. */
function applyTabRequest(request: BrowserTabRequest) {
  const current = hostState()
  if (current.guests.some((guest) => guest.tabId === request.tabId)) return
  setHostState({
    ...current,
    activeTabId: request.activate === false ? current.activeTabId : request.tabId,
    guests: [
      ...current.guests,
      {
        tabId: request.tabId,
        url: request.url,
        title: "",
        loading: true,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
        controller: "none",
        crashed: false,
      },
    ],
  })
}

function applyTabClose(request: { tabId: string }) {
  const current = hostState()
  const guests = current.guests.filter((guest) => guest.tabId !== request.tabId)
  setHostState({
    ...current,
    activeTabId: current.activeTabId === request.tabId ? guests[0]?.tabId ?? null : current.activeTabId,
    guests,
  })
  browserSnapshotStore.clear(request.tabId)
  browserPointerStore.clear(request.tabId)
  browserSurfaceStore.clear(request.tabId)
}

const DISCONNECTED_GUEST: BrowserGuestState = {
  tabId: "",
  url: null,
  title: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  controller: "none",
  crashed: false,
}

export const browserHostClient = {
  /** Reactive host state (disconnected until the engine is wired). */
  get state() {
    return hostState
  },
  get guest() {
    return (tabId: string): BrowserGuestState => {
      const found = hostState().guests.find((guest) => guest.tabId === tabId)
      return found ?? { ...DISCONNECTED_GUEST, tabId }
    }
  },
  get controller() {
    return (tabId: string): BrowserController => browserHostClient.guest(tabId).controller
  },
  get zoomFactor() {
    return (tabId: string): number => browserHostClient.guest(tabId).zoomFactor
  },

  async init() {
    const api = rawBrowser()
    if (!api || initStarted) return
    initStarted = true
    const initial = await api.getState().catch(() => null)
    if (initial) applyHostState(initial)
    api.onState((tab) => applyGuestTab(tab))
    api.onHostState(({ connected }) => setHostState((current) => ({ ...current, connected })))
    api.onPointerEvent((event) => browserPointerStore.apply(event))
    // Premium feeds (snapshots/actions) land with the engine's final surface;
    // the stores stay empty until then and components render empty states.
  },

  /** Engine asks the app to mount a <webview> for a tab (also the panel-open trigger). */
  onTabRequest: (cb: (request: BrowserTabRequest) => void) => {
    const api = rawBrowser()
    if (!api) return noop
    return api.onTabRequest((request) => {
      applyTabRequest(request)
      cb(request)
    })
  },
  /** Engine asks the app to remove the <webview> for a closed tab. */
  onTabClose: (cb: (request: { tabId: string }) => void) => {
    const api = rawBrowser()
    if (!api) return noop
    return api.onTabClose((request) => {
      applyTabClose(request)
      cb(request)
    })
  },

  open: (input: { url: string; activate?: boolean; newTab?: boolean }) =>
    (rawBrowser()?.openTab(input.url, input) ?? Promise.reject(new Error("browser host unavailable"))).catch(
      () => ({ tabId: "" }),
    ),

  activate: async (tabId: string) => {
    const current = hostState()
    if (!current.guests.some((guest) => guest.tabId === tabId)) return { active: false }
    setHostState({ ...current, activeTabId: tabId })
    const next = await rawBrowser()?.activateTab(tabId).catch(() => null)
    if (next) applyHostState(next)
    return { active: true }
  },

  close: (tabId: string) => rawBrowser()?.closeTab(tabId) ?? Promise.resolve({ closed: false }),

  /** Draft no-ops: navigation flows through the engine's broker ops; not on the surface yet. */
  navigate: (_tabId: string, _url: string) => Promise.resolve(),
  goBack: (_tabId: string) => Promise.resolve(),
  goForward: (_tabId: string) => Promise.resolve(),
  reload: (_tabId: string) => Promise.resolve(),
  stop: (_tabId: string) => Promise.resolve(),
  resize: (_tabId: string, _width: number, _height: number) => Promise.resolve(),
  setAppearance: (_appearance: BrowserAppearance) => Promise.resolve(),
  toggleDevtools: (_tabId: string) => Promise.resolve(),

  registerWebview: (runtimeTabId: string, webContentsId: number) =>
    rawBrowser()?.registerWebview(runtimeTabId, webContentsId) ??
    Promise.resolve({ ok: true as const, tabId: runtimeTabId }),
  unregisterWebview: (runtimeTabId: string) =>
    rawBrowser()?.unregisterWebview(runtimeTabId) ?? Promise.resolve({ ok: true as const }),
  getGuestPreloadPath: () => rawBrowser()?.getGuestPreloadPath() ?? Promise.resolve(""),
  setSessionContext: (sessionId: string, opts?: { workspaceId?: string; directory?: string }) =>
    rawBrowser()?.setSessionContext(sessionId, opts) ?? Promise.resolve(),
}

export { noop }
