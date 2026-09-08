import { Effect, Semaphore } from "effect"
import { availableParallelism } from "node:os"
import { acquireMachineSlot } from "@/util/machine-slot-budget"

/**
 * Machine-wide admission control for agent-triggered CPU-heavy child work.
 *
 * Important: this limits HEAVY PROCESSES, not threads. Test runners, compilers,
 * bundlers, and many shell commands are internally parallel and can consume most
 * cores by themselves. Scaling process concurrency linearly with logical CPUs is
 * therefore unsafe: on a 24-thread machine it can multiply into dozens of fully
 * parallel process trees.
 *
 * Defaults are intentionally conservative:
 *   <= 8 logical CPUs: 1 heavy job
 *   >  8 logical CPUs: 2 heavy jobs
 *
 * Operators can lower or raise the budget with
 * OPENCODE_MAX_CONCURRENT_HEAVY_TOOLS. Values are clamped to a safe maximum of
 * 4. The legacy OPENCODE_MAX_CONCURRENT_SHELL_COMMANDS key is accepted as a
 * fallback so existing installations keep their intended override.
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
  return parallelism > 8 ? 2 : 1
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

function getSemaphore(): Semaphore.Semaphore | undefined {
  const permits = configuredHeavyProcessPermits()
  if (permits === undefined) return undefined
  const state = sharedState()
  if (!state.semaphore || state.permits !== permits) {
    state.semaphore = Semaphore.makeUnsafe(permits)
    state.permits = permits
  }
  return state.semaphore
}

/** Test escape hatch: drop the process-global cached semaphore. */
export function resetHeavyProcessConcurrencyForTesting(): void {
  const state = sharedState()
  state.semaphore = undefined
  state.permits = undefined
}

export const withHeavyProcessSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const current = getSemaphore()
  if (!current) return effect
  const permits = configuredHeavyProcessPermits()
  if (permits === undefined) return effect
  return current.withPermit(
    Effect.acquireUseRelease(
      Effect.tryPromise((signal) =>
        acquireMachineSlot({
          prefix: GLOBAL_SLOT_PREFIX,
          slots: permits,
          signal,
          staleMs: GLOBAL_SLOT_STALE_MS,
        }),
      ).pipe(Effect.orDie),
      () => effect,
      (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
    ),
  )
}

export * as HeavyProcessConcurrency from "./heavy-process-concurrency"
