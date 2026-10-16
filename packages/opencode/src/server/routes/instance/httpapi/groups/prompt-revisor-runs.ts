import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

/**
 * Tier-0 lifecycle surface for detached Prompt Revisor runs.
 *
 * The revise POST no longer owns the run: a client disconnect (tab switch,
 * reload) abandons only the waiter while the revision completes and commits to
 * the durable `RevisionDraft` mailbox. A returning composer therefore needs two
 * process-global reads with no workspace Instance behind them:
 *
 * - `status` answers "running vs recently failed vs untracked" for the stable
 *   `RevisionDraft` locator, so a client can show the in-flight state or the
 *   retained failure instead of silently losing the operation;
 * - `cancel` is first-class user cancellation, because a raw HTTP abort no
 *   longer stops the run.
 *
 * The registry is process memory only; both endpoints stay in `RootHttpApi`
 * and never cross the instance-context or workspace-routing middleware.
 */

export const PromptRevisorRunPaths = {
  status: "/prompt/revise/run",
  cancel: "/prompt/revise/cancel",
} as const

export const PromptRevisorRunQuery = Schema.Struct({
  kind: RevisionDraft.Kind,
  key: Schema.String,
})

export const PromptRevisorRunCancelPayload = Schema.Struct({
  kind: RevisionDraft.Kind,
  key: Schema.String,
  operationID: Schema.optional(Schema.String),
})

export const PromptRevisorRunStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("running"),
    sourceFingerprint: Schema.String,
    operationID: Schema.optional(Schema.String),
    startedAt: Schema.Number,
  }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    sourceFingerprint: Schema.String,
    message: Schema.String,
    at: Schema.Number,
  }),
])

export const PromptRevisorRunsApi = HttpApi.make("promptRevisorRuns").add(
  HttpApiGroup.make("promptRevisorRuns")
    .add(
      HttpApiEndpoint.get("status", PromptRevisorRunPaths.status, {
        query: PromptRevisorRunQuery,
        success: described(
          Schema.NullOr(PromptRevisorRunStatus),
          "In-flight or recently failed revision run, or null when untracked",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "prompt.revisionRunStatus",
          summary: "Read a detached revision run's lifecycle state",
          description:
            "Process-global running/failed lookup for one stable revision target. Null when no run is in flight and no bounded-TTL failure is retained. Never materializes a workspace Instance.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("cancel", PromptRevisorRunPaths.cancel, {
        payload: PromptRevisorRunCancelPayload,
        success: described(Schema.Boolean, "Whether an in-flight run was cancelled"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "prompt.cancelRevision",
          summary: "Cancel an in-flight revision run",
          description:
            "Explicit first-class cancellation for a detached Prompt Revisor run. A client disconnect only abandons a waiter; this endpoint actually ends the run. When both sides know the correlation id, a mismatched cancel is refused. Never materializes a workspace Instance.",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(
      OpenApi.annotations({
        title: "prompt revisor runs",
        description: "Bootstrap-free lifecycle control for detached prompt revision runs.",
      }),
    ),
)
