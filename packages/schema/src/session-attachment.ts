export * as SessionAttachment from "./session-attachment"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { ascending } from "./identifier"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

/**
 * Durable handoff of a user-uploaded attachment from an orchestrating Session to
 * a delegated worker (V1 Task child, Native Swarm task run/member, or a future
 * first-party worker).
 *
 * Three facts are deliberately separate and must never be collapsed:
 *
 * - **selection** — the orchestrator asked for an attachment by symbolic handle;
 * - **grant** — access was authorized for one exact recipient identity;
 * - **inclusion** — the bytes were actually serialized into a provider request.
 *
 * A grant is not proof the model received or understood an image, and inclusion
 * is not a bearer token: every read is re-checked against durable source
 * ownership plus a live grant.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Logical upload identity. Stable across storage dedup and grant edges. */
export const ID = Schema.String.check(Schema.isStartsWith("att_")).pipe(
  Schema.brand("Session.Attachment.ID"),
  statics((schema) => ({ create: () => schema.make("att_" + ascending()) })),
)
export type ID = typeof ID.Type

/** Immutable content-addressed blob identity. Possessing it never grants access. */
export const BlobID = Schema.String.check(Schema.isStartsWith("abl_")).pipe(
  Schema.brand("Session.Attachment.BlobID"),
  statics((schema) => ({ create: () => schema.make("abl_" + ascending()) })),
)
export type BlobID = typeof BlobID.Type

/** Grant edge identity. One authorization for one recipient identity. */
export const GrantID = Schema.String.check(Schema.isStartsWith("agn_")).pipe(
  Schema.brand("Session.Attachment.GrantID"),
  statics((schema) => ({ create: () => schema.make("agn_" + ascending()) })),
)
export type GrantID = typeof GrantID.Type

/**
 * Model-visible symbolic handle. This is what an orchestrator selects. It is
 * deliberately short, human-readable in a compact manifest, and NOT the opaque
 * storage ID or a bearer token: the server validates it against the exact
 * triggering turn, an explicit index result, or an active grant.
 */
export const Handle = Schema.String.check(Schema.isStartsWith("upload-")).pipe(Schema.brand("Session.Attachment.Handle"))
export type Handle = typeof Handle.Type

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Durable, server-validated upload origin. Only semantic user uploads are
 * eligible for handoff. `file://` workspace references, MCP resources, and tool
 * output are never eligible merely because they also lower to a V1 `file` part.
 */
export const Origin = Schema.Literals(["user-upload", "workspace-file", "mcp-resource", "tool-output", "legacy-unknown"])
  .annotate({ identifier: "Session.Attachment.Origin" })
export type Origin = typeof Origin.Type

/** A MIME type eligible for handoff. Extended only from measured provider limits. */
export const Eligibility = Schema.Literals(["eligible", "unsupported-origin", "unsupported-mime", "over-budget"])
  .annotate({ identifier: "Session.Attachment.Eligibility" })
export type Eligibility = typeof Eligibility.Type

// ---------------------------------------------------------------------------
// Grant target
// ---------------------------------------------------------------------------

/**
 * Exact recipient identity for a grant. The destination is part of the handoff:
 * a Task grant belongs to that delegation invocation and child session; a Swarm
 * grant belongs to an exact task run and member session. A peer message can
 * never widen a grant.
 *
 * Durable V1 message identity uses the `msg`-prefixed V1 message id, which is a
 * different family from `SessionMessage.ID` (`msg_`). Message ids are carried as
 * opaque strings here so the browser-safe contract does not couple to the V1
 * serialization family; the durable owner validates them at write time.
 */
export const GrantTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("task"),
    /** Durable idempotency identity: source session + assistant message + tool call + tool part. */
    sourceSessionID: SessionID,
    assistantMessageID: Schema.String,
    toolCallID: Schema.String,
    toolPartID: Schema.String,
    childSessionID: SessionID,
  }),
  Schema.Struct({
    kind: Schema.Literal("swarm"),
    taskID: Schema.String,
    runID: Schema.String,
    sessionInputID: SessionMessage.ID,
    memberSessionID: SessionID,
  }),
])
  .pipe(Schema.toTaggedUnion("kind"))
  .annotate({ identifier: "Session.Attachment.GrantTarget" })
export type GrantTarget = typeof GrantTarget.Type

/**
 * Host-authored provenance lineage retained on a grant. This is audit lineage to
 * the original user-owned upload turn, distinct from the host-authored child
 * handoff turn, and never promotes the bytes to privileged/System authority.
 */
export interface Lineage extends Schema.Schema.Type<typeof Lineage> {}
export const Lineage = Schema.Struct({
  sourceSessionID: SessionID,
  sourceMessageID: Schema.String,
  sourcePartID: Schema.String,
}).annotate({ identifier: "Session.Attachment.Lineage" })

export const GrantState = Schema.Literals(["active", "revoked", "expired", "tombstoned"])
  .annotate({ identifier: "Session.Attachment.GrantState" })
export type GrantState = typeof GrantState.Type

// ---------------------------------------------------------------------------
// Manifests (compact, bounded, model- and UI-facing)
// ---------------------------------------------------------------------------

/**
 * One eligible attachment as presented to an orchestrator or the UI. Carries
 * only compact metadata; bytes are resolved separately and never inlined here.
 */
export interface ManifestEntry extends Schema.Schema.Type<typeof ManifestEntry> {}
export const ManifestEntry = Schema.Struct({
  handle: Handle,
  id: ID,
  filename: Schema.String.pipe(optional),
  mime: Schema.String,
  byteLength: NonNegativeInt,
  eligibility: Eligibility,
  /** Symbolic availability for a specific recipient; never a provider-comprehension claim. */
  availability: Schema.Literals(["available", "included", "unsupported", "revoked", "expired"]),
  /** The exact triggering turn this entry came from, when it is user-owned. */
  sourceMessageID: Schema.String.pipe(optional),
  sourcePartID: Schema.String.pipe(optional),
  grantID: GrantID.pipe(optional),
}).annotate({ identifier: "Session.Attachment.ManifestEntry" })

/**
 * Bounded orchestrator-visible manifest: current-turn uploads (when user-owned)
 * plus active grants already held by this worker. Older uploads are discoverable
 * only through the explicit paginated index lookup; this manifest never scans or
 * hydrates transcript history.
 */
export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}
export const Manifest = Schema.Struct({
  sessionID: SessionID,
  currentTurn: Schema.Array(ManifestEntry),
  activeGrants: Schema.Array(ManifestEntry),
  /** True when more eligible current-turn/active-grant entries were omitted by bounds. */
  truncated: Schema.Boolean,
}).annotate({ identifier: "Session.Attachment.Manifest" })

// ---------------------------------------------------------------------------
// Status (selection / authorization / resolution / inclusion)
// ---------------------------------------------------------------------------

/**
 * The four independent facts recorded for a handoff. `selected` and
 * `authorized` are orchestration facts; `resolved` and `included_in_provider_request`
 * are execution facts. A caller must never infer inclusion from a grant.
 */
export const HandoffStatus = Schema.Struct({
  selected: Schema.Boolean,
  authorized: Schema.Boolean,
  resolved: Schema.Boolean,
  /** True only when bytes were serialized into this exact recipient's provider request. */
  includedInProviderRequest: Schema.Boolean,
  reason: Schema.String.pipe(optional),
})
  .annotate({ identifier: "Session.Attachment.HandoffStatus" })
export type HandoffStatus = Schema.Schema.Type<typeof HandoffStatus>

/** Bounded per-recipient outcome, keyed by handle, safe to batch into a projection. */
export interface RecipientStatus extends Schema.Schema.Type<typeof RecipientStatus> {}
export const RecipientStatus = Schema.Struct({
  handle: Handle,
  status: HandoffStatus,
}).annotate({ identifier: "Session.Attachment.RecipientStatus" })

// ---------------------------------------------------------------------------
// Index (explicit paginated lookup for older session uploads)
// ---------------------------------------------------------------------------

export interface IndexEntry extends Schema.Schema.Type<typeof IndexEntry> {}
export const IndexEntry = Schema.Struct({
  handle: Handle,
  id: ID,
  filename: Schema.String.pipe(optional),
  mime: Schema.String,
  byteLength: NonNegativeInt,
  eligibility: Eligibility,
  sourceMessageID: Schema.String,
  sourcePartID: Schema.String,
  timeCreated: DateTimeUtcFromMillis,
}).annotate({ identifier: "Session.Attachment.IndexEntry" })

/** O(k) page of a session's eligible uploads, independent of transcript length. */
export interface IndexPage extends Schema.Schema.Type<typeof IndexPage> {}
export const IndexPage = Schema.Struct({
  sessionID: SessionID,
  items: Schema.Array(IndexEntry),
  nextCursor: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Attachment.IndexPage" })

// ---------------------------------------------------------------------------
// Bytes resolved for a provider request
// ---------------------------------------------------------------------------

/**
 * Server-internal resolution result. This is never part of a browser-safe
 * projection; it exists so a Tier-3 child execution path can serialize selected
 * bytes into its provider request. `url` stays an inline data URL (bounded
 * compatibility backing) or a blob-owner reference, never an arbitrary path/URL.
 */
export interface Resolved extends Schema.Schema.Type<typeof Resolved> {}
export const Resolved = Schema.Struct({
  handle: Handle,
  id: ID,
  mime: Schema.String,
  filename: Schema.String.pipe(optional),
  byteLength: NonNegativeInt,
  url: Schema.String,
}).annotate({ identifier: "Session.Attachment.Resolved" })

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Stable machine reasons a selection/read can fail closed. */
export const RejectionReason = Schema.Literals([
  "unknown-handle",
  "foreign-session",
  "not-current-turn",
  "not-in-index",
  "no-active-grant",
  "revoked",
  "expired",
  "tombstoned",
  "unsupported-origin",
  "unsupported-mime",
  "over-budget",
  "arbitrary-url",
])
  .annotate({ identifier: "Session.Attachment.RejectionReason" })
export type RejectionReason = typeof RejectionReason.Type
