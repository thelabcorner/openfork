import { PushV2 } from "@opencode-ai/core/push"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const PushHandler = HttpApiBuilder.group(Api, "server.push", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "push.publicKey.get",
        Effect.fn(function* () {
          const push = yield* PushV2.Service
          return { data: { publicKey: yield* push.publicKey() } }
        }),
      )
      .handle(
        "push.subscription.create",
        Effect.fn(function* (ctx) {
          const push = yield* PushV2.Service
          return { data: yield* push.subscribe(ctx.payload) }
        }),
      )
      .handle(
        "push.subscription.delete",
        Effect.fn(function* (ctx) {
          const push = yield* PushV2.Service
          yield* push.unsubscribeByEndpoint(ctx.query.endpoint)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
