import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionLimitRecovery } from "@opencode-ai/core/session/limit-recovery"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionLimitRecovery as SessionLimitRecoveryContract } from "@opencode-ai/schema/session-limit-recovery"
import { retrySqliteBusyCause } from "@opencode-ai/core/database/sqlite-busy"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "./session"
import { SessionPrompt } from "./prompt"

export * as LimitRecoveryRunner from "./limit-recovery-runner"

const MAX_SLEEP_MS = 60_000
const MAX_BATCH = 50
const DISPATCH_CONCURRENCY = 2
const ERROR_BACKOFF_BASE_MS = 500
const ERROR_BACKOFF_CAP_MS = 10_000

export type Cursor = { readonly sessionID: string; readonly generation: number }

/**
 * Small single-clock primitive used by the process-global owner below.
 *
 * It never trusts a long timer: durable truth is re-read at least once per
 * minute, every mutation can wake it early, and one coalesced wake bit closes
 * the timer-vs-dispatch race without overlapping batches.
 */
export function make(input: {
  readonly nextDueAt: () => Promise<number | undefined>
  readonly due: (now: number, limit: number) => Promise<readonly Cursor[]>
  readonly dispatch: (cursor: Cursor) => Promise<void>
  readonly concurrency?: number
  readonly onError?: (error: unknown) => void
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let running = false
  let wakePending = false
  let armRevision = 0
  let consecutiveFailures = 0
  let retryNotBefore = 0

  const failed = (error: unknown) => {
    const delay = Math.min(ERROR_BACKOFF_CAP_MS, ERROR_BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures++, 6))
    retryNotBefore = Math.max(retryNotBefore, Date.now() + delay)
    input.onError?.(error)
  }

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  const arm = async () => {
    if (stopped || running) return
    const revision = ++armRevision
    clearTimer()
    try {
      const dueAt = await input.nextDueAt()
      // A wake/stop/tick that arrived while durable truth was loading owns the
      // clock now. Never let the stale async arm overwrite its timer.
      if (stopped || running || revision !== armRevision) return
      const delay = Math.max(
        0,
        Math.min(MAX_SLEEP_MS, Math.max(dueAt ?? Date.now() + MAX_SLEEP_MS, retryNotBefore) - Date.now()),
      )
      timer = setTimeout(() => {
        timer = undefined
        void tick()
      }, delay)
    } catch (error) {
      if (stopped || revision !== armRevision) return
      failed(error)
      timer = setTimeout(() => {
        timer = undefined
        void tick()
      }, Math.min(MAX_SLEEP_MS, Math.max(ERROR_BACKOFF_BASE_MS, retryNotBefore - Date.now())))
    }
  }

  const tick = async () => {
    if (stopped) return
    // A wake must not bypass the cooldown after a failed SQLite claim. Without
    // this guard a permanently overdue cursor spins at the native busy timeout.
    if (Date.now() < retryNotBefore) {
      void arm()
      return
    }
    if (running) {
      wakePending = true
      return
    }
    // Invalidate any in-flight async arm before this batch becomes the
    // single clock owner.
    armRevision += 1
    clearTimer()
    running = true
    let batchFailed = false
    try {
      const rows = await input.due(Date.now(), MAX_BATCH)
      const concurrency = Math.max(1, Math.min(input.concurrency ?? 4, 8))
      let index = 0
      await Promise.all(
        Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
          while (!stopped) {
            const cursor = rows[index++]
            if (!cursor) return
            try {
              await input.dispatch(cursor)
            } catch (error) {
              batchFailed = true
              failed(error)
              // A failed SQLite claim is generally database-wide contention.
              // Do not hammer the remaining 48 overdue cursors in this batch.
              return
            }
          }
        }),
      )
    } catch (error) {
      batchFailed = true
      failed(error)
    } finally {
      if (!batchFailed) {
        consecutiveFailures = 0
        retryNotBefore = 0
      }
      running = false
      const again = wakePending
      wakePending = false
      if (!stopped) {
        if (again) void tick()
        else void arm()
      }
    }
  }

  return {
    start() {
      stopped = false
      armRevision += 1
      clearTimer()
      void tick()
    },
    wake() {
      if (stopped) return
      armRevision += 1
      clearTimer()
      if (running) wakePending = true
      else void tick()
    },
    stop() {
      stopped = true
      armRevision += 1
      clearTimer()
    },
  }
}

/**
 * Durable usage-limit recovery deadline owner.
 *
 * The cursor/claim lives in Core; this layer owns only clocking and Tier-3
 * Session activation. A claim prevents peer processes from initiating the same
 * wake, while SessionExecutionOwner remains the final execution exclusion gate.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database.Service
    // Limit recovery is durable control-plane scheduling, not foreground
    // Session history. Reuse the existing dedicated control connection so a
    // pathological primary SELECT cannot delay deadline scans/claims and
    // cascade into retries across sessions. Injectable fixtures retain db.
    const db = database.controlDb ? yield* database.controlDb() : database.db
    const runtime = yield* RuntimeOwner.Service
    const execution = yield* SessionExecutionOwner.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const instances = yield* InstanceStore.Service
    const events = yield* EventV2Bridge.Service

    const clear = Effect.fn("LimitRecoveryRunner.clear")(function* (cursor: Cursor) {
      const sessionID = SessionSchema.ID.make(cursor.sessionID)
      const cleared = yield* SessionLimitRecovery.cancel(db, {
        sessionID,
        generation: cursor.generation,
      })
      if (cleared) {
        yield* events.publish(SessionLimitRecoveryContract.Cleared, {
          sessionID,
          generation: cursor.generation,
        })
      }
      return cleared
    })

    const dispatch = Effect.fn("LimitRecoveryRunner.dispatch")(function* (cursor: Cursor) {
      const sessionID = SessionSchema.ID.make(cursor.sessionID)
      const claimed = yield* retrySqliteBusyCause(
        () => SessionLimitRecovery.claim(db, {
          sessionID,
          generation: cursor.generation,
          owner: runtime.id,
          now: Date.now(),
        }),
        { maxElapsedMs: 2_000, delayMs: 35, maxDelayMs: 250 },
      )
      if (!claimed) return

      const session = yield* sessions.get(sessionID).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("limit recovery has no durable Session", {
            sessionID,
            generation: cursor.generation,
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (!session) {
        // The recovery row is session-owned (FK cascade), so a missing durable
        // Session is terminal cursor corruption rather than a transient wake
        // failure. Clearing it prevents an already-due zero-delay retry loop.
        yield* clear(cursor)
        return
      }

      // Pause/archive are explicit human lifecycle decisions, not temporary
      // provider blockers. They invalidate unattended continuation authority.
      if (session.pausedAt !== undefined || session.time.archived !== undefined) {
        yield* prompt.retireLimitRecoveryContinuations(sessionID)
        yield* clear(cursor)
        return
      }

      // A live owner will observe the due cursor at its next provider-cycle
      // boundary. Keep this short claim until expiry rather than spinning a
      // second cold activation against the same Session.
      if ((yield* execution.snapshot(sessionID)).ownerID) return

      yield* instances
        .provide(
          { directory: session.directory },
          prompt.loop({ sessionID }).pipe(Effect.provideService(WorkspaceRef, session.workspaceID)),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              // Close the owner-check/activation race. If another process won
              // Session ownership, the claim expiry is the next durable wake.
              if ((yield* execution.snapshot(sessionID)).ownerID) return
              // Keep the claim until expiry. Releasing an already-due cursor
              // makes nextDueAt() return a past timestamp and can spin at 0 ms
              // on a persistent bootstrap/configuration failure.
              yield* Effect.logError("limit recovery Session activation failed", {
                sessionID,
                generation: cursor.generation,
                directory: session.directory,
                cause,
              })
            }),
          ),
        )

      // Successful recovery materialization deletes the cursor. If the loop
      // returned normally while this generation is still due (for example a
      // pending permission/question gate), keep the short claim until expiry.
      // Releasing it here would make nextDueAt() return an already-elapsed reset
      // and create a zero-delay cold-activation loop. Explicit session activity
      // can still resume the cursor immediately; claim expiry is only the
      // background fallback.
      const remaining = yield* SessionLimitRecovery.get(db, sessionID)
      if (
        remaining?.generation === cursor.generation &&
        remaining.claimOwner === runtime.id
      ) {
        yield* Effect.logDebug("limit recovery remains pending after activation; retaining claim backoff", {
          sessionID,
          generation: cursor.generation,
          claimExpiresAt: remaining.claimExpiresAt,
        })
      }
    })

    const runner = make({
      nextDueAt: () => Effect.runPromise(SessionLimitRecovery.nextDueAt(db)),
      due: (now, limit) =>
        Effect.runPromise(
          SessionLimitRecovery.due(db, now, limit).pipe(
            Effect.map((rows) => rows.map((row) => ({ sessionID: row.sessionID, generation: row.generation }))),
          ),
        ),
      dispatch: (cursor) => Effect.runPromise(dispatch(cursor)),
      concurrency: DISPATCH_CONCURRENCY,
      onError: (error) => {
        void Effect.runPromise(
          Effect.logError("limit recovery deadline runner failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      },
    })

    const unsubscribe = yield* events.listen((event) => {
      if (
        event.type === SessionLimitRecoveryContract.Updated.type ||
        event.type === SessionLimitRecoveryContract.Cleared.type
      ) {
        return Effect.sync(() => runner.wake())
      }
      return Effect.void
    })

    runner.start()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => runner.stop()).pipe(Effect.ensuring(unsubscribe)),
    )
  }),
)

export const node = makeGlobalNode({
  name: "limit-recovery-runner",
  layer,
  deps: [
    Database.node,
    RuntimeOwner.node,
    SessionExecutionOwner.node,
    Session.node,
    SessionPrompt.node,
    InstanceStore.node,
    EventV2Bridge.node,
  ],
})
