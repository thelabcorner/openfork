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
export const BROWSER_PROTOCOL_VERSION = 2

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

export const VisualHostCapabilities = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  snapeyeProtocolVersion: Schema.Literal(1),
  operations: Schema.Array(Schema.Literals(["capture", "diff", "record"])),
  features: Schema.optional(Schema.Array(Schema.Literals(["history", "artifact"]))),
})
export type VisualHostCapabilities = Schema.Schema.Type<typeof VisualHostCapabilities>

export const HostCapabilities = Schema.Struct({
  maxSnapshotBytes: Schema.Number,
  maxResultBytes: Schema.Number,
  supportedAppearances: Schema.Array(Schema.Literals(["system", "light", "dark"])),
  supportsRecording: Schema.Boolean,
  cdp: Schema.Boolean,
  /** Additive protocol-v2 capability: a real-Chrome extension lane is currently reachable. */
  chrome: Schema.optional(Schema.Literal(true)),
  /**
   * Additive protocol-v2 capability. `true` is the early capture/diff-only
   * spelling; structured hosts advertise the exact SnapEye protocol and
   * operation set without requiring a browser protocol bump.
   */
  visual: Schema.optional(Schema.Union([Schema.Literal(true), VisualHostCapabilities])),
})
export type HostCapabilities = Schema.Schema.Type<typeof HostCapabilities>

export const HostGuestState = Schema.Struct({
  attached: Schema.Boolean,
  activeTabId: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
})
export type HostGuestState = Schema.Schema.Type<typeof HostGuestState>

/**
 * A tab's owner — exactly one of `user` (human-opened / orphaned / unassigned)
 * or `agent(<sessionId>)` (a chat session owns the tab). A tab is never owned by
 * two owners; two agents never share a tab (single-agent exclusivity).
 */
export const HostOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("agent"), sessionId: Session.ID }),
])
export type HostOwner = Schema.Schema.Type<typeof HostOwner>

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
 * Payload the host POSTs to the sidecar hello endpoint. Registration is
 * session-agnostic: the browser is ONE shared instance owned by the app window,
 * never by a session. The registry is keyed by window/hostId only, so the
 * registration carries no session identity — just the host's callback
 * reachability. Sessions own TABS (see `HostOwner`/`GuestTabState`), not hosts.
 */
export const HostRegistration = Schema.Struct({
  ...HostHello.fields,
  callbackUrl: Schema.String,
  callbackToken: Schema.String,
})
export type HostRegistration = Schema.Schema.Type<typeof HostRegistration>

/** Debug listing row — registration minus the callback bearer token. */
export const HostRegistrationInfo = Schema.Struct({
  protocolVersion: Schema.Number,
  hostId: Schema.String,
  hostEpoch: Schema.Number,
  connectionId: Schema.String,
  windowId: Schema.String,
  capabilities: HostCapabilities,
  guest: HostGuestState,
  callbackUrl: Schema.String,
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
  owner: HostOwner,
  active: Schema.Boolean,
  muted: Schema.Boolean,
})
export type GuestTabState = Schema.Schema.Type<typeof GuestTabState>

export const HostEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("guest.crashed"), tabId: Schema.String, timestamp: Schema.String }),
  Schema.Struct({ type: Schema.Literal("guest.stateChanged"), tab: GuestTabState, timestamp: Schema.String }),
  Schema.Struct({ type: Schema.Literal("host.stopping"), timestamp: Schema.String }),
  Schema.Struct({ type: Schema.Literal("request.aborted"), requestId: Schema.String, timestamp: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tab.closed"), tabId: Schema.String, timestamp: Schema.String }),
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
  tabId: Schema.optional(Schema.String),
  claim: Schema.optional(Schema.Boolean),
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

// --- deterministic visual observation (SnapEye) -----------------------------

// Keep the model-facing contract inside the documented SnapEye v0.4 envelope
// and add bounds around the few browser-owned knobs SnapEye intentionally leaves
// configurable (notably filmstrip geometry and MediaRecorder bitrate). This is
// a trust boundary, not merely input cosmetics: an enormous filmstrip gap can
// otherwise manufacture a very large canvas after the recording frame budget
// has already done its job.
// These intentionally mirror Desktop's SnapEye path-safety identifiers so bad
// identity never crosses the broker boundary merely to be rejected later by
// the host store. Baseline names may contain single dots; `..` is forbidden.
const VisualName = Schema.String.check(
  Schema.isPattern(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
)
const VisualRunId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/),
)
const VisualSelector = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const VisualWaitMs = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(60_000),
)
const VisualTimeoutMs = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(60_000),
)
const VisualOperationTimeoutMs = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(120_000),
)
const VisualInspectionTimeoutMs = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(30_000),
)
const VisualScale = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0.1),
  Schema.isLessThanOrEqualTo(2),
)
const VisualSelectorList = Schema.Array(VisualSelector).check(Schema.isMaxLength(64))
const VisualAttributeName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const VisualAttributeNames = Schema.Array(VisualAttributeName).check(Schema.isMaxLength(32))
const VisualRedactionAttributes = Schema.Array(Schema.Struct({
  selector: VisualSelector,
  names: VisualAttributeNames,
})).check(Schema.isMaxLength(64))
const VisualDurationMs = PositiveInt.check(Schema.isLessThanOrEqualTo(15_000))
const VisualFps = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(30),
)
// MediaRecorder buffers its chunks in the renderer before the host sees the
// artifact. 20 Mbps for the maximum 15 s record is ~37.5 MB before container
// overhead, leaving useful headroom under the 64 MiB per-artifact host ceiling.
const VisualBitrate = PositiveInt.check(Schema.isLessThanOrEqualTo(20_000_000))
const VisualFilmstripCells = PositiveInt.check(Schema.isLessThanOrEqualTo(150))
const VisualFilmstripColumns = PositiveInt.check(Schema.isLessThanOrEqualTo(150))
const VisualFilmstripWidth = PositiveInt.check(Schema.isLessThanOrEqualTo(4096))
const VisualFilmstripGap = NonNegativeInt.check(Schema.isLessThanOrEqualTo(128))
const VisualFilmstripBackground = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const VisualThreshold = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1),
)
const VisualTileSize = PositiveInt.check(Schema.isLessThanOrEqualTo(1024))
const VisualGapTiles = NonNegativeInt.check(Schema.isLessThanOrEqualTo(64))
const VisualRegionDimension = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000),
)
const VisualMaxRegions = NonNegativeInt.check(Schema.isLessThanOrEqualTo(256))

export const VisualTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("document") }),
  Schema.Struct({ kind: Schema.Literal("css"), selector: VisualSelector }),
  Schema.Struct({ kind: Schema.Literal("element"), target: ElementTarget }),
])
export type VisualTarget = Schema.Schema.Type<typeof VisualTarget>

export const VisualWaitFor = Schema.Union([VisualWaitMs, VisualSelector])

export const VisualRedaction = Schema.Struct({
  blocks: Schema.optional(VisualSelectorList),
  attributes: Schema.optional(VisualRedactionAttributes),
})
export type VisualRedaction = Schema.Schema.Type<typeof VisualRedaction>

export const VisualBaseInput = {
  tabId: Schema.optional(Schema.String),
  name: VisualName,
  runId: Schema.optional(VisualRunId),
  target: Schema.optional(VisualTarget),
  stabilize: Schema.optional(Schema.Boolean),
  waitFor: Schema.optional(VisualWaitFor),
  waitTimeout: Schema.optional(VisualTimeoutMs),
  settle: Schema.optional(Schema.Boolean),
  settleTimeout: Schema.optional(VisualTimeoutMs),
  scale: Schema.optional(VisualScale),
  svg: Schema.optional(Schema.Boolean),
  redact: Schema.optional(VisualRedaction),
  timeoutMs: Schema.optional(VisualOperationTimeoutMs),
}

export const VisualCaptureInput = Schema.Struct(VisualBaseInput)
export type VisualCaptureInput = Schema.Schema.Type<typeof VisualCaptureInput>

export const VisualDiffInput = Schema.Struct({
  ...VisualBaseInput,
  threshold: Schema.optional(VisualThreshold),
  includeAA: Schema.optional(Schema.Boolean),
  diffMask: Schema.optional(Schema.Boolean),
  tileSize: Schema.optional(VisualTileSize),
  gapTiles: Schema.optional(VisualGapTiles),
  minRegionCssSide: Schema.optional(VisualRegionDimension),
  minRegionCssArea: Schema.optional(VisualRegionDimension),
  maxRegions: Schema.optional(VisualMaxRegions),
})
export type VisualDiffInput = Schema.Schema.Type<typeof VisualDiffInput>

export const VisualRecordInput = Schema.Struct({
  ...VisualBaseInput,
  duration: Schema.optional(VisualDurationMs),
  fps: Schema.optional(VisualFps),
  format: Schema.optional(Schema.Literals(["gif", "video", "both"])),
  bitrate: Schema.optional(VisualBitrate),
  filmstripMaxCells: Schema.optional(VisualFilmstripCells),
  filmstripMaxColumns: Schema.optional(VisualFilmstripColumns),
  filmstripMaxWidth: Schema.optional(VisualFilmstripWidth),
  filmstripGap: Schema.optional(VisualFilmstripGap),
  filmstripBackground: Schema.optional(VisualFilmstripBackground),
})
export type VisualRecordInput = Schema.Schema.Type<typeof VisualRecordInput>

export const VisualTargetMetadata = Schema.Struct({
  selector: Schema.optional(Schema.String),
  descriptor: Schema.optional(Schema.String),
})

export const VisualImageMetadata = Schema.Struct({
  coordinateSpace: Schema.Literal("target-css-px"),
  cssWidth: Schema.Number,
  cssHeight: Schema.Number,
  pixelWidth: Schema.Number,
  pixelHeight: Schema.Number,
  scale: Schema.Number,
})

export const VisualArtifactPaths = Schema.Struct({
  baseline: Schema.optional(Schema.String),
  current: Schema.optional(Schema.String),
  svg: Schema.optional(Schema.String),
  diff: Schema.optional(Schema.String),
  frames: Schema.optional(Schema.String),
  gif: Schema.optional(Schema.String),
  video: Schema.optional(Schema.String),
})

export const VisualEnvironment = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  lane: Schema.Literals(["webview", "extension"]),
  platform: Schema.String,
  engine: Schema.Literal("chromium"),
  engineMajor: Schema.optional(Schema.Number),
  appearance: Schema.optional(Schema.Literals(["system", "light", "dark"])),
  snapeyeVersion: Schema.optional(Schema.String),
  snapdomVersion: Schema.optional(Schema.String),
  redactionPolicySha256: Schema.optional(Schema.String),
})

export const VisualDiffRegion = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  aggregate: Schema.Boolean,
})

export const VisualDiffMetadata = Schema.Struct({
  changed: Schema.Boolean,
  changedRatio: Schema.Number,
  regionCount: Schema.Number,
  regionsTruncated: Schema.Boolean,
  regions: Schema.Array(VisualDiffRegion),
})

export const VisualFilmstripCell = Schema.Struct({
  cell: Schema.Number,
  frameIndex: Schema.Number,
  timestampMs: Schema.Number,
  x: Schema.Number,
  y: Schema.Number,
})

export const VisualFilmstripMetadata = Schema.Struct({
  file: Schema.Literal("frames.png"),
  columns: Schema.Number,
  rows: Schema.Number,
  cellWidth: Schema.Number,
  cellHeight: Schema.Number,
  gap: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  cells: Schema.Array(VisualFilmstripCell),
})

export const VisualRecordMetadata = Schema.Struct({
  durationRequestedMs: Schema.Number,
  durationActualMs: Schema.Number,
  fpsRequested: Schema.Number,
  fpsActual: Schema.Number,
  frameCount: Schema.Number,
  timestampsMs: Schema.Array(Schema.Number),
  format: Schema.Literals(["gif", "video", "both"]),
  filmstrip: VisualFilmstripMetadata,
})

export const VisualErrorPayload = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
})

export const VisualCaptureResult = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    protocolVersion: Schema.Literal(1),
    runId: Schema.String,
    status: Schema.Literal("ok"),
    operation: Schema.Literal("capture"),
    name: Schema.String,
    target: VisualTargetMetadata,
    startedAt: Schema.optional(Schema.String),
    finishedAt: Schema.optional(Schema.String),
    image: VisualImageMetadata,
    timing: Schema.Struct({ captureMs: Schema.Number }),
    artifacts: VisualArtifactPaths,
    opencode: Schema.optional(VisualEnvironment),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    protocolVersion: Schema.Literal(1),
    runId: Schema.String,
    status: Schema.Literal("error"),
    operation: Schema.Literal("capture"),
    name: Schema.optional(Schema.String),
    target: Schema.optional(VisualTargetMetadata),
    startedAt: Schema.optional(Schema.String),
    finishedAt: Schema.optional(Schema.String),
    error: VisualErrorPayload,
    opencode: Schema.optional(VisualEnvironment),
  }),
])

export const VisualDiffResult = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    protocolVersion: Schema.Literal(1),
    runId: Schema.String,
    status: Schema.Literal("ok"),
    operation: Schema.Literal("diff"),
    name: Schema.String,
    target: VisualTargetMetadata,
    startedAt: Schema.optional(Schema.String),
    finishedAt: Schema.optional(Schema.String),
    image: VisualImageMetadata,
    timing: Schema.Struct({ captureMs: Schema.Number }),
    diff: VisualDiffMetadata,
    artifacts: VisualArtifactPaths,
    opencode: Schema.optional(VisualEnvironment),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    protocolVersion: Schema.Literal(1),
    runId: Schema.String,
    status: Schema.Literal("error"),
    operation: Schema.Literal("diff"),
    name: Schema.optional(Schema.String),
    target: Schema.optional(VisualTargetMetadata),
    startedAt: Schema.optional(Schema.String),
    finishedAt: Schema.optional(Schema.String),
    error: VisualErrorPayload,
    opencode: Schema.optional(VisualEnvironment),
  }),
])

export const VisualRecordResult = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    protocolVersion: Schema.Literal(1),
    runId: Schema.String,
    status: Schema.Literal("ok"),
    operation: Schema.Literal("record"),
    name: Schema.String,
    target: VisualTargetMetadata,
    startedAt: Schema.optional(Schema.String),
    finishedAt: Schema.optional(Schema.String),
    image: VisualImageMetadata,
    record: VisualRecordMetadata,
    artifacts: VisualArtifactPaths,
    opencode: Schema.optional(VisualEnvironment),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    protocolVersion: Schema.Literal(1),
    runId: Schema.String,
    status: Schema.Literal("error"),
    operation: Schema.Literal("record"),
    name: Schema.optional(Schema.String),
    target: Schema.optional(VisualTargetMetadata),
    startedAt: Schema.optional(Schema.String),
    finishedAt: Schema.optional(Schema.String),
    error: VisualErrorPayload,
    opencode: Schema.optional(VisualEnvironment),
  }),
])

export const VisualCaptureOutput = Schema.Struct({ visual: VisualCaptureResult })
export const VisualDiffOutput = Schema.Struct({ visual: VisualDiffResult })
export const VisualRecordOutput = Schema.Struct({ visual: VisualRecordResult })

export const VisualHistoryInput = Schema.Struct({
  maxRuns: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  maxBaselines: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
  timeoutMs: Schema.optional(VisualInspectionTimeoutMs),
})
export type VisualHistoryInput = Schema.Schema.Type<typeof VisualHistoryInput>

export const VisualArtifactKind = Schema.Literals([
  "baseline",
  "baseline_metadata",
  "current",
  "svg",
  "diff",
  "frames",
  "gif",
  "video",
  "result",
])
export type VisualArtifactKind = Schema.Schema.Type<typeof VisualArtifactKind>

export const VisualArtifactInput = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("baseline"),
    name: VisualName,
    artifact: Schema.optional(Schema.Literals(["image", "metadata"])),
    timeoutMs: Schema.optional(VisualInspectionTimeoutMs),
  }),
  Schema.Struct({
    source: Schema.Literal("run"),
    runId: VisualRunId,
    artifact: Schema.Literals(["current", "svg", "diff", "frames", "gif", "video", "result"]),
    timeoutMs: Schema.optional(VisualInspectionTimeoutMs),
  }),
])
export type VisualArtifactInput = Schema.Schema.Type<typeof VisualArtifactInput>

export const VisualBaselineSummary = Schema.Struct({
  name: Schema.String,
  imagePath: Schema.String,
  metadataPath: Schema.optional(Schema.String),
  byteLength: Schema.Number,
  capturedAt: Schema.optional(Schema.String),
  lane: Schema.optional(Schema.Literals(["webview", "extension"])),
  engineMajor: Schema.optional(Schema.Number),
  redactionPolicySha256: Schema.optional(Schema.String),
})

export const VisualRunSummary = Schema.Struct({
  runId: Schema.String,
  resultPath: Schema.String,
  status: Schema.Literals(["ok", "error"]),
  operation: Schema.Literals(["capture", "diff", "record", "unknown"]),
  name: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  changed: Schema.optional(Schema.Boolean),
  frameCount: Schema.optional(Schema.Number),
  artifacts: Schema.Array(VisualArtifactKind),
})

export const VisualHistoryOutput = Schema.Struct({
  history: Schema.Struct({
    root: Schema.Literal(".snapeye"),
    baselines: Schema.Array(VisualBaselineSummary),
    runs: Schema.Array(VisualRunSummary),
  }),
})
export type VisualHistoryOutput = Schema.Schema.Type<typeof VisualHistoryOutput>

export const VisualArtifactDescriptor = Schema.Struct({
  kind: VisualArtifactKind,
  path: Schema.String,
  mime: Schema.String,
  byteLength: Schema.Number,
})

export const VisualArtifactOutput = Schema.Struct({
  artifact: Schema.NullOr(VisualArtifactDescriptor),
})
export type VisualArtifactOutput = Schema.Schema.Type<typeof VisualArtifactOutput>

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

export const OpenDevtoolsInput = Schema.Struct({
  tabId: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
})

export const OpenDevtoolsOutput = Schema.Struct({
  devtools: Schema.Struct({
    tabId: Schema.String,
    open: Schema.Boolean,
  }),
})

export const ExtensionsListInput = Schema.Struct({
  tabId: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
})

export const ExtensionInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  enabled: Schema.Boolean,
})

export const ExtensionsListOutput = Schema.Struct({
  extensions: Schema.Array(ExtensionInfo),
})

// --- per-operation outputs (explicit success objects, never void) ------------

/** One tab row of the FULL shared-host tab list (D5/D12). `status` returns every
 * tab — user-owned and every session's — so agents can see the shared browser.
 * Read is broad; CONTROL stays ownership-scoped. */
export const SessionTabInfo = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  active: Schema.Boolean,
  owner: HostOwner,
  muted: Schema.Boolean,
})
export type SessionTabInfo = Schema.Schema.Type<typeof SessionTabInfo>

export const StatusOutput = Schema.Struct({
  status: BrowserState,
  tabs: Schema.Array(SessionTabInfo),
})

export const OpenOutput = Schema.Struct({
  opened: Schema.Struct({
    tabId: Schema.String,
    url: Schema.String,
    title: Schema.String,
    readyState: Schema.String,
    viewport: Viewport,
    owner: HostOwner,
  }),
})

export const ClaimInput = Schema.Struct({
  tabId: Schema.String,
  timeoutMs: Schema.optional(Schema.Number),
})
export type ClaimInput = Schema.Schema.Type<typeof ClaimInput>

export const ClaimOutput = Schema.Struct({
  claimed: Schema.Struct({
    tabId: Schema.String,
    owner: HostOwner,
  }),
})
export type ClaimOutput = Schema.Schema.Type<typeof ClaimOutput>

/** Broker-minted control op (from user-initiated `assign`); never an agent tool. */
export const SetTabOwnerInput = Schema.Struct({
  tabId: Schema.String,
  owner: HostOwner,
})
export type SetTabOwnerInput = Schema.Schema.Type<typeof SetTabOwnerInput>

export const SetTabOwnerOutput = Schema.Struct({
  assigned: Schema.Struct({
    tabId: Schema.String,
    owner: HostOwner,
  }),
})
export type SetTabOwnerOutput = Schema.Schema.Type<typeof SetTabOwnerOutput>

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
      mime: Schema.Literals(["video/webm", "image/gif", "text/html"]),
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

export const DevtoolsOutput = OpenDevtoolsOutput
export const ExtensionsOutput = ExtensionsListOutput

// --- operation tagged union --------------------------------------------------

export const BrowserOperation = Schema.Union([
  Schema.Struct({ name: Schema.Literal("status"), input: Schema.Unknown }),
  Schema.Struct({ name: Schema.Literal("open"), input: OpenInput }),
  Schema.Struct({ name: Schema.Literal("claim"), input: ClaimInput }),
  Schema.Struct({ name: Schema.Literal("set_tab_owner"), input: SetTabOwnerInput }),
  Schema.Struct({ name: Schema.Literal("navigate"), input: NavigateInput }),
  Schema.Struct({ name: Schema.Literal("resize"), input: ResizeInput }),
  Schema.Struct({ name: Schema.Literal("set_appearance"), input: SetAppearanceInput }),
  Schema.Struct({ name: Schema.Literal("snapshot"), input: SnapshotInput }),
  Schema.Struct({ name: Schema.Literal("screenshot"), input: ScreenshotInput }),
  Schema.Struct({ name: Schema.Literal("visual_capture"), input: VisualCaptureInput }),
  Schema.Struct({ name: Schema.Literal("visual_diff"), input: VisualDiffInput }),
  Schema.Struct({ name: Schema.Literal("visual_record"), input: VisualRecordInput }),
  Schema.Struct({ name: Schema.Literal("visual_history"), input: VisualHistoryInput }),
  Schema.Struct({ name: Schema.Literal("visual_artifact"), input: VisualArtifactInput }),
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
  Schema.Struct({ name: Schema.Literal("open_devtools"), input: OpenDevtoolsInput }),
  Schema.Struct({ name: Schema.Literal("extensions_list"), input: ExtensionsListInput }),
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

/** User-initiated ownership change (D7) — fully general: `owner` may be `user`
 * ("Return to me") or `agent(<sessionId>)` (assign to a session, or REASSIGN
 * from one session to another). Invoked from the UI/main via `POST
 * /api/browser/assign` — never from an agent tool (agents only `claim`). */
export const AssignRequest = Schema.Struct({
  tabId: Schema.String,
  owner: HostOwner,
})
export type AssignRequest = Schema.Schema.Type<typeof AssignRequest>

export const AssignResponse = Schema.Struct({
  data: Schema.Struct({
    tabId: Schema.String,
    owner: HostOwner,
  }),
})
export type AssignResponse = Schema.Schema.Type<typeof AssignResponse>

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
          "Register (or re-register) a Desktop browser host connection. Registration is session-agnostic and keyed by window: last hello wins per windowId; a new connectionId supersedes the old one and in-flight requests against the old connection fail with BrowserControlInterrupted.",
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
  .add(
    HttpApiEndpoint.post("browser.assign", "/api/browser/assign", {
      payload: AssignRequest,
      success: AssignResponse,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.browser.assign",
        summary: "Assign a tab to an owner",
        description:
          "User-initiated ownership change: assign a tab to a session, reassign from one session to another, or return it to the user (owner { kind: 'user' }). The user may set any owner — this is the user-authority channel, never an agent tool.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "browser", description: "Desktop browser host broker." }))
