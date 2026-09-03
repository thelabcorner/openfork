export * as SessionContext from "./session-context"

import { Schema } from "effect"
import { SessionID } from "./session-id"
import { NonNegativeInt, optional } from "./schema"
import { statics } from "./schema"
import { Event } from "./event"

// ── Operation types ───────────────────────────────────────────────

export const ForkBoundary = Schema.Struct({
  messageID: Schema.String.pipe(Schema.brand("MessageID")),
  edge: Schema.Literals(["before", "after"]),
  partID: Schema.optional(Schema.String.pipe(Schema.brand("PartID"))),
}).annotate({ identifier: "SessionContextForkBoundary" })
export type ForkBoundary = typeof ForkBoundary.Type

export const ForkOriginKind = Schema.Literals(["manual", "regenerate", "temporary", "model-comparison"])
export type ForkOriginKind = typeof ForkOriginKind.Type

export const WorkspaceMode = Schema.Literals(["shared-current", "new-worktree"])
export type WorkspaceMode = typeof WorkspaceMode.Type

export const ContextOperationType = Schema.Literals([
  "message.exclude",
  "message.include",
  "text.replace",
  "text.restore",
  "message.pin",
  "message.unpin",
  "tool.collapse",
  "tool.restore",
  "range.summarize",
  "summary.remove",
  "content.redact",
  "content.unredact",
])
export type ContextOperationType = typeof ContextOperationType.Type

// Base operation envelope — each op targets a message or part.
export const ContextOperation = Schema.Union(
  [
    Schema.Struct({
      type: Schema.Literal("message.exclude"),
      messageID: Schema.String.pipe(Schema.brand("MessageID")),
    }),
    Schema.Struct({
      type: Schema.Literal("message.include"),
      messageID: Schema.String.pipe(Schema.brand("MessageID")),
    }),
    Schema.Struct({
      type: Schema.Literal("text.replace"),
      messageID: Schema.String.pipe(Schema.brand("MessageID")),
      partID: optional(Schema.String.pipe(Schema.brand("PartID"))),
      content: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("text.restore"),
      messageID: Schema.String.pipe(Schema.brand("MessageID")),
      partID: optional(Schema.String.pipe(Schema.brand("PartID"))),
    }),
    Schema.Struct({
      type: Schema.Literal("message.pin"),
      messageID: Schema.String.pipe(Schema.brand("MessageID")),
    }),
    Schema.Struct({
      type: Schema.Literal("message.unpin"),
      messageID: Schema.String.pipe(Schema.brand("MessageID")),
    }),
    Schema.Struct({
      type: Schema.Literal("tool.collapse"),
      messageID: Schema.String.pipe(Schema.brand("MessageID")),
      partID: Schema.String.pipe(Schema.brand("PartID")),
    }),
    Schema.Struct({
      type: Schema.Literal("tool.restore"),
      messageID: Schema.String.pipe(Schema.brand("MessageID")),
      partID: Schema.String.pipe(Schema.brand("PartID")),
    }),
  ],
  { mode: "oneOf" } as any,
).annotate({ identifier: "SessionContextOperation" })
export type ContextOperation = typeof ContextOperation.Type

export const ContextOpsBatch = Schema.Struct({
  sessionID: SessionID,
  batchID: Schema.String.pipe(
    Schema.brand("ContextBatchID"),
    statics((s) => ({ create: () => s.make("ctx_" + Math.random().toString(36).slice(2, 10)) })),
  ),
  operations: Schema.Array(ContextOperation),
  timestamp: NonNegativeInt,
}).annotate({ identifier: "SessionContextOpsBatch" })
export type ContextOpsBatch = typeof ContextOpsBatch.Type

// ── Fork origin ───────────────────────────────────────────────────

export const ForkOrigin = Schema.Struct({
  sessionID: SessionID,
  parentSessionID: SessionID,
  sourceMessageID: optional(Schema.String.pipe(Schema.brand("MessageID"))),
  sourceSeq: optional(NonNegativeInt),
  edge: Schema.Literals(["before", "after"]).pipe(optional),
  kind: ForkOriginKind,
  workspaceMode: WorkspaceMode,
  createdAt: NonNegativeInt,
}).annotate({ identifier: "SessionForkOrigin" })
export type ForkOrigin = typeof ForkOrigin.Type

// ── Ledger ────────────────────────────────────────────────────────

export const LedgerEntryType = Schema.Literals(["system", "user", "assistant", "tool", "compaction"])
export type LedgerEntryType = typeof LedgerEntryType.Type

export const LedgerEntry = Schema.Struct({
  messageID: Schema.String.pipe(Schema.brand("MessageID")),
  type: LedgerEntryType,
  role: Schema.String,
  preview: Schema.String,
  tokenEstimate: NonNegativeInt,
  excluded: Schema.Boolean,
  pinned: Schema.Boolean,
  edited: Schema.Boolean,
  hasSignedReasoning: Schema.Boolean,
  partCount: NonNegativeInt,
  timeCreated: NonNegativeInt,
}).annotate({ identifier: "SessionContextLedgerEntry" })
export type LedgerEntry = typeof LedgerEntry.Type

export const Ledger = Schema.Struct({
  sessionID: SessionID,
  entries: Schema.Array(LedgerEntry),
  totals: Schema.Struct({
    messageCount: NonNegativeInt,
    excludedCount: NonNegativeInt,
    pinnedCount: NonNegativeInt,
    editedCount: NonNegativeInt,
    estimatedTokens: NonNegativeInt,
    estimatedTokensExcluded: NonNegativeInt,
  }),
}).annotate({ identifier: "SessionContextLedger" })
export type Ledger = typeof Ledger.Type

// ── Context state projection ──────────────────────────────────────

export const MessageState = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.String.pipe(Schema.brand("MessageID")),
  excluded: Schema.Boolean,
  pinned: Schema.Boolean,
  overrideData: optional(Schema.Record(Schema.String, Schema.Unknown)),
  overrideSearchText: optional(Schema.String),
  modifiedSeq: optional(NonNegativeInt),
  modifiedAt: NonNegativeInt,
}).annotate({ identifier: "SessionContextMessageState" })
export type MessageState = typeof MessageState.Type

// ── Durable events (fork-owned) ─────────────────────────────────────

const durableOpts = { durable: { aggregate: "sessionID", version: 1 } } as const

export const ContextOpsApplied = Event.define({
  type: "session.context.ops.applied",
  ...durableOpts,
  schema: {
    sessionID: SessionID,
    batchID: Schema.String,
    operations: Schema.Array(ContextOperation),
    timestamp: NonNegativeInt,
  },
})

export const ForkCreated = Event.define({
  type: "session.fork.created",
  ...durableOpts,
  schema: {
    sessionID: SessionID,
    parentSessionID: SessionID,
    sourceMessageID: optional(Schema.String),
    edge: optional(Schema.Literals(["before", "after"])),
    kind: ForkOriginKind,
    workspaceMode: WorkspaceMode,
    createdAt: NonNegativeInt,
  },
})

export const DurableDefinitions = Event.inventory(ContextOpsApplied, ForkCreated)
export const AllDefinitions = Event.inventory(ContextOpsApplied, ForkCreated)
