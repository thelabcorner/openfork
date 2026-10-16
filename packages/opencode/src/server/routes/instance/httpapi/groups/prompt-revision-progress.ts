import { RevisionProgress } from "@opencode-ai/core/revision-progress"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const PromptRevisionProgressPaths = {
  get: "/prompt/revise/progress",
} as const

export const PromptRevisionProgressQuery = Schema.Struct({
  operationID: Schema.String,
})

export const PromptRevisionProgressApi = HttpApi.make("promptRevisionProgress").add(
  HttpApiGroup.make("promptRevisionProgress")
    .add(
      HttpApiEndpoint.get("get", PromptRevisionProgressPaths.get, {
        query: PromptRevisionProgressQuery,
        success: described(Schema.NullOr(RevisionProgress.Snapshot), "Latest advisory revision progress"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "prompt.revisionProgress",
          summary: "Read live prompt revision progress",
          description:
            "Latest-value read of one in-flight Prompt Revisor operation, keyed by the client-owned correlation id sent with the revise request. Advisory display state only; null while idle or after settle. Process-global memory only and never materializes a workspace Instance.",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(
      OpenApi.annotations({
        title: "prompt revision progress",
        description: "Bootstrap-free live progress projection for an in-flight prompt revision.",
      }),
    ),
)
