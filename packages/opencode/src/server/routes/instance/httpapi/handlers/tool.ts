import { ToolReload } from "@/tool/reload"
import { ToolInterrupt } from "@/tool/interrupt"
import { BackgroundJob } from "@/background/job"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { KillPayload } from "../groups/tool"

export const toolHandlers = HttpApiBuilder.group(InstanceHttpApi, "tool", (handlers) =>
  Effect.gen(function* () {
    const toolReload = yield* ToolReload.Service
    const interrupt = yield* ToolInterrupt.Service
    const background = yield* BackgroundJob.Service

    const reload = Effect.fn("ToolHttpApi.reload")(function* () {
      const result = yield* toolReload.reload("manual")
      if (!result.ok) return { ok: false as const, error: result.error ?? "Tool reload failed" }
      return { ok: true as const, added: result.added, updated: result.updated, removed: result.removed }
    })

    const kill = Effect.fn("ToolHttpApi.kill")(function* (ctx: {
      payload: Schema.Schema.Type<typeof KillPayload>
    }) {
      const input = ctx.payload
      if (input.jobId) {
        const info = yield* background.get(input.jobId)
        if (!info || info.status !== "running") {
          return { killed: false, ...(info ? { status: info.status } : {}) }
        }
        yield* background.cancel(input.jobId)
        return { killed: true, status: "cancelled" }
      }
      if (input.callID) {
        const killed = yield* interrupt.kill({ sessionID: input.sessionID, callID: input.callID })
        return { killed }
      }
      return { killed: false }
    })

    return handlers.handle("reload", reload).handle("kill", kill)
  }),
)
