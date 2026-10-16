import { SessionContext } from "@opencode-ai/schema/session-context"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { HttpApiError } from "effect/unstable/httpapi"
import { described } from "./metadata"

// One UI gesture emits one operation, while callers can apply bounded batches.
// Keep event payload size and target-probe work predictable under malformed
// clients rather than accepting arbitrarily many SQLite/index probes.
export const CONTEXT_OPS_MAX_BATCH = 256
export const ContextOpsPayload = Schema.Struct({
  operations: Schema.Array(SessionContext.ContextOperation).check(Schema.isMaxLength(CONTEXT_OPS_MAX_BATCH)),
})

export const ForkWithContextPayload = Schema.Struct({
  messageID: Schema.optional(Schema.String),
  edge: Schema.optional(Schema.Literals(["before", "after"])),
  kind: Schema.optional(SessionContext.ForkOriginKind),
  workspaceMode: Schema.optional(SessionContext.WorkspaceMode),
})

export const SessionContextPaths = {
  ops: "/session/:sessionID/context/ops",
  opsHistory: "/session/:sessionID/context/ops/history",
  ledger: "/session/:sessionID/context/ledger",
  ledgerPage: "/session/:sessionID/context/ledger/page",
  ledgerTotals: "/session/:sessionID/context/ledger/totals",
  preview: "/session/:sessionID/context/preview",
  forkOrigin: "/session/:sessionID/fork-origin",
} as const

export const SessionContextApi = HttpApi.make("session-context")
  .add(
    HttpApiGroup.make("session-context")
      .add(
        HttpApiEndpoint.post("applyOps", SessionContextPaths.ops, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ContextOpsPayload,
          success: described(
            Schema.Struct({
              batchID: Schema.String,
              timestamp: Schema.Number,
            }),
            "Context ops applied",
          ),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-context.applyOps",
            summary: "Apply context operations",
            description:
              "Apply a batch of context operations (exclude, include, edit, pin, etc.) as one durable event. Reversible by applying inverse ops.",
          }),
        ),
        HttpApiEndpoint.get("opsHistory", SessionContextPaths.opsHistory, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.Array(
              Schema.Struct({
                id: Schema.String,
                batchID: Schema.String,
                operations: Schema.Array(Schema.Unknown),
                timestamp: Schema.Number,
              }),
            ),
            "Context operation history",
          ),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-context.opsHistory",
            summary: "Get context operation history",
            description: "Retrieve the audit trail of context operations for a session.",
          }),
        ),
        HttpApiEndpoint.get("ledger", SessionContextPaths.ledger, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(SessionContext.Ledger, "Context ledger"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-context.ledger",
            summary: "Get context ledger",
            description:
              "Retrieve the actionable context ledger: per-message token estimates, exclusion/edit/pin status, and totals. Occupancy vs spend vs cache are separate.",
          }),
        ),
        HttpApiEndpoint.get("ledgerPage", SessionContextPaths.ledgerPage, {
          params: { sessionID: SessionID },
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            limit: Schema.optional(Schema.Int),
            cursor: Schema.optional(Schema.String),
          }),
          success: described(Schema.Struct({
            sessionID: SessionID,
            entries: Schema.Array(SessionContext.LedgerEntry),
            authoritativeTotals: Schema.optional(SessionContext.Ledger.fields.totals),
            revision: Schema.Number,
            hasMore: Schema.Boolean,
            nextCursor: Schema.optional(Schema.String),
            mode: Schema.Literals(["chronological", "compacted"]),
          }), "Bounded Context ledger page"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-context.ledgerPage",
            summary: "Page context ledger without hydrating the entire transcript",
            description: "Keyset pagination for ordinary V1 sessions; canonical compaction-aware fallback.",
          }),
        ),
        HttpApiEndpoint.get("ledgerTotals", SessionContextPaths.ledgerTotals, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Struct({
            revision: Schema.Number,
            totals: Schema.optional(SessionContext.Ledger.fields.totals),
          }), "Authoritative full-history Context totals when producer facts permit"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-context.ledgerTotals",
            summary: "Get authoritative Context totals independently of message paging",
            description: "Read-only SQLite aggregate from durable part facts; missing totals indicate legacy, opaque, or compaction history.",
          }),
        ),
        HttpApiEndpoint.get("preview", SessionContextPaths.preview, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.Struct({
              beforeTokens: Schema.Number,
              afterTokens: Schema.Number,
              removedTokens: Schema.Number,
              messageCount: Schema.Number,
              effectiveCount: Schema.Number,
              earliestMutationIndex: Schema.optional(Schema.Number),
            }),
            "Context preview",
          ),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-context.preview",
            summary: "Preview next request context",
            description: "Show before/after token counts and effective context size without mutating.",
          }),
        ),
        HttpApiEndpoint.get("forkOrigin", SessionContextPaths.forkOrigin, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.Struct({
              sessionID: SessionID,
              parentSessionID: SessionID,
              sourceMessageID: Schema.optional(Schema.String),
              edge: Schema.optional(Schema.String),
              kind: Schema.String,
              workspaceMode: Schema.String,
              createdAt: Schema.Number,
            }),
            "Fork origin",
          ),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-context.forkOrigin",
            summary: "Get fork origin",
            description: "Retrieve lineage metadata for a forked session.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session-context",
          description: "Conversation Control: Context ledger, ops, fork provenance.",
        }),
      )
      // Context is durable session inspection/mutation. Its handlers need
      // Session (global DB-backed) and workspace routing for local/remote
      // ownership, but no execution Instance, plugins, or warmup. Loading an
      // Instance here made merely opening Context compete with running tools.
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "OpenFork session-context HttpApi",
      version: "0.0.1",
      description: "Fork-owned conversation control routes.",
    }),
  )
