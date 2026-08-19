import { ToolReload } from "@/tool/reload"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const toolHandlers = HttpApiBuilder.group(InstanceHttpApi, "tool", (handlers) =>
  Effect.gen(function* () {
    const toolReload = yield* ToolReload.Service

    const reload = Effect.fn("ToolHttpApi.reload")(function* () {
      const result = yield* toolReload.reload("manual")
      if (!result.ok) return { ok: false as const, error: result.error ?? "Tool reload failed" }
      return { ok: true as const, added: result.added, updated: result.updated, removed: result.removed }
    })

    return handlers.handle("reload", reload)
  }),
)
