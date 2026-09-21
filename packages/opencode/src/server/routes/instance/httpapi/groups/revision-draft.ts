import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const RevisionDraftPaths = {
  recover: "/revision-draft/recover",
  consume: "/revision-draft/consume",
} as const

export const RevisionDraftRecoverPayload = Schema.Struct({
  kind: RevisionDraft.Kind,
  key: Schema.String,
})

export const RevisionDraftConsumePayload = Schema.Struct({
  id: Schema.String,
})

export const RevisionDraftApi = HttpApi.make("revisionDraft").add(
  HttpApiGroup.make("revisionDraft")
    .add(
      HttpApiEndpoint.post("recover", RevisionDraftPaths.recover, {
        payload: RevisionDraftRecoverPayload,
        success: described(Schema.NullOr(RevisionDraft.Artifact), "Pending revision artifact"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "revisionDraft.recover",
          summary: "Recover a pending editor revision",
          description:
            "Bootstrap-free durable lookup of the latest accepted revision for a globally stable editor target. Never materializes a workspace Instance.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("consume", RevisionDraftPaths.consume, {
        payload: RevisionDraftConsumePayload,
        success: Schema.Void,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "revisionDraft.consume",
          summary: "Acknowledge a recovered editor revision",
          description:
            "Delete exactly one pending revision by immutable artifact id. An acknowledgement for an older generation cannot delete a newer replacement.",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(
      OpenApi.annotations({
        title: "revision draft",
        description: "Bootstrap-free durable handoff for model-produced editor revisions.",
      }),
    ),
)
