import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { QuestionNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/question"
const ReplyPayload = Schema.Struct({
  answers: Schema.Array(Question.Answer).annotate({
    description: "Selected option labels in question order",
  }),
  details: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional free-form response text in question order; empty string means no details",
  }),
})

export const QuestionApi = HttpApi.make("question")
  .add(
    HttpApiGroup.make("question")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Question.Request), "List of pending questions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.list",
            summary: "List pending questions",
            description: "Get all pending question requests across all sessions.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "question",
          description: "Question routes.",
        }),
      )
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "OpenFork HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )

export const QuestionControlApi = HttpApi.make("question-control").add(
  HttpApiGroup.make("questionControl")
    .add(
      HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
        params: { requestID: QuestionID },
        query: WorkspaceRoutingQuery,
        payload: ReplyPayload,
        success: described(Schema.Boolean, "Question answered successfully"),
        error: [HttpApiError.BadRequest, QuestionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "question.reply",
          summary: "Reply to question request",
          description: "Answer an active question without loading a workspace Instance.",
        }),
      ),
      HttpApiEndpoint.post("reject", `${root}/:requestID/reject`, {
        params: { requestID: QuestionID },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Question rejected successfully"),
        error: [HttpApiError.BadRequest, QuestionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "question.reject",
          summary: "Reject question request",
          description: "Reject an active question without loading a workspace Instance.",
        }),
      ),
    )
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
