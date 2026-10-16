import { Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "./prompt"
import { Session } from "./session"

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
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const active = new Set<string>()
    const MAX_ACTIVE_AUDITS = 2

    const recover = Effect.fnUntraced(function* (orphan) {
      if (active.has(orphan.sessionID) || active.size >= MAX_ACTIVE_AUDITS) return
      // Pause is a user-owned execution fence, not a transient recovery error.
      // Keep the durable audit request; normal resume can make it runnable.
      const session = yield* sessions.get(orphan.sessionID).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Goal audit recovery cannot read parent Session; retrying later", {
            sessionID: orphan.sessionID, cause,
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (!session || session.pausedAt !== undefined) return
      if (active.has(orphan.sessionID) || active.size >= MAX_ACTIVE_AUDITS) return
      active.add(orphan.sessionID)
      // Admission must not await the full independent audit (bounded to five
      // minutes). Otherwise two slow provider requests hold the scanner's
      // concurrency slots for their entire lifetime, starving every later
      // recoverable Goal. The owning service Scope supervises detached audits
      // and interrupts them on shutdown; the durable lease handles recovery.
      yield* instances
        .provide(
          { directory: orphan.directory },
          prompt.recoverGoalAudit(orphan.sessionID).pipe(Effect.provideService(WorkspaceRef, orphan.workspaceID)),
        )
        .pipe(
          // The auditor's five-minute budget starts after model resolution
          // and child provisioning. Bound the whole *recovery attempt* too:
          // otherwise a hung provider catalog/workspace bootstrap can occupy
          // one of the two recovery slots forever. This is not a Goal lifetime
          // or turn ceiling; interruption preserves durable audit recovery.
          Effect.timeout("7 minutes"),
          Effect.catchCause((cause) =>
            Effect.logError("orphaned Goal audit recovery failed", {
              sessionID: orphan.sessionID,
              directory: orphan.directory,
              cause,
            }),
          ),
          Effect.ensuring(Effect.sync(() => { active.delete(orphan.sessionID) })),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
    })

    // A restart can recover many orphaned Goals at once, but a one-shot
    // startup sweep permanently lost Goals when initialization encountered a
    // temporary DB/workspace failure. Reconcile durably until shutdown with
    // bounded audit activation. Audits themselves have their own per-cycle
    // budget; there is no arbitrary Goal lifetime or continuation ceiling.
    yield* Effect.gen(function* () {
      while (true) {
        const orphans = yield* automation.orphanedAuditSessions().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Goal audit recovery scan will retry", { cause }).pipe(
              Effect.as([]),
            ),
          ),
        )
        // This only admits detached work. The active set bounds real provider
        // execution, rather than occupying the scanner until each audit ends.
        yield* Effect.forEach(orphans, recover, { concurrency: 2, discard: true })
        yield* Effect.sleep("60 seconds")
      }
    }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
  }),
)

export const node = makeGlobalNode({
  name: "goal-audit-recovery",
  layer,
  deps: [GoalAutomation.node, SessionPrompt.node, InstanceStore.node, Session.node],
})

export * as GoalAuditRecovery from "./goal-audit-recovery"
