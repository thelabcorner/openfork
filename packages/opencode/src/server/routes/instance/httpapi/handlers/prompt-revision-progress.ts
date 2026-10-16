import { RevisionProgress } from "@opencode-ai/core/revision-progress"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"

export const promptRevisionProgressHandlers = HttpApiBuilder.group(RootHttpApi, "promptRevisionProgress", (handlers) =>
  Effect.gen(function* () {
    const progress = yield* RevisionProgress.Service
    return handlers.handle("get", (ctx: { query: { operationID: string } }) =>
      progress.latest(ctx.query.operationID).pipe(Effect.map((value) => value ?? null)),
    )
  }),
)
