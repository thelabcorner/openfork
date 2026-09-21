import { ModelV2 } from "@opencode-ai/core/model"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { PromptRevisor } from "@opencode-ai/core/prompt-revisor"
import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"
import { described } from "./metadata"

export const PromptRevisorPayload = Schema.Struct({
  prompt: Schema.String,
  purpose: Schema.optional(PromptRevisor.Purpose),
  target: Schema.optional(RevisionDraft.Target),
  draft: Schema.optional(PromptRevisor.DraftContext),
  sessionID: Schema.optional(SessionSchema.ID),
  includeSessionContext: Schema.optional(Schema.Boolean),
  guidance: Schema.optional(Schema.String),
  model: Schema.optional(ModelV2.Ref),
  fallbackModel: Schema.optional(ModelV2.Ref),
})

export const PromptRevisorResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("revision"),
    prompt: Schema.String,
    references: Schema.Array(PromptRevisor.RevisedPromptReference),
    tools: Schema.Array(Schema.String),
    rounds: Schema.Number,
    artifactID: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("cancelled"),
    tools: Schema.Array(Schema.String),
    rounds: Schema.Number,
  }),
])

export const PromptRevisorPaths = {
  revise: "/prompt/revise",
} as const

export const PromptRevisorApi = HttpApi.make("prompt-revisor").add(
  HttpApiGroup.make("prompt-revisor")
    .add(
      HttpApiEndpoint.post("revise", PromptRevisorPaths.revise, {
        query: WorkspaceRoutingQuery,
        payload: PromptRevisorPayload,
        success: described(PromptRevisorResponse, "Prompt revision result"),
        error: [InvalidRequestError, ServiceUnavailableError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "prompt.revise",
          summary: "Revise a draft prompt",
          description:
            "Rewrite a draft prompt with an optional dedicated model, bounded read-only workspace reconnaissance, and session-owned clarification through the canonical question lifecycle.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
