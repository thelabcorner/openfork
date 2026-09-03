import { SessionContext } from "@opencode-ai/schema/session-context"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { HttpApiError } from "effect/unstable/httpapi"
import { described } from "./metadata"

export const ContextOpsPayload = Schema.Struct({
  operations: Schema.Array(SessionContext.ContextOperation),
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
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode session-context HttpApi",
      version: "0.0.1",
      description: "Fork-owned conversation control routes.",
    }),
  )
