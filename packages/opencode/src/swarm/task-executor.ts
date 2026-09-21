export * as SwarmTaskExecutor from "./task-executor"

import { Cause, Context, Effect, Layer, Option } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRuntimePolicy } from "@opencode-ai/core/swarm/runtime-policy"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmRuntimeRetention } from "./runtime-retention"
import { SwarmSessionAdmission } from "./session-admission"

export type Result =
  | {
      readonly state: "admitted"
      readonly taskID: Swarm.TaskID
      readonly memberID: Swarm.MemberID
      readonly runID: Swarm.TaskRunID
      readonly sessionInputID: SessionMessage.ID
    }
  | {
      readonly state: "skipped"
      readonly taskID: Swarm.TaskID
      readonly reason: string
    }
  | {
      readonly state: "released"
      readonly taskID: Swarm.TaskID
      readonly reason: string
    }

export interface Interface {
  readonly execute: (assignment: SwarmV2.ReadyAssignment) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmTaskExecutor") {}

function reasonOf(value: unknown) {
  if (value instanceof Error) return value.message
  if (typeof value === "object" && value !== null && "reason" in value) return String((value as { reason: unknown }).reason)
  return String(value)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const swarm = yield* SwarmV2.Service
    const admission = yield* SwarmSessionAdmission.Service
    const ownership = yield* SwarmRuntimeRetention.Service

    const execute: Interface["execute"] = Effect.fn("SwarmTaskExecutor.execute")(function* (assignment) {
      yield* ownership.ensure()
      const claimed = yield* swarm
        .claimTask({
          swarmID: assignment.task.swarmID,
          taskID: assignment.task.id,
          memberID: assignment.member.id,
          processOwner: ownership.ownerID,
          leaseMs: SwarmRuntimePolicy.TASK_LEASE_MS,
        })
        .pipe(Effect.exit)
      if (claimed._tag === "Failure") {
        yield* ownership.reconcile()
        return { state: "skipped", taskID: assignment.task.id, reason: claimed.cause.toString() }
      }

      const runID = Swarm.TaskRunID.create()
      const sessionInputID = SessionMessage.ID.create()
      const admitted = yield* admission
        .assignment({
          token: claimed.value.token,
          runID,
          sessionInputID,
          task: assignment.task,
        })
        .pipe(Effect.exit)
      if (admitted._tag === "Success") {
        yield* ownership.reconcile()
        return {
          state: "admitted",
          taskID: assignment.task.id,
          memberID: assignment.member.id,
          runID,
          sessionInputID,
        }
      }

      const error = Option.getOrUndefined(Cause.findErrorOption(admitted.cause))
      const retirementReason =
        error instanceof SwarmSessionAdmission.HumanFocusConflict
          ? "human_focus"
          : error instanceof SwarmSessionAdmission.TargetSessionMissingError
            ? "member_rebind"
            : "recovery"
      // The Session admission transaction did not commit, therefore this task
      // assignment provably never began execution. That is the quiescence proof
      // allowing immediate operational supersession without semantic retry.
      yield* swarm
        .requestTaskRetirement({ token: claimed.value.token, reason: retirementReason })
        .pipe(
          Effect.flatMap(() =>
            swarm.settleTask({
              token: claimed.value.token,
              settlement: { type: "superseded", detail: reasonOf(error ?? admitted.cause) },
            }),
          ),
          Effect.ignore,
        )
      yield* ownership.reconcile()
      return {
        state: "released",
        taskID: assignment.task.id,
        reason: reasonOf(error ?? admitted.cause),
      }
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SwarmV2.node, SwarmSessionAdmission.node, SwarmRuntimeRetention.node],
})
