import { Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "./prompt"

/**
 * Process-start recovery for focused automatic Goals durably `verifying` but
 * lacking an automation cursor. Recovery enters through the same durable
 * requestGoalAudit owner as UI/OXP verification so cursor creation, runner
 * quiescence, and auditor dispatch cannot diverge. The durable owning Session
 * supplies the exact directory before any Tier-3 model/runtime work.
 *
 * Explicit audit_error rows are excluded by GoalAutomation so a provider/auth
 * failure cannot become a reboot retry loop.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const automation = yield* GoalAutomation.Service
    const prompt = yield* SessionPrompt.Service
    const instances = yield* InstanceStore.Service
    const scope = yield* Scope.Scope

    const recover = Effect.fnUntraced(function* (orphan) {
      yield* instances
        .provide(
          { directory: orphan.directory },
          prompt.requestGoalAudit(orphan.sessionID).pipe(Effect.provideService(WorkspaceRef, orphan.workspaceID)),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("orphaned Goal audit recovery failed", {
              sessionID: orphan.sessionID,
              directory: orphan.directory,
              cause,
            }),
          ),
        )
    })

    // A restart can recover many orphaned Goals at once. Bound Tier-3
    // workspace/model activation like continuation recovery does, while
    // keeping the dispatcher detached from server bootstrap.
    yield* Effect.forEach(yield* automation.orphanedAuditSessions(), recover, {
      concurrency: 2,
      discard: true,
    }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
  }),
)

export const node = makeGlobalNode({
  name: "goal-audit-recovery",
  layer,
  deps: [GoalAutomation.node, SessionPrompt.node, InstanceStore.node],
})

export * as GoalAuditRecovery from "./goal-audit-recovery"
