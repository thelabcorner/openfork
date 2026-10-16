import { Effect, Semaphore } from "effect"
import { acquireMachineSlot, withLocalAdmissionSlot } from "@/util/machine-slot-budget"
import type { ShellJobKind } from "./shell-jobs"

export const BACKGROUND_PROCESS_ENV = "OPENCODE_MAX_BACKGROUND_PROCESSES"
export const UNSAFE_DISABLE_BACKGROUND_PROCESS_ENV = "OPENCODE_UNSAFE_DISABLE_BACKGROUND_PROCESS_LIMIT"
export const DEFAULT_BACKGROUND_PROCESSES = 3
export const MAX_SAFE_BACKGROUND_PROCESSES = 6
export const MONITOR_PROCESS_ENV = "OPENCODE_MAX_MONITOR_PROCESSES"
export const DEFAULT_MONITOR_PROCESSES = 4
export const MAX_SAFE_MONITOR_PROCESSES = 8

/** An infinite read-only watcher must never retain Snapshot's mutation barrier. */
export const needsBackgroundSnapshotMutationLease = (kind: ShellJobKind) => kind !== "monitor"

const SLOT_PREFIX = "opencode-background-process-v1"
const MONITOR_SLOT_PREFIX = "openfork-monitor-process-v1"
const SLOT_STALE_MS = 30_000
const LOCAL_BACKGROUND_LANE = "openfork-local-background-v1"
const LOCAL_MONITOR_LANE = "openfork-local-monitor-v1"

type Capacity = { readonly semaphore: Semaphore.Semaphore; readonly permits: number }
type SharedState = { background?: Capacity; monitor?: Capacity }
const SHARED_KEY = Symbol.for("openfork.background-process-concurrency")

function sharedState(): SharedState {
  const root = globalThis as typeof globalThis & { [SHARED_KEY]?: SharedState }
  return (root[SHARED_KEY] ??= {})
}

export function configuredBackgroundProcessLimit(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env[UNSAFE_DISABLE_BACKGROUND_PROCESS_ENV] === "1") return undefined
  const raw = env[BACKGROUND_PROCESS_ENV]
  if (raw === undefined || raw.trim() === "") return DEFAULT_BACKGROUND_PROCESSES
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BACKGROUND_PROCESSES
  return Math.min(parsed, MAX_SAFE_BACKGROUND_PROCESSES)
}

/** Event observers cannot occupy long-running build/server permits. */
export function configuredMonitorProcessLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MONITOR_PROCESS_ENV]
  if (!raw || !raw.trim()) return DEFAULT_MONITOR_PROCESSES
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MONITOR_PROCESSES
  return Math.min(parsed, MAX_SAFE_MONITOR_PROCESSES)
}

function backgroundCapacity(): Capacity | undefined {
  const state = sharedState()
  if (state.background) return state.background
  const permits = configuredBackgroundProcessLimit()
  if (permits === undefined) return undefined
  return (state.background = { semaphore: Semaphore.makeUnsafe(permits), permits })
}

function monitorCapacity(): Capacity {
  const state = sharedState()
  if (state.monitor) return state.monitor
  const permits = configuredMonitorProcessLimit()
  return (state.monitor = { semaphore: Semaphore.makeUnsafe(permits), permits })
}

// An admitted monitor may run indefinitely. Keep the capacity stable for its
// lifetime: replacing the semaphore on env changes would allow a second pool
// of monitors to bypass the first pool's permits.
export const withMonitorProcessSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const { semaphore, permits } = monitorCapacity()
  return withLocalAdmissionSlot(
    semaphore,
    (remainingWaitMs) => Effect.acquireUseRelease(
      Effect.tryPromise((signal) =>
        acquireMachineSlot({
          prefix: MONITOR_SLOT_PREFIX,
          slots: permits,
          signal,
          staleMs: SLOT_STALE_MS,
          retryMs: 100,
          maxWaitMs: remainingWaitMs,
        }),
      ).pipe(Effect.orDie, Effect.interruptible),
      () => effect,
      (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
    ),
    LOCAL_MONITOR_LANE,
    permits,
  )
}

/**
 * Long-lived background jobs use a separate machine-wide budget from finite
 * foreground heavy work. Holding a dev server must not deadlock compilers/tests,
 * but agents also must not be able to accumulate an unbounded forest of Vite,
 * watch, test, or arbitrary shell process trees across several ACP hosts.
 */
export const withBackgroundProcessSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const capacity = backgroundCapacity()
  if (!capacity) return effect
  return withLocalAdmissionSlot(
    capacity.semaphore,
    (remainingWaitMs) => Effect.acquireUseRelease(
      Effect.tryPromise((signal) =>
        acquireMachineSlot({
          prefix: SLOT_PREFIX,
          slots: capacity.permits,
          signal,
          staleMs: SLOT_STALE_MS,
          retryMs: 100,
          maxWaitMs: remainingWaitMs,
        }),
      ).pipe(Effect.orDie, Effect.interruptible),
      () => effect,
      (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
    ),
    LOCAL_BACKGROUND_LANE,
    capacity.permits,
  )
}

/** Tests may reconfigure capacity only after every admitted job drains. */
export function resetBackgroundProcessConcurrencyForTesting() {
  const state = sharedState()
  state.background = undefined
  state.monitor = undefined
}

export * as BackgroundProcessConcurrency from "./process-concurrency"
