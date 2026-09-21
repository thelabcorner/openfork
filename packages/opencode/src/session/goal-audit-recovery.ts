import { Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "./prompt"

/**
 * Process-start recovery for the one Goal state that otherwise has no wake
 * source: a focused automatic Goal is durably `verifying`, but no automation
 * cursor exists. The durable owning Session supplies the exact directory, and
 * InstanceStore provides that location before any Tier-3 model/runtime work.
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

    for (const orphan of yield* automation.orphanedAuditSessions()) {
      yield* instances
        .provide(
          { directory: orphan.directory },
          prompt.auditGoal(orphan.sessionID).pipe(Effect.provideService(WorkspaceRef, orphan.workspaceID)),
        )
        .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("orphaned Goal audit recovery failed", {
            sessionID: orphan.sessionID,
            directory: orphan.directory,
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
  name: "goal-audit-recovery",
  layer,
  deps: [GoalAutomation.node, SessionPrompt.node, InstanceStore.node],
})

export * as GoalAuditRecovery from "./goal-audit-recovery"
