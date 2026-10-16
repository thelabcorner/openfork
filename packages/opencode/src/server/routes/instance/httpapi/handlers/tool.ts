import { ToolReload } from "@/tool/reload"
import { ToolInterrupt } from "@/tool/interrupt"
import { BackgroundJob } from "@/background/job"
import { Database } from "@opencode-ai/core/database/database"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { SessionLegacyToolIndex } from "@opencode-ai/core/session/legacy-tool-index"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionOperatorRecovery } from "@/session/operator-stop"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { KillPayload } from "../groups/tool"

export const toolHandlers = HttpApiBuilder.group(InstanceHttpApi, "tool", (handlers) =>
  Effect.gen(function* () {
    const toolReload = yield* ToolReload.Service
    const interrupt = yield* ToolInterrupt.Service
    const background = yield* BackgroundJob.Service
    const { db } = yield* Database.Service
    const owner = yield* SessionExecutionOwner.Service
    const runtime = yield* RuntimeOwner.Service
    const session = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const automation = yield* GoalAutomation.Service
    const status = yield* SessionStatus.Service
    const operatorRecovery = yield* SessionOperatorRecovery.Service

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
        if (killed) return { killed: true }
        const sessionID = SessionID.make(input.sessionID)
        const unresolved = yield* SessionLegacyToolIndex.exists(db, {
          sessionID, callID: input.callID, unsettled: true,
        })
        if (!unresolved) return { killed: false }
        const observed = yield* owner.snapshot(sessionID)
        if (!observed.ownerID || (yield* runtime.proveLocalDeath(observed.ownerID)) === "dead") {
          // An operator Stop must converge even after executor death. Pause
          // before sealing unknown outcomes so recovery cannot replay effects
          // through a Goal or queued provider drain.
          const result = yield* operatorRecovery.recover(sessionID, observed.generation)
          if (result === "recovered") yield* automation.cancel(sessionID)
          return { killed: result === "recovered", status: result, generation: observed.generation }
        }
        const requested = yield* owner.requestInterrupt(sessionID, "operator", observed.generation)
        if (requested.state === "requested") {
          const result = yield* SessionRunState.cancelActiveHandle(sessionID, requested.token.generation)
          return { killed: true, status: result === "cancelled" ? "cancelled" : "stopping" }
        }
        return { killed: false, status: "stale" }
      }
      return { killed: false }
    })

    return handlers.handle("reload", reload).handle("kill", kill)
  }),
)
