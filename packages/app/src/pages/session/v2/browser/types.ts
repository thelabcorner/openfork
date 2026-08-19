// Renderer-side browser types. Mirrors the engine's wire contracts
// (packages/desktop/src/main/browser/contracts.ts) for the shapes that cross
// into the renderer, plus the presentation-only types that live entirely in
// the renderer (viewport settings, presented content, snapshot badges).

export type BrowserController = "human" | "agent" | "none"

/** A tab's owner — user-owned or owned by one agent session (two agents never
 * share a tab; the user may always reassign via the context menu). */
export type HostOwner = { kind: "user" } | { kind: "agent"; sessionId: string }

/** Agent pointer event pushed from the main process (cursor overlay feed). */
export interface BrowserPointerEvent {
  tabId: string
  phase: "move" | "click"
  x: number
  y: number
  sequence: number
  createdAt: string
}

export type ViewportMode = "fill" | "freeform" | "preset"

export type DeviceOrientation = "portrait" | "landscape"

/**
 * Logical guest viewport in CSS px. `width/height` are the guest's page size
 * (the CSS breakpoint the page renders at); the presentation layer maps them
 * to screen px through zoomFactor * scale. `null` dims mean "derive from the
 * panel rect" (fill mode).
 */
export interface ViewportSetting {
  mode: ViewportMode
  width: number | null
  height: number | null
  presetId: string | null
  orientation: DeviceOrientation
}

export interface PanelRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The webview's presentation rect inside the panel (same DOM space the cursor
 * overlay lives in). Pushed on scroll + rAF by the webview wrapper; consumed
 * by the cursor, badge overlay, and any pixel-aligned chrome.
 */
export interface PresentedContent {
  x: number
  y: number
  width: number
  height: number
  scale: number
  scrollLeft: number
  scrollTop: number
}

/** Per-tab guest state as surfaced by the host (draft; engine adjusts). */
export interface BrowserGuestState {
  tabId: string
  url: string | null
  title: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoomFactor: number
  controller: BrowserController
  crashed: boolean
  owner: HostOwner
  muted: boolean
}

/** Snapshot badge for one interactive element (frozen per snapshotVersion). */
export interface BrowserElementBadge {
  ref: string
  role: string
  name: string
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  enabled: boolean
  checked?: boolean
  selector?: string
  selectorConfidence?: "high" | "medium" | "low"
}

export interface SnapshotSummary {
  interactiveCount: number
  formCount: number
  consoleErrors: number
  failedRequests: number
}

export interface SnapshotData {
  tabId: string
  snapshotVersion: number
  url: string
  elements: BrowserElementBadge[]
  summary: SnapshotSummary
}

export type ActionStatus = "running" | "succeeded" | "failed" | "interrupted"

/** One entry in the agent action timeline (bounded feed). */
export interface BrowserActionEvent {
  tabId: string
  actionId: string
  op: string
  target?: string
  status: ActionStatus
  startedAt: number
  endedAt?: number
  elapsedMs?: number
  error?: string
}

/** Host state snapshot the panel renders from (draft; engine adjusts). */
export interface BrowserHostState {
  connected: boolean
  hostEpoch: number
  activeTabId: string | null
  appearance: "light" | "dark" | "system"
  guests: BrowserGuestState[]
}

// Hard bounds for a fixed (freeform/preset) viewport's logical CSS size —
// mirrors Chrome DevTools' own device-toolbar limits.
export const VIEWPORT_MIN_SIZE = 240
export const VIEWPORT_MAX_SIZE = 3840
export const VIEWPORT_MAX_AREA = VIEWPORT_MAX_SIZE * 2160
export const VIEWPORT_PRESET_SIZE = 320

/** Renderer key for a viewport setting (data attributes / store lookups). */
export function browserViewportSettingKey(setting: ViewportSetting): string {
  if (setting.mode === "fill") return "fill"
  return `${setting.mode}:${setting.width ?? 0}x${setting.height ?? 0}:${setting.orientation}`
}
