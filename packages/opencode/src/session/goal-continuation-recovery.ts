import { Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionSchema } from "@opencode-ai/core/session/schema"
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
 * Paused Sessions remain durable pending work but are skipped here; their normal
 * resume path is the explicit wake source.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const automation = yield* GoalAutomation.Service
    const execution = yield* SessionExecutionOwner.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const scope = yield* Scope.Scope
    const failedSessions = new Set<SessionSchema.ID>()

    const recover = Effect.fnUntraced(function* (sessionID) {
      if (failedSessions.has(sessionID)) return false
      const pending = yield* sessions.get(sessionID).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            failedSessions.add(sessionID)
            return yield* Effect.logError("pending Goal continuation has no durable Session", { sessionID, cause }).pipe(
              Effect.as(undefined),
            )
          }),
        ),
      )
      if (!pending || pending.pausedAt !== undefined) return false
      // Startup recovery is a Tier-3 wake only when this process can own the
      // Session. A live durable owner will inspect pending Goal reservations at
      // its next provider-cycle boundary; activating its workspace here merely
      // pays config/plugin/tool bootstrap before SessionPrompt reports busy.
      if ((yield* execution.snapshot(sessionID)).ownerID) return true
      return yield* instances
        .provide(
          { directory: pending.directory },
          prompt.loop({ sessionID }).pipe(Effect.provideService(WorkspaceRef, pending.workspaceID)),
        )
        .pipe(Effect.as(false))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              // Close the owner-check/activation race. If another execution
              // acquired the Session after the snapshot, defer and retry from
              // the global pending index instead of treating contention as a
              // permanent recovery failure.
              if ((yield* execution.snapshot(sessionID)).ownerID) return true
              failedSessions.add(sessionID)
              yield* Effect.logError("pending Goal continuation recovery failed", {
                sessionID,
                directory: pending.directory,
                cause,
              })
              return false
            }),
          ),
        )
    })

    // Page durable work and admit at most two cold workspace activations. Busy
    // Sessions are rechecked with exponential backoff: their active loop usually
    // claims the reservation, while the retry closes the narrow race where the
    // owner reaches idle just before it observes that reservation.
    const recoverPending = Effect.gen(function* () {
      let delay = 1_000
      while (true) {
        let after: SessionSchema.ID | undefined
        let deferred = false
        while (true) {
          const page = yield* automation.pendingSessions({ after, limit: 128 })
          if (page.length === 0) break
          const results = yield* Effect.forEach(page, recover, { concurrency: 2 })
          if (results.some(Boolean)) deferred = true
          if (page.length < 128) break
          after = page.at(-1)
        }
        if (!deferred) return
        yield* Effect.sleep(delay)
        delay = Math.min(delay * 2, 30_000)
      }
    })
    yield* recoverPending.pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
  }),
)

export const node = makeGlobalNode({
  name: "goal-continuation-recovery",
  layer,
  deps: [GoalAutomation.node, SessionExecutionOwner.node, SessionPrompt.node, Session.node, InstanceStore.node],
})

export * as GoalContinuationRecovery from "./goal-continuation-recovery"
