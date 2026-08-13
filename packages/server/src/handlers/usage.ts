import { SessionUsage } from "@opencode-ai/core/session/usage"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const UsageHandler = HttpApiBuilder.group(Api, "server.usage", (handlers) =>
  handlers.handle(
    "usage.go",
    Effect.fn(function* () {
      return yield* (yield* SessionUsage.Service).goPlan()
    }),
  ),
)
