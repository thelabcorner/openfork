// Canonical desktop-side browser contract.
//
// CANON (coordinator adjudication, 2026-08-13): wire uses the `{name}` operation
// discriminator, NUMBER protocolVersion/hostEpoch, and callbackToken inside
// HostRegistration — mirroring the authoritative protocol group
// (packages/protocol/src/groups/browser.ts, browser-contract lane). This file
// is the single source of truth for the DESKTOP side; types.ts mirrors it.
// Premium agent-UX shapes (refs, selector confidence, element state, React
// profiler ops) come from decisions/browser-premium-agent-ux v1.
//
// SEAM: when packages/desktop declares "@opencode-ai/protocol" as a workspace
// dep, replace the local wire shapes with `export type { ... } from
// "@opencode-ai/protocol/groups/browser"` and keep only the engine-internal
// types here. Field names must stay byte-identical to the protocol group.

// --- wire constants (must stay in sync with the protocol group) ---------------

export const BROWSER_PROTOCOL_VERSION = 1
export const BROKER_REQUEST_PATH = "/v1/browser/request"
export const BROKER_ABORT_PATH = "/v1/browser/request/:requestId/abort"

// --- engine constants (partitions, pacing, caps) ------------------------------

export const BROWSER_PARTITION = "persist:opencode-browser-v1"
export const HUMAN_INPUT_CHANNEL = "preview:human-input"

export const AGENT_CURSOR_MOVE_MS = 160
export const AGENT_CURSOR_CLICK_LEAD_MS = 40
export const HUMAN_PREEMPT_WINDOW_MS = 750
export const EXPECTED_INPUT_TTL_MS = 1_000
export const POINTER_TOLERANCE_PX = 1

export const MAX_EVALUATION_BYTES = 64_000
export const MAX_VISIBLE_TEXT_LENGTH = 20_000
export const MAX_INTERACTIVE_ELEMENTS = 200
export const MAX_SCREENSHOT_WIDTH = 1280
export const DIAGNOSTIC_BUFFER_LIMIT = 200
export const ACTION_TIMELINE_CAP = 200

export const RECORDING_FRAME_INTERVAL_MS = Math.ceil(1000 / 12)
export const RECORDING_JPEG_QUALITY = 80
export const RECORDING_MAX_WIDTH = 1280
export const RECORDING_DEFAULT_MAX_DURATION_MS = 60_000
export const RECORDING_DEFAULT_MAX_BYTES = 25 * 1024 * 1024

export const WAIT_FOR_POLL_MS = 100
export const OPEN_ATTACH_TIMEOUT_MS = 15_000
export const NAVIGATE_TIMEOUT_MS = 30_000

export const PROFILER_MAX_COMPONENTS = 100
export const PROFILER_MAX_FIBERS_PER_COMMIT = 2_000
export const PROFILER_MAX_COMMITS = 200
export const PROFILER_MAX_PROPS = 5

// --- error tags (wire; 16 = 14 base + 2 premium) ------------------------------

export type BrowserErrorTag =
  | "BrowserHostUnavailable"
  | "BrowserProtocolMismatch"
  | "BrowserTabNotFound"
  | "BrowserGuestCrashed"
  | "BrowserControlInterrupted"
  | "BrowserInvalidSelector"
  | "BrowserTargetNotFound"
  | "BrowserTimeout"
  | "BrowserResultTooLarge"
  | "BrowserDebuggerConflict"
  | "BrowserUnsupportedOperation"
  | "BrowserPermissionDenied"
  | "BrowserNotAttached"
  | "BrowserOperationFailed"
  | "BrowserStaleRefError"
  | "BrowserNotAReactAppError"

export interface BrokerResponseErrorBody {
  tag: BrowserErrorTag
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

// --- wire: host hello / registration / events (protocol group shapes) ---------

export interface HostCapabilities {
  maxSnapshotBytes: number
  maxResultBytes: number
  supportedAppearances: readonly Appearance[]
  supportsRecording: boolean
  cdp: true
}

export interface HostGuestState {
  attached: boolean
  activeTabId: string | null
  url: string | null
}

export interface HostHello {
  protocolVersion: number
  hostId: string
  hostEpoch: number
  connectionId: string
  windowId: string
  capabilities: HostCapabilities
  guest: HostGuestState
}

/** Payload the host POSTs to the sidecar hello endpoint (HostHello + stickiness context + reachability). */
export interface HostRegistration extends HostHello {
  sessionId: string
  workspaceId?: string
  directory?: string
  callbackUrl: string
  callbackToken: string
}

export interface HostHelloReply {
  data: {
    accepted: boolean
    brokerProtocolVersion: number
    hostId: string
    replacement?: boolean
  }
}

/** Wire guest-tab state as defined by the protocol group (used in broadcasts/HostEvent). */
export interface WireGuestTabState {
  tabId: string
  url: string
  title: string
  readyState: "Idle" | "Loading" | "Success" | "LoadFailed"
  controller: BrowserController
  zoomFactor: number
  attached: boolean
}

export type HostEvent =
  | { type: "guest.crashed"; tabId: string; timestamp: string }
  | { type: "guest.stateChanged"; tab: WireGuestTabState; timestamp: string }
  | { type: "host.stopping"; timestamp: string }
  | { type: "request.aborted"; requestId: string; timestamp: string }

// --- wire: broker envelope ----------------------------------------------------

export interface BrokerRequest {
  requestId: string
  sessionId: string
  workspaceId?: string
  directory?: string
  messageId: string
  toolCallId?: string
  tabId?: string
  operation: BrowserOperation
  input: unknown
  timeoutMs: number
}

export type BrokerResponse =
  | {
      ok: true
      requestId: string
      result: Record<string, unknown>
      elapsedMs: number
      snapshotAfter?: unknown
    }
  | {
      ok: false
      requestId: string
      error: BrokerResponseErrorBody
      elapsedMs: number
    }

// --- shared engine shapes (premium amendment + T3 parity) ----------------------

export type Appearance = "system" | "light" | "dark"
export type BrowserController = "human" | "agent" | "none"
export type Controller = BrowserController

export type LocatorType =
  | "css"
  | "text"
  | "role"
  | "testid"
  | "xpath"
  | "placeholder"
  | "label"
  | "name"

export interface Locator {
  type: LocatorType
  value: string
  exact?: boolean
}

export interface Coords {
  x: number
  y: number
}

export interface RefTarget {
  ref: string
  snapshotVersion: number
}

/** Snapshot-time binding for a ref badge (frozen positions per snapshotVersion). */
export interface SnapshotRef {
  x: number
  y: number
  locator?: Locator
}

/** PRIMARY targeting is a versioned ref; locator/coords remain escape hatches. */
export type ElementTarget = RefTarget | Locator | Coords

export type ElementState = {
  visible: boolean
  enabled: boolean
  checked: boolean
  focused: boolean
  readonly: boolean
}

export type SelectorConfidence = "high" | "med" | "low"

/** Synthesized selector (selector-synthesis ladder output; engine-internal shape). */
export interface ElementSelector {
  kind: "testid" | "id" | "aria" | "role-name" | "structural"
  value: string
  confidence: SelectorConfidence
}

/** Bounded DOM-query match (browser_query output; engine-internal shape). */
export interface QueryMatch {
  role?: string
  name?: string
  selector: ElementSelector
  rect: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number }
  visibility: "visible" | "hidden"
  display: string
  position: string
  text?: string
}

export interface ResolvedElement {
  selector: string
  confidence: SelectorConfidence
  rect: { x: number; y: number; width: number; height: number }
  role: string | null
  name: string | null
  state: ElementState
  display: string | null
  position: string | null
  zIndex: number | null
}

export interface SnapshotElement extends ResolvedElement {
  ref: string
  tagName: string
  text: string | null
}

export interface Viewport {
  width: number
  height: number
  dpr: number
  scrollX: number
  scrollY: number
}

export interface ResolvedTarget {
  locator: Locator
  coords: Coords
  tagName: string
  role?: string
  text?: string
}

export interface A11yNode {
  role: string
  name: string
  value?: string
  states: Record<string, boolean>
  target?: { locator: Locator; coords: Coords }
  children: A11yNode[]
}

// --- engine-internal guest/tab state (NOT the wire GuestTabState) --------------

export type GuestReadyState = "loading" | "interactive" | "complete"

export interface GuestTabState {
  runtimeTabId: string
  windowId: string
  sessionId: string
  workspaceId?: string
  webContentsId: number | null
  url: string
  title: string
  readyState: GuestReadyState
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoomFactor: number
  colorScheme: "light" | "dark"
  controller: BrowserController
  generation: number
  crashed: boolean
  attached: boolean
  snapshotVersion: number
}

export interface BrowserPointerEvent {
  tabId: string
  phase: "move" | "click"
  x: number
  y: number
  sequence: number
  createdAt: string
}

export type HumanInputSignal =
  | { kind: "pointer"; x: number; y: number; button: number }
  | { kind: "key"; key: string; code: string }

// --- operation inputs / outputs ------------------------------------------------

export type BrowserOperation =
  | { name: "status"; input: StatusInput }
  | { name: "open"; input: OpenInput }
  | { name: "navigate"; input: NavigateInput }
  | { name: "resize"; input: ResizeInput }
  | { name: "set_appearance"; input: SetAppearanceInput }
  | { name: "snapshot"; input: SnapshotInput }
  | { name: "screenshot"; input: ScreenshotInput }
  | { name: "click"; input: ClickInput }
  | { name: "type"; input: TypeInput }
  | { name: "press"; input: PressInput }
  | { name: "scroll"; input: ScrollInput }
  | { name: "evaluate"; input: EvaluateInput }
  | { name: "wait_for"; input: WaitForInput }
  | { name: "recording_start"; input: RecordingStartInput }
  | { name: "recording_stop"; input: RecordingStopInput }
  | { name: "close"; input: CloseInput }
  | { name: "highlight"; input: HighlightInput }
  | { name: "annotate"; input: AnnotateInput }
  | { name: "query"; input: QueryInput }
  | { name: "profiler_start"; input: ProfilerStartInput }
  | { name: "profiler_stop"; input: ProfilerStopInput }

export type BrowserOperationName = BrowserOperation["name"]

export interface StatusInput {
  tabId?: string
  timeoutMs?: number
}
export interface OpenInput {
  url: string
  newTab?: boolean
  activate?: boolean
  appearance?: Appearance
  timeoutMs?: number
}
export interface NavigateInput {
  url: string
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"
  timeoutMs?: number
}
export interface ResizeInput {
  width: number
  height: number
  deviceScaleFactor?: number
  timeoutMs?: number
}
export interface SetAppearanceInput {
  appearance: Appearance
  timeoutMs?: number
}
export interface SnapshotInput {
  tabId?: string
  maxDepth?: number
  includeHidden?: boolean
  format?: "a11y" | "aria" | "text" | "debug"
  timeoutMs?: number
}
export interface ScreenshotInput {
  tabId?: string
  format?: "png" | "jpeg"
  quality?: number
  fullPage?: boolean
  timeoutMs?: number
}
export interface ClickInput {
  target: ElementTarget
  button?: "left" | "middle" | "right"
  clickCount?: number
  modifiers?: Array<"alt" | "ctrl" | "meta" | "shift">
  scrollIntoView?: boolean
  timeoutMs?: number
}
export interface TypeInput {
  text: string
  target?: ElementTarget
  clear?: boolean
  submit?: boolean
  delayMs?: number
  timeoutMs?: number
}
export interface PressInput {
  key: string
  target?: ElementTarget
  timeoutMs?: number
}
export interface ScrollInput {
  target?: ElementTarget
  delta?: { x: number; y: number }
  to?: "top" | "bottom" | "start" | "end"
  timeoutMs?: number
}
export interface EvaluateInput {
  script: string
  args?: unknown[]
  awaitPromise?: boolean
  timeoutMs?: number
  maxResultBytes?: number
}
export interface WaitForInput {
  condition:
    | { type: "selector"; selector: Locator }
    | { type: "text"; text: string; visible?: boolean }
    | { type: "url"; pattern: string }
    | { type: "expression"; script: string }
  state?: "visible" | "hidden" | "attached" | "detached"
  timeoutMs?: number
}
export interface RecordingStartInput {
  format?: "webm" | "gif"
  includeAudio?: boolean
  maxDurationMs?: number
  maxBytes?: number
  timeoutMs?: number
}
export interface RecordingStopInput {
  recordingId?: string
  timeoutMs?: number
}
export interface CloseInput {
  tabId?: string
  closeWindow?: boolean
  timeoutMs?: number
}
export interface HighlightInput {
  target: ElementTarget
  timeoutMs?: number
}
export type AnnotationTone = "neutral" | "info" | "success" | "warning" | "danger"
export interface AnnotationTarget {
  target: ElementTarget
  label?: string
  tone?: AnnotationTone
}
export interface AnnotateInput {
  tabId?: string
  targets?: AnnotationTarget[]
  clear?: boolean
  durationMs?: number
  timeoutMs?: number
}
export interface QueryInput {
  selector?: string
  role?: string
  text?: string
  maxResults?: number
  timeoutMs?: number
}
export interface ProfilerStartInput {
  component?: string
  timeoutMs?: number
}
export interface ProfilerStopInput {
  component?: string
  timeoutMs?: number
}

export interface StatusOutput {
  status: {
    host: {
      connected: boolean
      hostId: string | null
      hostEpoch: number | null
      connectionId: string | null
      windowId: string
      capabilities: HostCapabilities
    }
    guest: {
      attached: boolean
      activeTabId: string | null
      url: string | null
      controller: BrowserController
      zoomFactor: number
    }
    tabs: WireGuestTabState[]
  }
}

/** Renderer-facing aggregate state (window.api.browser.getState). */
export interface BrowserState {
  host: {
    connected: boolean
    hostId: string | null
    hostEpoch: number | null
    connectionId: string | null
    windowId: string
    capabilities: HostCapabilities
  }
  guest: {
    attached: boolean
    activeTabId: string | null
    url: string | null
    controller: BrowserController
    zoomFactor: number
  }
  tabs: WireGuestTabState[]
}
export interface OpenOutput {
  opened: {
    tabId: string
    url: string
    title: string
    readyState: WireGuestTabState["readyState"]
    viewport: Viewport
  }
}
export interface NavigateOutput {
  navigated: {
    tabId: string
    url: string
    title: string
    readyState: WireGuestTabState["readyState"]
    httpStatus?: number
    redirectedFrom?: string
    viewport: Viewport
  }
}
export interface ResizeOutput {
  resized: {
    width: number
    height: number
    dpr: number
    actualWidth: number
    actualHeight: number
  }
}
export interface SetAppearanceOutput {
  appearance: Appearance
  effective: "light" | "dark"
}
export interface SnapshotOutput {
  snapshot: {
    tabId: string
    url: string
    tree: A11yNode[]
    elements: SnapshotElement[]
    text: string
    truncated: boolean
    count: number
    viewport: Viewport
    snapshotVersion: number
  }
}
export interface ScreenshotOutput {
  screenshot: {
    tabId: string
    url: string
    title: string
    mime: "image/png" | "image/jpeg"
    data: string
    width: number
    height: number
    viewport: Viewport
    capturedAt: number
  }
}
export interface ClickOutput {
  clicked: {
    target: ResolvedElement
    coords: Coords
    clickCount: number
    afterUrl?: string
    afterTitle?: string
  }
}
export interface TypeOutput {
  typed: {
    target?: ResolvedElement
    value: string
    caret: number
    submitted: boolean
  }
}
export interface PressOutput {
  pressed: {
    key: string
    target?: ResolvedElement
    repeat: boolean
    modifiers: string[]
  }
}
export interface ScrollOutput {
  scrolled: {
    target?: ResolvedElement
    viewport: Viewport
    scrollX: number
    scrollY: number
  }
}
export interface EvaluateOutput {
  evaluated: {
    result: unknown
    type: string
    truncated: boolean
    error?: string
  }
}
export interface WaitForOutput {
  waited: {
    condition: WaitForInput["condition"]
    satisfied: true
    at: { time: string; url: string; title: string }
    element?: ResolvedElement
  }
}
export interface RecordingStartOutput {
  recording: {
    recordingId: string
    format: string
    startedAt: string
    tabId: string
  }
}
export interface RecordingStopOutput {
  recording: {
    recordingId: string
    stoppedAt: string
    durationMs: number
    sizeBytes: number
    artifact: { type: "file"; mime: string; url: string; path?: string }
  }
}
export interface CloseOutput {
  closed: {
    tabId: string
    wasActive: boolean
    guestsRemaining: number
  }
}
export interface HighlightOutput {
  highlighted: {
    target: ResolvedElement
    coords: Coords
  }
}
export interface AnnotateOutput {
  annotated: {
    tabId: string
    count: number
    cleared: boolean
    at: { time: number }
  }
}
export interface QueryOutput {
  queried: {
    matches: ResolvedElement[]
    truncated: boolean
  }
}
export interface ProfilerStartOutput {
  profiler: {
    started: true
    component?: string
    tabId: string
  }
}
export interface ProfilerStopOutput {
  profiler: {
    commitCount: number
    windowMs: number
    components: Array<{ name: string; renders: number }>
    propsDiff?: unknown
    tabId: string
  }
}

// --- runtime guards (pure; unit-tested) ---------------------------------------

const OPERATION_NAMES: readonly BrowserOperationName[] = [
  "status",
  "open",
  "navigate",
  "resize",
  "set_appearance",
  "snapshot",
  "screenshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "wait_for",
  "recording_start",
  "recording_stop",
  "close",
  "highlight",
  "annotate",
  "query",
  "profiler_start",
  "profiler_stop",
]

const ERROR_TAGS: readonly BrowserErrorTag[] = [
  "BrowserHostUnavailable",
  "BrowserProtocolMismatch",
  "BrowserTabNotFound",
  "BrowserGuestCrashed",
  "BrowserControlInterrupted",
  "BrowserInvalidSelector",
  "BrowserTargetNotFound",
  "BrowserTimeout",
  "BrowserResultTooLarge",
  "BrowserDebuggerConflict",
  "BrowserUnsupportedOperation",
  "BrowserPermissionDenied",
  "BrowserNotAttached",
  "BrowserOperationFailed",
  "BrowserStaleRefError",
  "BrowserNotAReactAppError",
]

export const isBrowserOperationName = (value: unknown): value is BrowserOperationName =>
  typeof value === "string" && (OPERATION_NAMES as readonly string[]).includes(value)

export const isBrowserErrorTag = (value: unknown): value is BrowserErrorTag =>
  typeof value === "string" && (ERROR_TAGS as readonly string[]).includes(value)

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isCoords = (value: unknown): value is Coords =>
  isRecord(value) && typeof value.x === "number" && typeof value.y === "number"

export const isLocator = (value: unknown): value is Locator =>
  isRecord(value) &&
  typeof value.type === "string" &&
  (LOCATOR_TYPES as readonly string[]).includes(value.type) &&
  typeof value.value === "string"

const LOCATOR_TYPES: readonly LocatorType[] = [
  "css",
  "text",
  "role",
  "testid",
  "xpath",
  "placeholder",
  "label",
  "name",
]

export const isRefTarget = (value: unknown): value is RefTarget =>
  isRecord(value) && typeof value.ref === "string" && typeof value.snapshotVersion === "number"

export const isElementTarget = (value: unknown): value is ElementTarget =>
  isRefTarget(value) || isLocator(value) || isCoords(value)

export const isBrokerRequest = (value: unknown): value is BrokerRequest => {
  if (!isRecord(value)) return false
  if (typeof value.requestId !== "string") return false
  if (typeof value.sessionId !== "string") return false
  if (typeof value.messageId !== "string") return false
  if (typeof value.timeoutMs !== "number") return false
  if (!isRecord(value.operation)) return false
  if (!isBrowserOperationName(value.operation.name)) return false
  if (!("input" in value)) return false
  if (value.tabId !== undefined && typeof value.tabId !== "string") return false
  return true
}

export const isHumanInputSignal = (value: unknown): value is HumanInputSignal => {
  if (!isRecord(value) || typeof value.kind !== "string") return false
  if (value.kind === "pointer") {
    return (
      typeof value.x === "number" &&
      typeof value.y === "number" &&
      typeof value.button === "number"
    )
  }
  if (value.kind === "key") {
    return typeof value.key === "string" && typeof value.code === "string"
  }
  return false
}

/** Guests may only load http(s) — blocks custom schemes/file. */
export const isBrowserGuestUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "http:" || url.protocol === "https:"
}

export const toWireGuestTabState = (tab: GuestTabState): WireGuestTabState => ({
  tabId: tab.runtimeTabId,
  url: tab.url,
  title: tab.title,
  readyState: tab.crashed ? "LoadFailed" : tab.loading || tab.readyState !== "complete" ? "Loading" : "Success",
  controller: tab.controller,
  zoomFactor: tab.zoomFactor,
  attached: tab.attached,
})
