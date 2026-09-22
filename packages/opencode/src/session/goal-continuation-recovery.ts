import { Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "./prompt"
import { Session } from "./session"

/**
 * Process-start recovery for durable Goal continuation reservations.
 *
 * GoalAutomation requeues claims owned by a dead process when its layer starts.
 * Requeueing is only the durable half of recovery: a pending reservation also
 * needs an execution wake. Without this owner, an active Goal can remain
 * continuation_pending forever after backend restart until unrelated traffic
 * happens to wake the Session.
 *
 * The durable Session row supplies the exact directory/workspace identity.
 * Paused Sessions are excluded by GoalAutomation.pendingSessions(); their normal
 * resume path is the explicit wake source.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const automation = yield* GoalAutomation.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const scope = yield* Scope.Scope

    for (const sessionID of yield* automation.pendingSessions()) {
      const pending = yield* sessions.get(sessionID).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("pending Goal continuation has no durable Session", { sessionID, cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      if (!pending || pending.pausedAt !== undefined) continue
      yield* instances
        .provide(
          { directory: pending.directory },
          prompt.loop({ sessionID }).pipe(
            Effect.provideService(WorkspaceRef, pending.workspaceID),
          ),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("pending Goal continuation recovery failed", {
              sessionID,
              directory: pending.directory,
              cause,
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.ignore,
        )
    }
  }),
)

export const node = makeGlobalNode({
  name: "goal-continuation-recovery",
  layer,
  deps: [GoalAutomation.node, SessionPrompt.node, Session.node, InstanceStore.node],
})

export * as GoalContinuationRecovery from "./goal-continuation-recovery"