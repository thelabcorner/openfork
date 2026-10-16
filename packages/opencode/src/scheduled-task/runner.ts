import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Ref, Scope, Semaphore } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { isSqliteBusy } from "@opencode-ai/core/database/sqlite-busy"
import { EventV2 } from "@opencode-ai/core/event"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskLease } from "@opencode-ai/core/scheduled-task/lease"
import { ScheduledTaskExecutor } from "./executor"
import { ScheduledTaskWake } from "./wake"

/** 02 § 5.1: never arm a multi-hour timer; re-read the clock every minute. */
export const MAX_SLEEP_MS = 60_000
// An overdue cursor owned by a living peer (or still inside its jitter window)
// must not re-arm a zero-delay timer forever. This floor costs a few seconds of
// unattended retry responsiveness in exchange for bounded SQL/CPU pressure.
export const OVERDUE_POLL_MS = 5_000

/** 02 § 4.2 guard 4: do not stampede overdue tasks while the process boots. */
export const STARTUP_GRACE_MS = 30_000

/** 02 § 7: bound the number of Session materializations per wake. */
export const DISPATCH_CONCURRENCY = 2
export const LEASE_UNVERIFIED_STOP_MS =
  ScheduledTaskLease.LEASE_TTL_MS - ScheduledTaskLease.HEARTBEAT_INTERVAL_MS

/** Bound crash-recovery work per lifecycle while giving unrelated Sessions a
 * chance to acquire the WAL writer between small lease-reclamation pages. */
export const MAX_LIFECYCLE_RECOVERY_PAGES = 64
export const RECOVERY_BATCH_COOLDOWN_MS = 100

export interface Interface {
  /** Recovery + first arm. Idempotent. */
  readonly start: (options?: { readonly startupGraceMs?: number }) => Effect.Effect<void>
  /** Explicit diagnostic/test tick. Production mutations wake through EventV2 or durable generation reconciliation. */
  readonly poke: () => Effect.Effect<void>
  /** 0 or 1 — the single-timer invariant (N2/D4). */
  readonly activeTimerCount: () => Effect.Effect<number>
  /** In-flight dispatches owned by this runner. */
  readonly activeRuns: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ScheduledTaskRunner") {}

interface State {
  readonly timer: Option.Option<Fiber.Fiber<void>>
  /** Monotonic ownership token preventing an expired timer from clearing a newer one. */
  readonly timerEpoch: number
  readonly runs: number
  readonly dispatching: number
  /** Coalesced wake received while the single dispatch batch is draining. */
  readonly wakePending: boolean
  readonly started: boolean
  /** Last durable scheduler generation observed by the idle reconciliation floor. */
  readonly generation: number | undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const tasks = yield* ScheduledTask.Service
    const leases = yield* ScheduledTaskLease.Service
    const executor = yield* ScheduledTaskExecutor.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope

    const state = yield* Ref.make<State>({
      timer: Option.none(),
      timerEpoch: 0,
      runs: 0,
      dispatching: 0,
      wakePending: false,
      started: false,
      generation: undefined,
    })
    const armLock = Semaphore.makeUnsafe(1)
    const wakeLock = Semaphore.makeUnsafe(1)
    const startLock = Semaphore.makeUnsafe(1)

    /**
     * Install exactly one owned timer.
     *
     * The Deferred gate closes a subtle zero-delay race: the child cannot fire
     * before its Fiber handle and epoch are committed to State. On expiration it
     * atomically consumes its own slot before running the callback, so a callback
     * that re-arms never interrupts itself and a superseded callback can never
     * erase a newer timer.
     */
    const installTimer = Effect.fnUntraced(function* (delay: number, onExpire: Effect.Effect<void>) {
      const previous = yield* Ref.get(state)
      const epoch = previous.timerEpoch + 1
      if (Option.isSome(previous.timer)) yield* Fiber.interrupt(previous.timer.value)

      const ready = yield* Deferred.make<void>()
      const fiber: Fiber.Fiber<void> = yield* Effect.gen(function* () {
        yield* Deferred.await(ready)
        yield* Effect.sleep(delay)
        const owns = yield* Ref.modify(state, (current) => {
          if (current.timerEpoch !== epoch) return [false, current] as const
          return [true, { ...current, timer: Option.none() }] as const
        })
        if (owns) yield* onExpire
      }).pipe(Effect.forkIn(scope, { startImmediately: true }))

      yield* Ref.update(state, (current) => ({
        ...current,
        timer: Option.some(fiber),
        timerEpoch: epoch,
      }))
      yield* Deferred.succeed(ready, undefined)
    })

    const cancelTimer = Effect.fnUntraced(function* () {
      const previous = yield* Ref.get(state)
      yield* Ref.update(state, (current) => ({
        ...current,
        timer: Option.none(),
        timerEpoch: current.timerEpoch + 1,
      }))
      if (Option.isSome(previous.timer)) yield* Fiber.interrupt(previous.timer.value)
    })

    const runEffect = Effect.fn("ScheduledTaskRunner.dispatch")(function* (plan: ScheduledTask.FiringPlan) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const lease = yield* leases.claim({ taskID: plan.task.id, fireFor: plan.fireFor, now })
          // Losing the claim is normal operation, not an error.
          if (!lease) return

          yield* Ref.update(state, (current) => ({ ...current, runs: current.runs + 1 }))
          yield* Effect.addFinalizer(() => Ref.update(state, (current) => ({ ...current, runs: current.runs - 1 })))

          // Revalidate immediately before spending provider work: the world may
          // have changed since the lease was written (03 § 3 step 2).
          const current = yield* tasks
            .get(plan.task.id)
            .pipe(Effect.catchTag("ScheduledTask.NotFoundError", () => Effect.succeed(undefined)))
          const manual = plan.trigger === "manual"
          const valid =
            current !== undefined &&
            (manual || (current.enabled && current.revision === plan.task.revision && current.nextRunAt !== undefined))
          if (!valid) {
            yield* tasks.skipSettled({
              taskID: plan.task.id,
              fireFor: plan.fireFor,
              leaseID: lease.leaseID,
              now: yield* Clock.currentTimeMillis,
              ...(current?.nextRunAt !== undefined ? { nextRunAt: current.nextRunAt } : {}),
            })
            return
          }

          const started = yield* tasks.recordRunStart({
            taskID: plan.task.id,
            fireFor: plan.fireFor,
            trigger: plan.trigger,
            attempt: lease.attempt,
            acceptExisting: plan.acceptExisting,
            now: yield* Clock.currentTimeMillis,
          })
          if (started.kind === "exists") {
            // A terminal row already exists for this logical instant (for
            // example an abandoned run whose lease the TTL sweep reclaimed).
            yield* tasks.skipSettled({
              taskID: plan.task.id,
              fireFor: plan.fireFor,
              leaseID: lease.leaseID,
              now: yield* Clock.currentTimeMillis,
            })
            return
          }

          // A heavily contended primary writer can delay recordRunStart long
          // after claim(). Refresh and validate exact lease authority on the
          // isolated liveness connection immediately before any provider/tool
          // effect. Losing this race must not admit a second executor.
          const admitted = yield* leases.heartbeat({
            leaseID: lease.leaseID,
            now: yield* Clock.currentTimeMillis,
          })
          if (!admitted) {
            return yield* Effect.die(new Error("Scheduled Task start refused: exact lease ownership lost"))
          }

          const leaseLost = yield* Ref.make(false)
          const lostSignal = yield* Deferred.make<void>()
          let lastConfirmedLeaseAt = performance.now()
          const stopOnLeaseLoss = Effect.fnUntraced(function* (reason: string) {
            if (yield* Ref.get(leaseLost)) return
            yield* Ref.set(leaseLost, true)
            yield* Deferred.succeed(lostSignal, undefined)
            yield* Effect.logWarning("Scheduled Task execution fenced after losing lease proof", {
              taskID: plan.task.id,
              reason,
            })
          })
          // A writer can remain unacknowledged even while the async heartbeat
          // fiber is waiting for its native SQL worker. An independent timer
          // fences execution BEFORE a delayed heartbeat reaches the lease TTL.
          // Never continue external effects indefinitely without ownership
          // evidence, even if this sacrifices forward progress under load.
          yield* Effect.forkScoped(
            Effect.gen(function* () {
              for (;;) {
                yield* Effect.sleep(Duration.seconds(5))
                if (performance.now() - lastConfirmedLeaseAt < LEASE_UNVERIFIED_STOP_MS) continue
                yield* stopOnLeaseLoss("heartbeat-unverified")
                return
              }
            }),
          )
          // Heartbeat fiber is scoped to the run fiber so it cannot outlive it.
          // One transient busy-timeout must not permanently silence the lease.
          yield* Effect.forkScoped(
            Effect.gen(function* () {
              let failures = 0
              while (true) {
                const waitMs = failures === 0
                  ? ScheduledTaskLease.HEARTBEAT_INTERVAL_MS
                  : Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5))
                yield* Effect.sleep(Duration.millis(waitMs))
                const attempt = yield* Effect.exit(
                  leases.heartbeat({ leaseID: lease.leaseID, now: yield* Clock.currentTimeMillis }),
                )
                if (Exit.isFailure(attempt)) {
                  if (Cause.hasInterrupts(attempt.cause)) return yield* Effect.failCause(attempt.cause)
                  failures++
                  if (failures === 1 || failures % 10 === 0) {
                    yield* Effect.logWarning("Scheduled Task heartbeat retrying after database failure", {
                      taskID: plan.task.id,
                      consecutiveFailures: failures,
                    })
                  }
                  continue
                }
                failures = 0
                if (attempt.value) {
                  lastConfirmedLeaseAt = performance.now()
                  continue
                }
                yield* stopOnLeaseLoss("lease-revoked")
                return
              }
            }),
          )

          const outcome = yield* Effect.raceFirst(
            executor.execute({
              task: current,
              runID: started.run.id,
              attempt: lease.attempt,
              fireFor: plan.fireFor,
              leaseID: lease.leaseID,
            }),
            Deferred.await(lostSignal).pipe(
              Effect.andThen(Effect.die(new Error("Scheduled Task execution stopped: lease proof lost"))),
            ),
          )

          // Another owner or recovery operation has the authoritative lease.
          // Do not assert a success/terminal outcome from a stale generation.
          if (yield* Ref.get(leaseLost)) return

          // Unconditional settlement: the executor encodes failures instead of
          // failing, so there is no path that skips this.
          yield* tasks.settleRun({
            taskID: plan.task.id,
            runID: started.run.id,
            fireFor: plan.fireFor,
            status: outcome.status,
            now: yield* Clock.currentTimeMillis,
            attempt: lease.attempt,
            leaseID: lease.leaseID,
            sessionID: outcome.sessionID,
            directory: outcome.directory,
            skipReason: outcome.skipReason,
            errorKind: outcome.errorKind,
            errorMessage: outcome.errorMessage,
            collapseAfterNow: plan.trigger === "catchup" && plan.task.policy.catchUp === "run_once",
          })
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("scheduled task dispatch failed", { taskID: plan.task.id, cause }),
        ),
      )
    })

    const wake: () => Effect.Effect<void> = Effect.fn("ScheduledTaskRunner.wake")(function* () {
      // Pokes and durable mutation events can arrive during the startup grace
      // period, before old leases have been recovered. The first post-recovery
      // due scan is authoritative; pre-start notifications cannot run tasks.
      if (!(yield* Ref.get(state)).started) return
      // Serialized: a manual poke and a fired timer must not both fork a batch.
      yield* wakeLock.withPermit(wakeBody())
    })

    const wakeBody: () => Effect.Effect<void> = Effect.fn("ScheduledTaskRunner.wakeBody")(function* () {
      const current = yield* Ref.get(state)
      if (current.dispatching > 0) {
      // Never overlap batches. A timer, queued-run/mutation event, or manual poke
        // that arrives during dispatch is level-triggered work, so one bit is
        // sufficient: the draining batch performs one fresh authoritative scan.
        yield* Ref.update(state, (value) => ({ ...value, wakePending: true }))
        return
      }
      // Sleeping laptops make timers lie: always re-read the clock and re-query
      // rather than trusting the timer (T4 hard rules).
      const now = yield* Clock.currentTimeMillis
      const plans = yield* tasks.planDue(now)
      if (plans.length > 0) {
        // A real dispatch supersedes any armed recurrence/idle timer. The batch
        // completion owns the next arm.
        yield* cancelTimer()
        // One dispatch batch at a time: the batch runs with bounded
        // concurrency and calls arm() when it drains, so a new batch can never
        // overlap the previous one and multiply the effective concurrency.
        yield* Ref.update(state, (value) => ({ ...value, dispatching: value.dispatching + 1, wakePending: false }))
        yield* Effect.forEach(plans, runEffect, { concurrency: DISPATCH_CONCURRENCY, discard: true }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const followUp = yield* Ref.modify(state, (value) => {
                const dispatching = Math.max(0, value.dispatching - 1)
                const pending = dispatching === 0 && value.wakePending
                return [
                  pending,
                  {
                    ...value,
                    dispatching,
                    wakePending: pending ? false : value.wakePending,
                  },
                ] as const
              })
              if (followUp) {
                yield* wake()
                return
              }
              yield* arm()
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
        return
      }
      yield* arm()
    })

    const armImpl: Effect.Effect<void> = Effect.gen(function* () {
      const previous = yield* Ref.get(state)
      // Do not arm a timer from a mutation before recovery has settled.
      if (!previous.started) return
      // While a dispatch batch is draining, its completion owns the re-arm.
      if (previous.dispatching > 0) {
        yield* cancelTimer()
        return
      }
      const now = yield* Clock.currentTimeMillis
      const next = yield* tasks.nextDueAt(now)
      if (next === undefined) {
        const generation = yield* tasks.generation()
        yield* installTimer(MAX_SLEEP_MS, reconcileIdle(generation))
        yield* Ref.update(state, (current) => ({ ...current, generation }))
        return
      }
      const delay = next <= now
        ? OVERDUE_POLL_MS
        : Math.min(next - now, MAX_SLEEP_MS)
      yield* installTimer(delay, wake())
    })

    const arm: () => Effect.Effect<void> = () => armLock.withPermit(armImpl)

    const armIdle = (generation: number) =>
      armLock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          if (current.dispatching > 0) return
          yield* installTimer(MAX_SLEEP_MS, reconcileIdle(generation))
          yield* Ref.update(state, (value) => ({ ...value, generation }))
        }),
      )

    const reconcileIdle = (expectedGeneration: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const generation = yield* tasks.generation()
        if (generation === expectedGeneration) {
          // Unchanged durable truth: stay on the cheapest path. Do not scan
          // tasks, parse recurrence, or materialize an Instance.
          yield* armIdle(generation)
          return
        }
        yield* Ref.update(state, (current) => ({ ...current, generation }))
        yield* wake()
      }).pipe(Effect.withSpan("ScheduledTaskRunner.reconcileIdle"))

    const recoverLeasePages = Effect.fn("ScheduledTaskRunner.recoverLeasePages")(function* (
      now: number,
      publish: boolean,
      pageBudget = MAX_LIFECYCLE_RECOVERY_PAGES,
    ) {
      for (let page = 0; page < pageBudget; page++) {
        const reclaimed = yield* leases.recoverStale({
          now,
          // Startup cannot assume it owns every lease with the module-scoped
          // PROCESS_OWNER_ID: an independently provisioned service graph in
          // the same OS process may still be executing. Old process generations
          // have different random owner ids and are reclaimed by staleness.
          // Teardown is ALSO not permitted to sweep the process owner: two
          // independent runtime graphs may execute in one OS process. A
          // process-global owner id is insufficient proof that this particular
          // scoped runner owns the lease. Let unfinished runs expire naturally
          // unless they were settled with their exact lease token.
          includeOwn: false,
          limit: ScheduledTaskLease.STALE_RECOVERY_BATCH_SIZE,
        })
        if (publish) {
          yield* Effect.forEach(
            reclaimed,
            (item) => item.run
              ? events.publish(ScheduledTask.Event.RunSettled, { taskID: item.taskID, run: item.run })
              : Effect.void,
            { discard: true },
          )
        }
        if (reclaimed.length < ScheduledTaskLease.STALE_RECOVERY_BATCH_SIZE) return true
        // No long-running IMMEDIATE transaction spanning the whole backlog.
        yield* Effect.yieldNow
      }
      yield* Effect.logWarning("Scheduled Task lease recovery reached per-pass page budget; another pass is required", {
        maxPages: pageBudget,
        pageSize: ScheduledTaskLease.STALE_RECOVERY_BATCH_SIZE,
      })
      return false
    })

    const start: Interface["start"] = Effect.fn("ScheduledTaskRunner.start")(function* (options) {
      const grace = options?.startupGraceMs ?? STARTUP_GRACE_MS
      if (grace > 0) yield* Effect.sleep(grace)
      yield* startLock.withPermit(
        Effect.gen(function* () {
          if ((yield* Ref.get(state)).started) return
          const now = yield* Clock.currentTimeMillis
          // Startup recovery: leases owned by this process cannot be live yet,
          // so reclaiming them is safe; stale peer leases are always reclaimed.
          // A capped pass without a follow-up silently strands leases after
          // sufficiently large crashes. Keep execution fenced until every
          // stale lease is reconciled, but never hold one WAL transaction
          // across pages or spin continuously under a huge backlog.
          let contentionFailures = 0
          for (;;) {
            const result = yield* Effect.exit(recoverLeasePages(now, true))
            if (Exit.isSuccess(result)) {
              contentionFailures = 0
              if (result.value) break
              yield* Effect.sleep(Duration.millis(RECOVERY_BATCH_COOLDOWN_MS))
              continue
            }
            // No external tool is replayed: recovery changes only exact
            // durable lease identities. Native busy errors from a competing
            // WAL writer must not permanently disable this process's runner.
            if (!isSqliteBusy(Cause.squash(result.cause))) return yield* Effect.failCause(result.cause)
            contentionFailures++
            if (contentionFailures === 1 || contentionFailures % 10 === 0) {
              yield* Effect.logWarning("Scheduled Task startup recovery is waiting for SQLite writer admission", {
                failures: contentionFailures,
              })
            }
            yield* Effect.sleep(Duration.seconds(Math.min(30, 2 ** Math.min(contentionFailures, 5))))
          }
          yield* Ref.update(state, (current) => ({ ...current, started: true }))
          // A queued manual run is durable runnable work but intentionally does
          // not mutate the recurrence cursor. Scan once on startup so a process
          // crash between enqueue and the in-process wake signal cannot strand it.
          yield* wake()
        }),
      )
    })

    const poke: Interface["poke"] = Effect.fn("ScheduledTaskRunner.poke")(function* () {
      yield* wake()
    })

    const activeTimerCount: Interface["activeTimerCount"] = Effect.fn("ScheduledTaskRunner.activeTimerCount")(function* () {
      return Option.isSome((yield* Ref.get(state)).timer) ? 1 : 0
    })

    const activeRuns: Interface["activeRuns"] = Effect.fn("ScheduledTaskRunner.activeRuns")(function* () {
      return (yield* Ref.get(state)).runs
    })

    const service = Service.of({ start, poke, activeTimerCount, activeRuns })
    const uninstallWake = ScheduledTaskWake.install(() => Effect.runPromise(poke()))
    yield* Effect.addFinalizer(() => Effect.sync(uninstallWake))

    // Most mutations only change the recurrence cursor and therefore need a
    // re-arm. A queued manual run has no recurrence cursor, so its durable
    // RunUpdated event is an explicit wake signal. Resuming the global control
    // gate must likewise scan queued work before arming the next recurrence.
    const unsubscribe = yield* events.listen((event) => {
      if (!event.type.startsWith("scheduledTask.")) return Effect.void
      if (event.type === "scheduledTask.runUpdated") {
        const data = event.data as { run?: { status?: string } }
        if (data.run?.status === "queued") return wake().pipe(Effect.ignore)
      }
      // A settled batch may leave additional queued manual work. Reconcile
      // it from durable truth instead of waiting for a recurrence-only timer.
      if (event.type === "scheduledTask.runSettled") return wake().pipe(Effect.ignore)
      if (event.type === "scheduledTask.controlChanged") {
        const data = event.data as { control?: { paused?: boolean } }
        if (data.control?.paused === false) return wake().pipe(Effect.ignore)
      }
      return arm().pipe(Effect.ignore)
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    // Convergent teardown: stop admissions/timers. A process owner identity is
    // shared by independent service graphs in the same OS process, so forcing
    // recovery here could abandon a sibling graph's LIVE execution. Scoped
    // children are interrupted by runtime closure; any uncertain in-flight
    // lease is deliberately left for TTL-fenced crash recovery, not replayed.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* cancelTimer()
        const current = yield* Ref.get(state)
        yield* Ref.set(state, {
          timer: Option.none(),
          timerEpoch: current.timerEpoch,
          runs: 0,
          dispatching: 0,
          wakePending: false,
          started: false,
          generation: undefined,
        })
      }),
    )

    // This runtime can stay alive after a different Desktop/ACP process has
    // crashed. Startup-only recovery would then leave foreign held leases
    // permanently blocking a cursor until our OWN process happens to restart.
    // Use one small periodic page, not an unbounded sweep. The reconciliation
    // is idempotent, fenced by the exact stale heartbeat/lease, and never
    // force-clears sibling graphs sharing this process owner's identity.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        let nextDelayMs = 60_000
        for (;;) {
          yield* Effect.sleep(Duration.millis(nextDelayMs))
          nextDelayMs = 60_000
          const snapshot = yield* Ref.get(state)
          // Reconciliation is maintenance. A host already executing Sessions
          // must prioritize its own heartbeat/settlement writes; foreign dead
          // leases can wait for its next idle interval.
          if (!snapshot.started || snapshot.runs > 0 || snapshot.dispatching > 0) continue
          const now = yield* Clock.currentTimeMillis
          const result = yield* Effect.exit(recoverLeasePages(now, true, 1))
          if (Exit.isFailure(result)) {
            yield* Effect.logWarning("Scheduled Task foreign stale-lease sweep deferred", {
              cause: Cause.pretty(result.cause),
            })
            continue
          }
          if (!result.value) {
            // The page was full: drain gradually without blocking foreground
            // writer admission or waiting another entire minute per page.
            nextDelayMs = 5_000
          }
        }
      }),
    )

    yield* Effect.forkScoped(start())
    return service
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [ScheduledTask.node, ScheduledTaskLease.node, ScheduledTaskExecutor.node, EventV2.node],
})

export * as ScheduledTaskRunner from "./runner"
