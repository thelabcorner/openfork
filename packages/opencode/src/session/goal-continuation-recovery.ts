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
    // A permanently blacklisted Session cannot satisfy an unbounded Goal:
    // any transient workspace/provider/SQLite failure would strand it until
    // process restart. Retry with a bounded per-Session backoff instead.
    const retries = new Map<SessionSchema.ID, { failures: number; nextAt: number }>()
    const active = new Set<SessionSchema.ID>()
    let launchSlots = 0
    const postpone = (sessionID: SessionSchema.ID) => {
      const count = Math.min(10, (retries.get(sessionID)?.failures ?? 0) + 1)
      retries.set(sessionID, {
        failures: count,
        nextAt: Date.now() + Math.min(600_000, 5_000 * 2 ** (count - 1)),
      })
    }

    const recover = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      if (active.has(sessionID)) return true
      if ((retries.get(sessionID)?.nextAt ?? 0) > Date.now()) return true
      const pending = yield* sessions.get(sessionID).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            postpone(sessionID)
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
      if (launchSlots <= 0) return true
      launchSlots--
      active.add(sessionID)
      // The recovery *admission* is bounded, not the Goal's execution time.
      // Do not await prompt.loop(): a correctly autonomous Goal can run for
      // days, and that would starve every other durable pending Session.
      yield* instances.provide(
        { directory: pending.directory },
        prompt.loop({ sessionID }).pipe(Effect.provideService(WorkspaceRef, pending.workspaceID)),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const observed = yield* execution.snapshot(sessionID).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (observed?.ownerID) return
            yield* Effect.logError("pending Goal continuation recovery failed", {
              sessionID, directory: pending.directory, cause,
            })
          }),
        ),
        Effect.ensuring(Effect.sync(() => {
          active.delete(sessionID)
          // Avoid reactivating a still-pending reservation in a hot loop.
          // Backoff resets after the row leaves the pending index.
          postpone(sessionID)
        })),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )
      return true
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
        const observed = new Set<SessionSchema.ID>()
        launchSlots = 2
         while (true) {
           const page = yield* automation.pendingSessions({ after, limit: 128 }).pipe(
             Effect.catchCause((cause) =>
               Effect.logWarning("Goal continuation recovery scan will retry", { cause }).pipe(
                 Effect.as([] as ReadonlyArray<SessionSchema.ID>),
               ),
             ),
           )
          if (page.length === 0) break
          for (const sessionID of page) observed.add(sessionID)
          const results = yield* Effect.forEach(page, (id) => recover(id).pipe(
             Effect.catchCause((cause) =>
               Effect.logWarning("Goal continuation recovery admission will retry", { cause }).pipe(Effect.as(true)),
             ),
           ), { concurrency: 2 })
           if (results.some(Boolean)) deferred = true
           if (page.length < 128) break
           after = page.at(-1)
         }
          // Retain retry metadata only for pending or currently running Goals.
          // A desktop staying open for months must not accumulate completed IDs.
          for (const sessionID of retries.keys()) {
            if (!observed.has(sessionID) && !active.has(sessionID)) retries.delete(sessionID)
          }
          // Recovery is a lifelong process supervisor, not a one-shot startup
         // scan. A failed wake, newly committed continuation, or temporarily
         // missing workspace may become runnable long after startup.
         yield* Effect.sleep(deferred ? delay : 30_000)
         delay = deferred ? Math.min(delay * 2, 30_000) : 1_000
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
