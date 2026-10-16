import { Effect, Semaphore } from "effect"
import { availableParallelism } from "node:os"
import { acquireMachineSlot, withLocalAdmissionSlot } from "@/util/machine-slot-budget"

/**
 * Machine-wide admission control for agent-triggered CPU-heavy child work.
 *
 * Important: this limits HEAVY PROCESSES, not threads. Test runners, compilers,
 * bundlers, and many shell commands are internally parallel and can consume most
 * cores by themselves. Scaling process concurrency linearly with logical CPUs is
 * therefore unsafe: on a 24-thread machine it can multiply into dozens of fully
 * parallel process trees.
 *
 * Defaults scale with machine size but cap child process trees aggressively:
 *   <= 8 logical CPUs: 1 heavy job
 *   >  8 logical CPUs: 1 job per 8 logical CPUs, with a floor of 2 and cap of 4
 *
 * OPENCODE_MAX_CONCURRENT_HEAVY_TOOLS can tune the default. Values are clamped
 * to a safe maximum of 4. The legacy OPENCODE_MAX_CONCURRENT_SHELL_COMMANDS
 * key remains a fallback override.
 *
 * Disabling the limiter requires the deliberately alarming
 * OPENCODE_UNSAFE_DISABLE_HEAVY_TOOL_LIMIT=1. A typo, zero, negative number, or
 * absurdly high numeric value can no longer silently remove the thermal guard.
 */

export const HEAVY_TOOL_ENV = "OPENCODE_MAX_CONCURRENT_HEAVY_TOOLS"
export const LEGACY_SHELL_ENV = "OPENCODE_MAX_CONCURRENT_SHELL_COMMANDS"
export const UNSAFE_DISABLE_ENV = "OPENCODE_UNSAFE_DISABLE_HEAVY_TOOL_LIMIT"
export const MAX_SAFE_HEAVY_JOBS = 4

export function defaultHeavyProcessPermits(parallelism = safeParallelism()): number {
  if (parallelism <= 8) return 1
  return Math.min(MAX_SAFE_HEAVY_JOBS, Math.max(2, Math.floor(parallelism / 8)))
}

function safeParallelism(): number {
  try {
    return Math.max(1, availableParallelism())
  } catch {
    return 1
  }
}

function parseConfigured(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.min(parsed, MAX_SAFE_HEAVY_JOBS)
}

export function configuredHeavyProcessPermits(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env[UNSAFE_DISABLE_ENV] === "1") return undefined
  return parseConfigured(env[HEAVY_TOOL_ENV]) ?? parseConfigured(env[LEGACY_SHELL_ENV]) ?? defaultHeavyProcessPermits()
}

type SharedState = {
  permits?: number
  semaphore?: Semaphore.Semaphore
}

const SHARED_KEY = Symbol.for("opencode.heavy-process-concurrency")
const GLOBAL_SLOT_PREFIX = "opencode-heavy-process-v1"
const GLOBAL_SLOT_STALE_MS = 15_000

function sharedState(): SharedState {
  const root = globalThis as typeof globalThis & { [SHARED_KEY]?: SharedState }
  return (root[SHARED_KEY] ??= {})
}

function getBudget(): { readonly semaphore: Semaphore.Semaphore; readonly permits: number } | undefined {
  const state = sharedState()
  // Do not silently replace a live semaphore when runtime env changes. Older
  // holders would remain on the old counter while new Sessions enter on the
  // replacement, bypassing the machine's CPU guard. Capacity is a lifetime
  // admission decision; an explicit test reset may replace it only after work
  // drains. Keep the cross-process slot count consistent with the local lane.
  if (state.semaphore && state.permits !== undefined) {
    return { semaphore: state.semaphore, permits: state.permits }
  }
  const permits = configuredHeavyProcessPermits()
  if (permits === undefined) return undefined
  state.semaphore = Semaphore.makeUnsafe(permits)
  state.permits = permits
  return { semaphore: state.semaphore, permits }
}

/** Test escape hatch: drop the process-global cached semaphore. */
export function resetHeavyProcessConcurrencyForTesting(): void {
  const state = sharedState()
  state.semaphore = undefined
  state.permits = undefined
}

export const withHeavyProcessSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const budget = getBudget()
  if (!budget) return effect
  return withLocalAdmissionSlot(budget.semaphore,
    (remainingWaitMs) => Effect.acquireUseRelease(
      Effect.tryPromise((signal) =>
        acquireMachineSlot({
          prefix: GLOBAL_SLOT_PREFIX,
          slots: budget.permits,
          signal,
          staleMs: GLOBAL_SLOT_STALE_MS,
          maxWaitMs: remainingWaitMs,
        }),
      ).pipe(Effect.orDie, Effect.interruptible),
      () => effect,
      (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
    ),
    "opencode-local-heavy-v1",
    budget.permits,
  )
}

export * as HeavyProcessConcurrency from "./heavy-process-concurrency"
