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
import type { DirectorySDK } from "@/context/sdk"
import type { DirectorySync } from "@/context/sync"
import type { PromptStore } from "@/context/prompt"
import type { BrowserAppearance, BrowserController, BrowserGuestState, BrowserHostState } from "./types"

export type { BrowserAppearance }

// ── local mirror of the engine wire shapes (desktop contracts.ts) ─────────────

export type HostOwner = { kind: "user" } | { kind: "agent"; sessionId: string }

export interface GuestTabState {
  tabId: string
  url: string
  title: string
  readyState: "Idle" | "Loading" | "Success" | "LoadFailed"
  controller: BrowserController
  zoomFactor: number
  attached: boolean
  owner: HostOwner
  active: boolean
  muted: boolean
}

export interface BrowserState {
  host: { connected: boolean; hostEpoch: number | null }
  guest: { attached: boolean; activeTabId: string | null; url: string | null }
  appearance: BrowserAppearance
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

export interface BrowserAnnotationSourceFrame {
  file: string
  line?: number
  column?: number
}
export interface BrowserAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}
export interface BrowserAnnotationElementContext {
  id: string
  tagName: string
  selector: string | null
  htmlPreview: string
  componentName: string | null
  source: BrowserAnnotationSourceFrame | null
  styles: string
  rect: BrowserAnnotationRect
}
export interface BrowserAnnotationRegion {
  id: string
  rect: BrowserAnnotationRect
}
export interface BrowserAnnotationStroke {
  id: string
  color: string
  width: number
  points: Array<{ x: number; y: number }>
  bounds: BrowserAnnotationRect
}
export interface BrowserAnnotationStyleChange {
  targetId: string
  selector: string | null
  property: string
  previousValue: string | null
  value: string
}
export interface BrowserAnnotationResult {
  id: string
  pageUrl: string
  pageTitle: string | null
  comment: string
  elements: BrowserAnnotationElementContext[]
  regions: BrowserAnnotationRegion[]
  strokes: BrowserAnnotationStroke[]
  styleChanges: BrowserAnnotationStyleChange[]
  screenshot: { mime: "image/png"; dataUrl: string; width: number; height: number } | null
  submission: "attach" | "send"
  createdAt: string
}

interface BrowserAPI {
  getState: () => Promise<BrowserState>
  openTab: (url: string, opts?: { activate?: boolean; newTab?: boolean }) => Promise<{ tabId: string }>
  activateTab: (tabId: string) => Promise<BrowserState>
  closeTab: (tabId: string) => Promise<{ closed: boolean }>
  registerWebview: (runtimeTabId: string, webContentsId: number, generation?: number) => Promise<{ ok: true; tabId: string }>
  unregisterWebview: (runtimeTabId: string, webContentsId?: number, generation?: number) => Promise<{ ok: true }>
  getGuestPreloadPath: () => Promise<string>
  assignTab: (tabId: string, owner: HostOwner) => Promise<{ tabId: string; owner: HostOwner }>
  closeRange: (tabId: string, mode: "left" | "right" | "others" | "all") => Promise<{ closed: string[] }>
  refreshTab: (tabId: string) => Promise<void>
  duplicateTab: (tabId: string) => Promise<{ tabId: string; url: string }>
  setTabMuted: (tabId: string, muted: boolean) => Promise<void>
  openDevtools: (tabId: string) => Promise<void>
  hardReload: (tabId: string) => Promise<void>
  clearCookies: (tabId: string) => Promise<void>
  clearCache: (tabId: string) => Promise<void>
  setAppearance: (appearance: BrowserAppearance) => Promise<void>
  listExtensions: (tabId: string) => Promise<Array<{ id: string; name: string; version: string; enabled: boolean }>>
  setExtensionEnabled: (tabId: string, extensionId: string, enabled: boolean) => Promise<void>
  onState: (cb: (tab: GuestTabState) => void) => () => void
  onTabRequest: (cb: (request: BrowserTabRequest) => void) => () => void
  onTabClose: (cb: (request: { tabId: string }) => void) => () => void
  onPointerEvent: (cb: (event: PreviewPointerEvent) => void) => () => void
  onHostState: (cb: (state: { connected: boolean }) => void) => () => void
  startAnnotation: (tabId: string) => Promise<BrowserAnnotationResult | null>
  cancelAnnotation: (tabId: string) => Promise<void>
}

const DISCONNECTED_STATE: BrowserHostState = {
  connected: false,
  hostEpoch: 0,
  activeTabId: null,
  appearance: "system",
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

/** Annotation send/attach target, populated by the session page while a chat
 * session is open. The browser pane lives in the app shell (above the routes),
 * so it cannot consume the session-scoped SDK/Prompt/Local/Sync providers
 * directly — the page bridges the pieces it needs here. Null on home /
 * new-session, where annotation is unavailable. */
export type BrowserAnnotationTarget = {
  sessionID: string
  directory: string
  agent: string
  model: { providerID: string; modelID: string; variant?: string | null }
  api: DirectorySDK["api"]["session"]
  sync: DirectorySync
  capture: () => PromptStore
}

const [annotationTarget, setAnnotationTarget] = createSignal<BrowserAnnotationTarget | null>(null)

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
    owner: tab.owner,
    muted: tab.muted,
  }
}

/**
 * Solid's <For> in browser-panel-v2.tsx reconciles by item reference, not by
 * tabId — a "changed" guest object mounts/unmounts HostedBrowserWebview (a new
 * <webview> DOM node, i.e. a visible reload). Reuse the previous object
 * reference whenever the mapped fields are unchanged so unrelated state
 * pushes don't remount a tab's webview.
 */
function sameGuest(a: BrowserGuestState, b: BrowserGuestState): boolean {
  const sameOwner = () => {
    if (a.owner?.kind !== b.owner?.kind) return false
    if (a.owner?.kind === "agent" && b.owner?.kind === "agent") return a.owner.sessionId === b.owner.sessionId
    return true
  }
  return (
    a.tabId === b.tabId &&
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.zoomFactor === b.zoomFactor &&
    a.controller === b.controller &&
    a.crashed === b.crashed &&
    sameOwner() &&
    a.muted === b.muted
  )
}

/** Apply one full host state snapshot (getState). */
function applyHostState(next: BrowserState) {
  const previous = hostState()
  const epochChanged = next.host.hostEpoch !== previous.hostEpoch
  const previousByTabId = new Map(previous.guests.map((guest) => [guest.tabId, guest]))
  const guests = next.tabs.map((tab) => {
    const mapped = mapGuestTab(tab)
    const existing = previousByTabId.get(tab.tabId)
    return existing && sameGuest(existing, mapped) ? existing : mapped
  })
  setHostState({
    connected: next.host.connected,
    hostEpoch: next.host.hostEpoch ?? 0,
    activeTabId: next.guest.activeTabId,
    appearance: next.appearance ?? "system",
    guests,
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
  const index = current.guests.findIndex((guest) => guest.tabId === tab.tabId)
  const mapped = mapGuestTab(tab)

  if (index === -1) {
    setHostState({
      ...current,
      activeTabId: current.activeTabId ?? tab.tabId,
      guests: [...current.guests, mapped],
    })
    return
  }

  // No-op pushes (e.g. duplicate readyState broadcasts) must not replace the
  // guest's object reference — see sameGuest() above.
  if (sameGuest(current.guests[index], mapped)) return

  const guests = current.guests.slice()
  guests[index] = mapped
  setHostState({ ...current, guests })
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
        owner: { kind: "user" },
        muted: false,
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
  owner: { kind: "user" },
  muted: false,
}

export const browserHostClient = {
  /** Reactive host state (disconnected until the engine is wired). */
  get state() {
    return hostState
  },
  get annotationTarget() {
    return annotationTarget
  },
  setAnnotationTarget(target: BrowserAnnotationTarget | null) {
    setAnnotationTarget(target)
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
    await browserHostClient.refreshState()
    api.onState((tab) => applyGuestTab(tab))
    api.onHostState(({ connected }) => setHostState((current) => ({ ...current, connected })))
    api.onPointerEvent((event) => browserPointerStore.apply(event))
    // Premium feeds (snapshots/actions) land with the engine's final surface;
    // the stores stay empty until then and components render empty states.
  },

  /** Re-fetch the full host state (initial load and after host-side mutations
   * like appearance changes that only broadcast per-tab deltas). */
  async refreshState() {
    const initial = await rawBrowser()?.getState().catch(() => null)
    if (initial) applyHostState(initial)
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

  /** User-initiated ownership change (D7) — assign/reassign/unassign to ANY owner. */
  assignTab: (tabId: string, owner: HostOwner) =>
    rawBrowser()?.assignTab(tabId, owner) ?? Promise.resolve({ tabId, owner }),
  /** User close-range (D8): close tabs left/right/others/all of `tabId`. */
  closeRange: (tabId: string, mode: "left" | "right" | "others" | "all") =>
    rawBrowser()?.closeRange(tabId, mode) ?? Promise.resolve({ closed: [] }),
  /** Host-level webview reload (D8a). */
  refreshTab: (tabId: string) => (rawBrowser()?.refreshTab(tabId) ?? Promise.resolve()).catch(() => undefined),
  /** Clone the tab with the same URL; the duplicate INHERITS the source owner (D8). */
  duplicateTab: (tabId: string) =>
    (rawBrowser()?.duplicateTab(tabId) ?? Promise.resolve({ tabId, url: "" })).catch(() => ({ tabId, url: "" })),
  /** Per-tab audio mute toggle (D8b). */
  setTabMuted: (tabId: string, muted: boolean) =>
    (rawBrowser()?.setTabMuted(tabId, muted) ?? Promise.resolve()).catch(() => undefined),

  /** Chrome chrome ops (D10) — all host-level, tab-scoped. Catch stale-tab rejections so a removed agent tab never crashes the chrome menu. */
  openDevtools: (tabId: string) => (rawBrowser()?.openDevtools(tabId) ?? Promise.resolve()).catch(() => undefined),
  hardReload: (tabId: string) => (rawBrowser()?.hardReload(tabId) ?? Promise.resolve()).catch(() => undefined),
  clearCookies: (tabId: string) => (rawBrowser()?.clearCookies(tabId) ?? Promise.resolve()).catch(() => undefined),
  clearCache: (tabId: string) => (rawBrowser()?.clearCache(tabId) ?? Promise.resolve()).catch(() => undefined),
  setAppearance: (appearance: BrowserAppearance) => (rawBrowser()?.setAppearance(appearance) ?? Promise.resolve()).catch(() => undefined),
  listExtensions: (tabId: string) =>
    (rawBrowser()?.listExtensions(tabId) ?? Promise.resolve([])).catch(() => []),
  setExtensionEnabled: (tabId: string, extensionId: string, enabled: boolean) =>
    (rawBrowser()?.setExtensionEnabled(tabId, extensionId, enabled) ?? Promise.resolve()).catch(() => undefined),

  /** Draft no-ops: navigation flows through the engine's broker ops; not on the surface yet. */
  navigate: (_tabId: string, _url: string) => Promise.resolve(),
  goBack: (_tabId: string) => Promise.resolve(),
  goForward: (_tabId: string) => Promise.resolve(),
  reload: (tabId: string) => browserHostClient.refreshTab(tabId),
  stop: (_tabId: string) => Promise.resolve(),
  resize: (_tabId: string, _width: number, _height: number) => Promise.resolve(),
  toggleDevtools: (tabId: string) => browserHostClient.openDevtools(tabId),

  registerWebview: (runtimeTabId: string, webContentsId: number, generation?: number) =>
    rawBrowser()?.registerWebview(runtimeTabId, webContentsId, generation) ??
    Promise.resolve({ ok: true as const, tabId: runtimeTabId }),
  unregisterWebview: (runtimeTabId: string, webContentsId?: number, generation?: number) =>
    rawBrowser()?.unregisterWebview(runtimeTabId, webContentsId, generation) ?? Promise.resolve({ ok: true as const }),
  getGuestPreloadPath: () => rawBrowser()?.getGuestPreloadPath() ?? Promise.resolve(""),

  startAnnotation: (tabId: string) => rawBrowser()?.startAnnotation(tabId) ?? Promise.resolve(null),
  cancelAnnotation: (tabId: string) => rawBrowser()?.cancelAnnotation(tabId) ?? Promise.resolve(),
}

export { noop }
