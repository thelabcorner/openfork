import { ModelV2 } from "@opencode-ai/core/model"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { PromptRevisor } from "@opencode-ai/core/prompt-revisor"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"
import { described } from "./metadata"

export const PromptRevisorPayload = Schema.Struct({
  prompt: Schema.String,
  draft: Schema.optional(PromptRevisor.DraftContext),
  sessionID: Schema.optional(SessionSchema.ID),
  guidance: Schema.optional(Schema.String),
  model: Schema.optional(ModelV2.Ref),
  fallbackModel: Schema.optional(ModelV2.Ref),
  clarifications: Schema.optional(
    Schema.Array(
      Schema.Struct({
        question: Schema.String,
        answers: Schema.Array(Schema.String),
        detail: Schema.optional(Schema.String),
      }),
    ),
  ),
  clarificationRound: Schema.optional(Schema.Number),
})

export const PromptRevisorResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("revision"),
    prompt: Schema.String,
    references: Schema.Array(PromptRevisor.RevisedPromptReference),
    tools: Schema.Array(Schema.String),
    rounds: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("question"),
    questions: Schema.Array(QuestionV2.Prompt),
    clarificationRound: Schema.Number,
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
            "Rewrite a draft prompt with an optional dedicated model, bounded read-only workspace reconnaissance, and stateless clarification interrupts.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
