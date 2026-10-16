import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import { sqliteStatementClass } from "./sqlite-diagnostics"
import { sqliteQueryShape } from "./sqlite-query-shape"
import { sqliteFingerprint } from "./sqlite-query-forensics"
import { boundedSqlitePermit } from "./sqlite-acquire-timeout"

/**
 * Connection-local contention diagnostics. A timed-out waiter cannot reveal
 * which transaction owns the permit without recording ownership at acquisition.
 * Never retain SQL text, bind values, Session IDs, or stack traces.
 *
 * Recording an active statement also distinguishes a blocked native SQL
 * operation from a transaction holding the connection while awaiting other
 * Effect work (the latter is a potential dependency cycle).
 */
export function makeSqlitePermitTracker(
  semaphore: Semaphore.Semaphore,
  timeoutMs?: number,
  lane = "unspecified",
  monitor?: {
    /** Test-only override. Production's one-watch-per-contention schedule is 1s, 5s, 30s. */
    firstWarningMs?: number
    /** Optional diagnostic sink; defaults to the Effect logger. */
    warn?: (snapshot: string) => Effect.Effect<void>
    /** Native worker activity read without IPC even if sqlite3_step is blocked. */
    worker?: () => string
    /** Override the slow-statement threshold for tests. Production defaults to 2 seconds. */
    slowWarningMs?: number
    /** Optional privacy-safe slow-statement diagnostic sink. */
    slowWarn?: (snapshot: string) => Effect.Effect<void>
  },
) {
  let waiting = 0
  let generation = 0
  let watching = false
  let statementGeneration = 0
  // Bounded fingerprint-only cooldown: one pathological query can otherwise
  // flood production logs while many concurrent sessions run it.
  const slowReported = new Map<string, number>()
  const slowWarningMs = Math.max(1, Math.floor(monitor?.slowWarningMs ?? 2_000))
  const slowWarn = monitor?.slowWarn ?? ((snapshot: string) => Effect.logWarning("SQLite slow statement", snapshot))
  let owner: {
    generation: number
    fiberID: number
    acquiredAt: number
    /** In insertion order: the oldest outstanding worker RPC is first. */
    inFlight: Map<number, { kind: string; startedAt: number; fingerprint: string; length: number; shape: string; origin: string }>
    lastStatement?: { kind: string; finishedAt: number; durationMs: number }
    statements: number
  } | undefined


  const diagnostic = () => {
    const now = performance.now()
    // The previous single-marker tracker could show the *newest* SELECT even
    // when a different older RPC had blocked its single-thread SQLite worker.
    const active = owner?.inFlight.values().next().value
    const heldMs = owner ? Math.max(0, Math.round(now - owner.acquiredAt)) : -1
    const sqlMs = active ? Math.max(0, Math.round(now - active.startedAt)) : -1
    const idleMs = active || !owner?.lastStatement ? -1 : Math.max(0, Math.round(now - owner.lastStatement.finishedAt))
    return ` [permit lane=${lane} owner=${owner?.generation ?? "unknown"} ownerFiber=${owner?.fiberID ?? "unknown"} heldMs=${heldMs} pending=${waiting} sql=${active?.kind ?? "idle"} sqlMs=${sqlMs} sqlHash=${active?.fingerprint ?? "none"} sqlLen=${active?.length ?? 0} sqlShape=${active?.shape ?? "none"} sqlOrigin=${active?.origin ?? "unknown"} sqlInFlight=${owner?.inFlight.size ?? 0} lastSql=${owner?.lastStatement?.kind ?? "none"} lastSqlMs=${owner?.lastStatement?.durationMs ?? -1} idleMs=${idleMs} statements=${owner?.statements ?? 0}${monitor?.worker ? ` ${monitor.worker()}` : ""}]`
  }

  // An unbounded retained permit is otherwise silent for 30 seconds, after
  // which a cascade of unrelated SQL calls fails. Keep ONE detached watcher
  // per contended connection, not one timer/fiber per queued statement.
  // Neither an uncontended acquisition nor an ordinary completed query forks.
  const firstWarningMs = Math.max(1, Math.floor(monitor?.firstWarningMs ?? 1_000))
  const report = monitor?.warn ?? ((snapshot: string) => Effect.logWarning("SQLite connection permit contention", snapshot))
  const watchContention = (heldGeneration: number) =>
    Effect.gen(function* () {
      // Absolute wait milestones relative to the first blocked taker.
      let elapsed = 0
      for (const target of [firstWarningMs, firstWarningMs * 5, firstWarningMs * 30]) {
        yield* Effect.sleep(target - elapsed)
        elapsed = target
        if (!waiting || owner?.generation !== heldGeneration) return
        yield* report(diagnostic())
      }
    }).pipe(Effect.ensuring(Effect.sync(() => { watching = false })))

  const take = Effect.withFiber((fiber) => Effect.suspend(() => {
    // A fiber cannot wait on its own single-connection permit. Fail the
    // reentrant request immediately so the enclosing transaction can unwind
    // and release its lock, instead of cascading 30-second timeouts.
    // Other fibers remain queued: they may be genuinely independent.
    if (owner?.fiberID === fiber.id) {
      return Effect.fail(new SqlError({
        reason: classifySqliteError(
          new Error("Reentrant SQLite connection permit acquisition"),
          { operation: "acquire", message: `SQLite connection already owned by current fiber; possible nested connection dependency${diagnostic()}` },
        ),
      }))
    }
    waiting++
    const monitorStart = owner && !watching
      ? Effect.sync(() => {
          watching = true
          return owner!.generation
        }).pipe(Effect.flatMap((heldGeneration) => watchContention(heldGeneration).pipe(Effect.forkDetach)), Effect.asVoid)
      : Effect.void
    return monitorStart.pipe(Effect.andThen(boundedSqlitePermit(semaphore.take(1), timeoutMs, diagnostic)),
      Effect.tap(() => Effect.sync(() => {
        owner = { generation: ++generation, fiberID: fiber.id, acquiredAt: performance.now(), statements: 0, inFlight: new Map() }
      })),
      Effect.ensuring(Effect.sync(() => { waiting-- })),
    )
  }))

  const release = Effect.sync(() => { owner = undefined }).pipe(
    Effect.andThen(semaphore.release(1)),
  )

  const statement = (query: string, origin = "unknown") => {
    const held = owner
    if (!held) return () => {}
    const id = ++statementGeneration
    const active = { kind: sqliteStatementClass(query), startedAt: performance.now(), fingerprint: sqliteFingerprint(query), length: query.length, shape: sqliteQueryShape(query), origin }
    held.inFlight.set(id, active)
    held.statements++
    return () => {
      if (held.inFlight.delete(id)) {
        const finishedAt = performance.now()
        const durationMs = Math.round(finishedAt - active.startedAt)
        held.lastStatement = { kind: active.kind, finishedAt, durationMs }
        if (durationMs >= slowWarningMs) {
          const last = slowReported.get(active.fingerprint)
          if (last === undefined || finishedAt - last >= 60_000) {
            slowReported.delete(active.fingerprint)
            slowReported.set(active.fingerprint, finishedAt)
            if (slowReported.size > 128) slowReported.delete(slowReported.keys().next().value!)
            // No SQL text, bind values or call-site stacks. A detached log
            // never delays native worker acknowledgement/permit release.
            void Effect.runFork(slowWarn(`lane=${lane} sql=${active.kind} sqlMs=${durationMs} sqlHash=${active.fingerprint} sqlLen=${active.length} sqlShape=${active.shape} sqlOrigin=${active.origin}`))
          }
        }
      }
    }
  }

  return { take, release, statement }
}