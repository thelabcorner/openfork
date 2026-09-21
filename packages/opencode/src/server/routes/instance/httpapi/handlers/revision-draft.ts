import { RevisionDraft } from "@opencode-ai/core/revision-draft"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { RevisionDraftConsumePayload, RevisionDraftRecoverPayload } from "../groups/revision-draft"

export const revisionDraftHandlers = HttpApiBuilder.group(RootHttpApi, "revisionDraft", (handlers) =>
  Effect.gen(function* () {
    const drafts = yield* RevisionDraft.Service
    return handlers
      .handle("recover", (ctx: { payload: typeof RevisionDraftRecoverPayload.Type }) =>
        drafts
          .recover({
            kind: ctx.payload.kind,
            key: ctx.payload.key,
          })
          .pipe(Effect.map((value) => value ?? null)),
      )
      .handle("consume", (ctx: { payload: typeof RevisionDraftConsumePayload.Type }) => drafts.consume(ctx.payload.id))
  }),
)
