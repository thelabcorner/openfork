import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Workspace } from "@opencode-ai/schema/workspace"
import { AbsolutePath, NonNegativeInt, PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

/**
 * BrowserHostBroker wire contract (`server.browser` group).
 *
 * Topology: the Desktop host (main process) runs a loopback HTTP listener and
 * registers OUT to the sidecar with `host/hello`. The sidecar (which hosts both
 * the server API and the agent/tool loop) forwards `BrokerRequest` envelopes IN
 * to the host's callback URL and receives a synchronous `BrokerResponse`
 * (HTTP 200 on both arms — operation errors are payload tags, so transport
 * failures are distinguishable from operation failures).
 *
 * These schemas are the WIRE source of truth. `packages/core` must not depend
 * on `@opencode-ai/protocol`, so the core `BrowserHostBroker` service mirrors
 * the envelope shapes structurally; the server handler bridges schema-decoded
 * payloads into the service. `packages/opencode` re-exports these schemas from
 * `src/browser/shared.ts` for the tool layer.
 *
 * Design: deliverable/browser-phase0-protocol (v4) + the premium-agent-UX
 * amendment (decisions/browser-premium-agent-ux): ref-based targeting is the
 * PRIMARY element identification; locators/coords remain escape hatches.
 */

/** Broker wire version. The host's hello is rejected when it mismatches. */
export const BROWSER_PROTOCOL_VERSION = 1

export const BROKER_REQUEST_PATH = "/v1/browser/request"
export const BROKER_ABORT_PATH = "/v1/browser/request/:requestId/abort"

// --- error taxonomy ----------------------------------------------------------

export const BrowserErrorTag = Schema.Literals([
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
])
export type BrowserErrorTag = Schema.Schema.Type<typeof BrowserErrorTag>

export const BrokerError = Schema.Struct({
  tag: BrowserErrorTag,
  message: Schema.String,
  retryable: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
})
export type BrokerError = Schema.Schema.Type<typeof BrokerError>

// --- host registration -------------------------------------------------------

export const HostCapabilities = Schema.Struct({
  maxSnapshotBytes: Schema.Number,
  maxResultBytes: Schema.Number,
  supportedAppearances: Schema.Array(Schema.Literals(["system", "light", "dark"])),
  supportsRecording: Schema.Boolean,
  cdp: Schema.Boolean,
})
export type HostCapabilities = Schema.Schema.Type<typeof HostCapabilities>

export const HostGuestState = Schema.Struct({
  attached: Schema.Boolean,
  activeTabId: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
})
export type HostGuestState = Schema.Schema.Type<typeof HostGuestState>

export const HostHello = Schema.Struct({
  protocolVersion: Schema.Number,
  hostId: Schema.String,
  hostEpoch: Schema.Number,
  connectionId: Schema.String,
  windowId: Schema.String,
  capabilities: HostCapabilities,
  guest: HostGuestState,
})
export type HostHello = Schema.Schema.Type<typeof HostHello>

/**
 * Payload the host POSTs to the sidecar hello endpoint. The stickiness key is
 * `${sessionID}@${workspaceID ?? sha1(directory)}#${windowID}`, so the
 * registration must carry the session identity plus the host's callback
 * reachability.
 */
export const HostRegistration = Schema.Struct({
  ...HostHello.fields,
  sessionId: Session.ID,
  workspaceId: Schema.optional(Workspace.ID),
  directory: Schema.optional(AbsolutePath),
  callbackUrl: Schema.String,
  callbackToken: Schema.String,
})
export type HostRegistration = Schema.Schema.Type<typeof HostRegistration>

/** Debug listing row — registration minus the callback bearer token. */
export const HostRegistrationInfo = Schema.Struct({
  sessionId: Session.ID,
  workspaceId: Schema.optional(Workspace.ID),
  directory: Schema.optional(AbsolutePath),
  callbackUrl: Schema.String,
  protocolVersion: Schema.Number,
  hostId: Schema.String,
  hostEpoch: Schema.Number,
  connectionId: Schema.String,
  windowId: Schema.String,
  capabilities: HostCapabilities,
  guest: HostGuestState,
  status: Schema.Literals(["live", "superseded", "dead"]),
  registeredAt: Schema.Number,
  lastSeenAt: Schema.Number,
})
export type HostRegistrationInfo = Schema.Schema.Type<typeof HostRegistrationInfo>

export const HostHelloReply = Schema.Struct({
  data: Schema.Struct({
    accepted: Schema.Boolean,
    brokerProtocolVersion: Schema.Number,
    hostId: Schema.String,
    replacement: Schema.optional(Schema.Boolean),
  }),
})
export type HostHelloReply = Schema.Schema.Type<typeof HostHelloReply>

export const GuestTabState = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  readyState: Schema.Literals(["Idle", "Loading", "Success", "LoadFailed"]),
  controller: Schema.Literals(["human", "agent", "none"]),
  zoomFactor: Schema.Number,
  attached: Schema.Boolean,
})
export type GuestTabState = Schema.Schema.Type<typeof GuestTabState>

export const HostEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("guest.crashed"), tabId: Schema.String, timestamp: Schema.String }),
  Schema.Struct({ type: Schema.Literal("guest.stateChanged"), tab: GuestTabState, timestamp: Schema.String }),
  Schema.Struct({ type: Schema.Literal("host.stopping"), timestamp: Schema.String }),
  Schema.Struct({ type: Schema.Literal("request.aborted"), requestId: Schema.String, timestamp: Schema.String }),
])
export type HostEvent = Schema.Schema.Type<typeof HostEvent>

// --- shared targeting shapes -------------------------------------------------

/** Viewport-relative pixel point (raw CSS viewport pixels — the coordinate space). */
export const Coords = Schema.Struct({ x: NonNegativeInt, y: NonNegativeInt })
export type Coords = Schema.Schema.Type<typeof Coords>

export const Rect = Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number })
export type Rect = Schema.Schema.Type<typeof Rect>

export const Locator = Schema.Struct({
  type: Schema.Literals(["css", "text", "role", "testid", "xpath", "placeholder", "label", "name"]),
  value: Schema.String,
  exact: Schema.optional(Schema.Boolean),
})
export type Locator = Schema.Schema.Type<typeof Locator>

/** PRIMARY targeting: a snapshot-versioned element reference ("e1".."eN"). */
export const RefTarget = Schema.Struct({
  ref: Schema.String,
  snapshotVersion: Schema.Number,
})
export type RefTarget = Schema.Schema.Type<typeof RefTarget>

/** Ref targeting is primary; locator/coords remain T3-parity escape hatches. */
export const ElementTarget = Schema.Union([RefTarget, Locator, Coords])
export type ElementTarget = Schema.Schema.Type<typeof ElementTarget>

export const SelectorConfidence = Schema.Literals(["high", "med", "low"])
export type SelectorConfidence = Schema.Schema.Type<typeof SelectorConfidence>

export const ElementSelector = Schema.Struct({
  kind: Schema.Literals(["testid", "id", "aria", "role-name", "structural"]),
  value: Schema.String,
  confidence: SelectorConfidence,
})
export type ElementSelector = Schema.Schema.Type<typeof ElementSelector>

export const ElementState = Schema.Struct({
  visible: Schema.Boolean,
  enabled: Schema.Boolean,
  checked: Schema.Boolean,
  focused: Schema.Boolean,
  readonly: Schema.Boolean,
})
export type ElementState = Schema.Schema.Type<typeof ElementState>

/** One interactive element surfaced by a snapshot — badgeable via its ref. */
export const SnapshotElement = Schema.Struct({
  ref: Schema.String,
  role: Schema.String,
  name: Schema.String,
  selector: ElementSelector,
  rect: Rect,
  center: Coords,
  state: ElementState,
  locator: Schema.optional(Locator),
})
export type SnapshotElement = Schema.Schema.Type<typeof SnapshotElement>

/** What an interact operation ACTUALLY resolved — the target echo. */
export const ResolvedTarget = Schema.Struct({
  kind: Schema.Literals(["ref", "locator", "coords"]),
  ref: Schema.optional(Schema.String),
  snapshotVersion: Schema.optional(Schema.Number),
  selector: Schema.optional(ElementSelector),
  locator: Schema.optional(Locator),
  rect: Schema.optional(Rect),
  center: Schema.optional(Coords),
  role: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  tagName: Schema.optional(Schema.String),
  state: Schema.optional(ElementState),
  nodeId: Schema.optional(Schema.Number),
})
export type ResolvedTarget = Schema.Schema.Type<typeof ResolvedTarget>

export interface A11yNode {
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly states: readonly string[]
  readonly target?: { readonly locator?: Locator; readonly rect: Rect }
  readonly children: readonly A11yNode[]
}

export const A11yNode: Schema.Schema<A11yNode> = Schema.suspend(() =>
  Schema.Struct({
    role: Schema.String,
    name: Schema.String,
    value: Schema.optional(Schema.String),
    states: Schema.Array(Schema.String),
    target: Schema.optional(
      Schema.Struct({
        locator: Schema.optional(Locator),
        rect: Rect,
      }),
    ),
    children: Schema.Array(A11yNode),
  }),
)

export const Viewport = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  dpr: Schema.Number,
  scrollX: Schema.Number,
  scrollY: Schema.Number,
})
export type Viewport = Schema.Schema.Type<typeof Viewport>

export const BrowserState = Schema.Struct({
  connected: Schema.Boolean,
  host: Schema.optional(
    Schema.Struct({
      hostId: Schema.String,
      protocolVersion: Schema.Number,
      hostEpoch: Schema.Number,
    }),
  ),
  guest: Schema.optional(
    Schema.Struct({
      windowId: Schema.String,
      state: Schema.Literals(["attached", "detached", "crashed", "unavailable"]),
      activeTab: Schema.optional(
        Schema.Struct({
          tabId: Schema.String,
          url: Schema.String,
          title: Schema.String,
          readyState: Schema.String,
          viewport: Viewport,
        }),
      ),
    }),
  ),
  appearance: Schema.Literals(["system", "light", "dark"]),
  recording: Schema.Struct({ active: Schema.Boolean, recordingId: Schema.optional(Schema.String) }),
})
export type BrowserState = Schema.Schema.Type<typeof BrowserState>

// --- per-operation inputs ----------------------------------------------------

export const StatusInput = Schema.Struct({
  tabId: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
})

export const OpenInput = Schema.Struct({
  url: Schema.String,
  newTab: Schema.optional(Schema.Boolean),
  activate: Schema.optional(Schema.Boolean),
  appearance: Schema.optional(Schema.Literals(["system", "light", "dark"])),
  timeoutMs: Schema.optional(Schema.Number),
})

export const NavigateInput = Schema.Struct({
  url: Schema.String,
  waitUntil: Schema.optional(Schema.Literals(["load", "domcontentloaded", "networkidle", "commit"])),
  timeoutMs: Schema.optional(Schema.Number),
})

export const ResizeInput = Schema.Struct({
  width: PositiveInt,
  height: PositiveInt,
  deviceScaleFactor: Schema.optional(Schema.Number),
})

export const SetAppearanceInput = Schema.Struct({
  appearance: Schema.Literals(["system", "light", "dark"]),
})

export const SnapshotInput = Schema.Struct({
  tabId: Schema.optional(Schema.String),
  maxDepth: Schema.optional(PositiveInt),
  includeHidden: Schema.optional(Schema.Boolean),
  format: Schema.optional(Schema.Literals(["a11y", "aria", "text", "debug"])),
  timeoutMs: Schema.optional(Schema.Number),
})

export const ScreenshotInput = Schema.Struct({
  tabId: Schema.optional(Schema.String),
  format: Schema.optional(Schema.Literals(["png", "jpeg"])),
  quality: Schema.optional(PositiveInt),
  fullPage: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(Schema.Number),
})

export const AnnotationTone = Schema.Literals(["neutral", "info", "success", "warning", "danger"])
export type AnnotationTone = Schema.Schema.Type<typeof AnnotationTone>

export const AnnotationTarget = Schema.Struct({
  target: ElementTarget,
  label: Schema.optional(Schema.String),
  tone: Schema.optional(AnnotationTone),
})
export type AnnotationTarget = Schema.Schema.Type<typeof AnnotationTarget>

export const AnnotateInput = Schema.Struct({
  tabId: Schema.optional(Schema.String),
  targets: Schema.optional(Schema.Array(AnnotationTarget)),
  clear: Schema.optional(Schema.Boolean),
  durationMs: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
})

export const ClickInput = Schema.Struct({
  target: ElementTarget,
  button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
  clickCount: Schema.optional(PositiveInt),
  modifiers: Schema.optional(Schema.Array(Schema.Literals(["alt", "ctrl", "meta", "shift"]))),
  scrollIntoView: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(Schema.Number),
})

export const TypeInput = Schema.Struct({
  text: Schema.String,
  target: Schema.optional(ElementTarget),
  clear: Schema.optional(Schema.Boolean),
  submit: Schema.optional(Schema.Boolean),
  delayMs: Schema.optional(NonNegativeInt),
  timeoutMs: Schema.optional(Schema.Number),
})

export const PressInput = Schema.Struct({
  key: Schema.String,
  target: Schema.optional(ElementTarget),
  timeoutMs: Schema.optional(Schema.Number),
})

export const ScrollInput = Schema.Struct({
  target: Schema.optional(ElementTarget),
  delta: Schema.optional(Schema.Struct({ x: Schema.Int, y: Schema.Int })),
  to: Schema.optional(Schema.Literals(["top", "bottom", "start", "end"])),
  timeoutMs: Schema.optional(Schema.Number),
})

export const EvaluateInput = Schema.Struct({
  script: Schema.String,
  args: Schema.optional(Schema.Array(Schema.Json)),
  awaitPromise: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(Schema.Number),
  maxResultBytes: Schema.optional(Schema.Number),
})

export const WaitForCondition = Schema.Union([
  Schema.Struct({ type: Schema.Literal("selector"), selector: Locator }),
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String, visible: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("url"), pattern: Schema.String }),
  Schema.Struct({ type: Schema.Literal("expression"), script: Schema.String }),
])
export type WaitForCondition = Schema.Schema.Type<typeof WaitForCondition>

export const WaitForInput = Schema.Struct({
  condition: Schema.optional(WaitForCondition),
  target: Schema.optional(ElementTarget),
  state: Schema.optional(Schema.Literals(["visible", "enabled", "checked", "hidden", "attached", "detached"])),
  timeoutMs: Schema.optional(Schema.Number),
})

export const RecordingStartInput = Schema.Struct({
  format: Schema.optional(Schema.Literals(["webm", "gif"])),
  includeAudio: Schema.optional(Schema.Boolean),
  maxDurationMs: Schema.optional(Schema.Number),
  maxBytes: Schema.optional(Schema.Number),
})

export const RecordingStopInput = Schema.Struct({
  recordingId: Schema.optional(Schema.String),
})

export const CloseInput = Schema.Struct({
  tabId: Schema.optional(Schema.String),
  closeWindow: Schema.optional(Schema.Boolean),
})

export const QueryInput = Schema.Struct({
  target: Locator,
  maxResults: Schema.optional(PositiveInt),
  timeoutMs: Schema.optional(Schema.Number),
})

export const HighlightInput = Schema.Struct({
  target: ElementTarget,
  durationMs: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
})

export const ProfilerStartInput = Schema.Struct({
  tabId: Schema.optional(Schema.String),
})

export const ProfilerStopInput = Schema.Struct({
  tabId: Schema.optional(Schema.String),
})

export const ReactInspectInput = Schema.Struct({
  target: ElementTarget,
  timeoutMs: Schema.optional(Schema.Number),
})

// --- per-operation outputs (explicit success objects, never void) ------------

export const StatusOutput = Schema.Struct({
  status: BrowserState,
})

export const OpenOutput = Schema.Struct({
  opened: Schema.Struct({
    tabId: Schema.String,
    url: Schema.String,
    title: Schema.String,
    readyState: Schema.String,
    viewport: Viewport,
  }),
})

export const NavigateOutput = Schema.Struct({
  navigated: Schema.Struct({
    tabId: Schema.String,
    url: Schema.String,
    title: Schema.String,
    readyState: Schema.String,
    httpStatus: Schema.optional(Schema.Number),
    redirectedFrom: Schema.optional(Schema.String),
    viewport: Viewport,
  }),
})

export const ResizeOutput = Schema.Struct({
  resized: Schema.Struct({
    width: Schema.Number,
    height: Schema.Number,
    dpr: Schema.Number,
    actualWidth: Schema.Number,
    actualHeight: Schema.Number,
  }),
})

export const SetAppearanceOutput = Schema.Struct({
  appearance: Schema.Literals(["system", "light", "dark"]),
  effective: Schema.Literals(["light", "dark"]),
})

export const SnapshotOutput = Schema.Struct({
  snapshot: Schema.Struct({
    tabId: Schema.String,
    url: Schema.String,
    snapshotVersion: Schema.Number,
    tree: Schema.Array(A11yNode),
    elements: Schema.Array(SnapshotElement),
    text: Schema.String,
    truncated: Schema.Boolean,
    count: Schema.Number,
    viewport: Viewport,
  }),
})

export const ScreenshotOutput = Schema.Struct({
  screenshot: Schema.Struct({
    tabId: Schema.String,
    url: Schema.String,
    title: Schema.String,
    mime: Schema.Literals(["image/png", "image/jpeg"]),
    data: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    viewport: Viewport,
    capturedAt: Schema.Number,
  }),
})

export const ClickOutput = Schema.Struct({
  clicked: Schema.Struct({
    target: ResolvedTarget,
    coords: Coords,
    clickCount: Schema.Number,
    afterUrl: Schema.optional(Schema.String),
    afterTitle: Schema.optional(Schema.String),
  }),
})

export const TypeOutput = Schema.Struct({
  typed: Schema.Struct({
    target: Schema.optional(ResolvedTarget),
    value: Schema.String,
    caret: Schema.Struct({ selectionStart: Schema.Number, selectionEnd: Schema.Number }),
    submitted: Schema.Boolean,
  }),
})

export const PressOutput = Schema.Struct({
  pressed: Schema.Struct({
    key: Schema.String,
    target: Schema.optional(ResolvedTarget),
    repeat: Schema.Boolean,
    modifiers: Schema.Array(Schema.String),
  }),
})

export const ScrollOutput = Schema.Struct({
  scrolled: Schema.Struct({
    target: Schema.optional(ResolvedTarget),
    viewport: Viewport,
  }),
})

export const EvaluateOutput = Schema.Struct({
  evaluated: Schema.Struct({
    result: Schema.Json,
    type: Schema.String,
    truncated: Schema.Boolean,
    error: Schema.optional(Schema.String),
  }),
})

export const WaitForOutput = Schema.Struct({
  waited: Schema.Struct({
    condition: Schema.optional(WaitForCondition),
    target: Schema.optional(ResolvedTarget),
    satisfied: Schema.Literal(true),
    at: Schema.Struct({ time: Schema.Number, url: Schema.String, title: Schema.String }),
    element: Schema.optional(ResolvedTarget),
  }),
})

export const RecordingStartOutput = Schema.Struct({
  recording: Schema.Struct({
    recordingId: Schema.String,
    format: Schema.String,
    startedAt: Schema.Number,
    tabId: Schema.String,
  }),
})

export const RecordingStopOutput = Schema.Struct({
  recording: Schema.Struct({
    recordingId: Schema.String,
    stoppedAt: Schema.Number,
    durationMs: Schema.Number,
    sizeBytes: Schema.Number,
    artifact: Schema.Struct({
      type: Schema.Literal("file"),
      mime: Schema.Literals(["video/webm", "image/gif"]),
      url: Schema.String,
      path: Schema.optional(Schema.String),
    }),
  }),
})

export const CloseOutput = Schema.Struct({
  closed: Schema.Struct({
    tabId: Schema.String,
    wasActive: Schema.Boolean,
    guestsRemaining: Schema.Number,
  }),
})

export const QueryMatch = Schema.Struct({
  ref: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  selector: Schema.optional(ElementSelector),
  rect: Rect,
  center: Coords,
  visibility: Schema.Literals(["visible", "hidden"]),
  display: Schema.String,
  position: Schema.Literals(["static", "relative", "absolute", "fixed", "sticky"]),
  text: Schema.optional(Schema.String),
})
export type QueryMatch = Schema.Schema.Type<typeof QueryMatch>

export const QueryOutput = Schema.Struct({
  queried: Schema.Struct({
    tabId: Schema.String,
    url: Schema.String,
    matches: Schema.Array(QueryMatch),
    count: Schema.Number,
    truncated: Schema.Boolean,
  }),
})

export const HighlightOutput = Schema.Struct({
  highlighted: Schema.Struct({
    target: ResolvedTarget,
    at: Schema.Struct({ time: Schema.Number }),
  }),
})

export const AnnotateOutput = Schema.Struct({
  annotated: Schema.Struct({
    tabId: Schema.String,
    count: Schema.Number,
    cleared: Schema.Boolean,
    at: Schema.Struct({ time: Schema.Number }),
  }),
})

export const ProfilerResult = Schema.Struct({
  commits: Schema.Number,
  windowMs: Schema.Number,
  topRenders: Schema.Array(Schema.Struct({ name: Schema.String, count: Schema.Number })),
  propsDiff: Schema.optional(
    Schema.Struct({
      component: Schema.String,
      props: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          before: Schema.Json,
          after: Schema.Json,
        }),
      ),
    }),
  ),
  truncated: Schema.Boolean,
})
export type ProfilerResult = Schema.Schema.Type<typeof ProfilerResult>

export const ProfilerStartOutput = Schema.Struct({
  started: Schema.Struct({
    snapshotVersion: Schema.Number,
  }),
})

export const ProfilerStopOutput = Schema.Struct({
  profiled: ProfilerResult,
})

/** One fiber's worth of React DevTools-equivalent metadata — component
 * name, dev-build source location, current props, and readable hook state
 * (useState/useReducer values; skips refs/effects, which aren't meaningfully
 * serializable). Reads React's Fiber tree directly, not the DevTools
 * protocol — see reactInspectScript in packages/desktop for why this needs
 * no `contextIsolation=false` relaxation. */
export const ReactComponentInfo = Schema.Struct({
  name: Schema.String,
  source: Schema.optional(Schema.Struct({ file: Schema.String, line: Schema.optional(Schema.Number), column: Schema.optional(Schema.Number) })),
  props: Schema.optional(Schema.Json),
  hooks: Schema.optional(Schema.Array(Schema.Json)),
})
export type ReactComponentInfo = Schema.Schema.Type<typeof ReactComponentInfo>

export const ReactInspectOutput = Schema.Struct({
  inspected: Schema.Struct({
    tabId: Schema.String,
    hasReact: Schema.Boolean,
    component: Schema.optional(ReactComponentInfo),
    ancestors: Schema.Array(ReactComponentInfo),
  }),
})

// --- operation tagged union --------------------------------------------------

export const BrowserOperation = Schema.Union([
  Schema.Struct({ name: Schema.Literal("status"), input: Schema.Unknown }),
  Schema.Struct({ name: Schema.Literal("open"), input: OpenInput }),
  Schema.Struct({ name: Schema.Literal("navigate"), input: NavigateInput }),
  Schema.Struct({ name: Schema.Literal("resize"), input: ResizeInput }),
  Schema.Struct({ name: Schema.Literal("set_appearance"), input: SetAppearanceInput }),
  Schema.Struct({ name: Schema.Literal("snapshot"), input: SnapshotInput }),
  Schema.Struct({ name: Schema.Literal("screenshot"), input: ScreenshotInput }),
  Schema.Struct({ name: Schema.Literal("click"), input: ClickInput }),
  Schema.Struct({ name: Schema.Literal("type"), input: TypeInput }),
  Schema.Struct({ name: Schema.Literal("press"), input: PressInput }),
  Schema.Struct({ name: Schema.Literal("scroll"), input: ScrollInput }),
  Schema.Struct({ name: Schema.Literal("evaluate"), input: EvaluateInput }),
  Schema.Struct({ name: Schema.Literal("wait_for"), input: WaitForInput }),
  Schema.Struct({ name: Schema.Literal("recording_start"), input: RecordingStartInput }),
  Schema.Struct({ name: Schema.Literal("recording_stop"), input: RecordingStopInput }),
  Schema.Struct({ name: Schema.Literal("close"), input: CloseInput }),
  Schema.Struct({ name: Schema.Literal("query"), input: QueryInput }),
  Schema.Struct({ name: Schema.Literal("highlight"), input: HighlightInput }),
  Schema.Struct({ name: Schema.Literal("annotate"), input: AnnotateInput }),
  Schema.Struct({ name: Schema.Literal("profiler_start"), input: ProfilerStartInput }),
  Schema.Struct({ name: Schema.Literal("profiler_stop"), input: ProfilerStopInput }),
  Schema.Struct({ name: Schema.Literal("react_inspect"), input: ReactInspectInput }),
])
export type BrowserOperation = Schema.Schema.Type<typeof BrowserOperation>
export type BrowserOperationName = BrowserOperation["name"]

// --- broker envelope ---------------------------------------------------------

export const BrokerRequest = Schema.Struct({
  requestId: Schema.String,
  sessionId: Session.ID,
  windowId: Schema.String,
  workspaceId: Schema.optional(Workspace.ID),
  directory: Schema.optional(AbsolutePath),
  messageId: SessionMessage.ID,
  toolCallId: Schema.optional(Schema.String),
  tabId: Schema.optional(Schema.String),
  operation: BrowserOperation,
  timeoutMs: Schema.Number,
})
export type BrokerRequest = Schema.Schema.Type<typeof BrokerRequest>

export const SnapshotRef = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  readyState: Schema.String,
})
export type SnapshotRef = Schema.Schema.Type<typeof SnapshotRef>

export const BrokerResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    requestId: Schema.String,
    result: Schema.Unknown,
    elapsedMs: Schema.Number,
    snapshotAfter: Schema.optional(SnapshotRef),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    requestId: Schema.String,
    error: BrokerError,
    elapsedMs: Schema.Number,
  }),
])
export type BrokerResponse = Schema.Schema.Type<typeof BrokerResponse>

// --- group -------------------------------------------------------------------

export const BrowserHostGroup = HttpApiGroup.make("server.browser")
  .add(
    HttpApiEndpoint.post("browser.host.hello", "/api/browser/host/hello", {
      payload: HostRegistration,
      success: HostHelloReply,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.browser.host.hello",
        summary: "Register a Desktop browser host",
        description:
          "Register (or re-register) a Desktop browser host connection. Last hello wins per stickiness key; a new connectionId supersedes the old one and in-flight requests against the old connection fail with BrowserControlInterrupted.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("browser.event", "/api/browser/event", {
      payload: HostEvent,
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.browser.event",
        summary: "Push a host event",
        description:
          "Host-side events: guest crashed, guest state changed, host stopping, or a request-abort acknowledgement.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("browser.hosts", "/api/browser/hosts", {
      success: Schema.Struct({ data: Schema.Array(HostRegistrationInfo) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.browser.hosts",
        summary: "List registered browser hosts",
        description: "Debug listing of the currently registered Desktop browser host connections.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "browser", description: "Desktop browser host broker." }))
