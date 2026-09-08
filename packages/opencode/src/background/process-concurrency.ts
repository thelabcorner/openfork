import { Effect } from "effect"
import { acquireMachineSlot } from "@/util/machine-slot-budget"

export const BACKGROUND_PROCESS_ENV = "OPENCODE_MAX_BACKGROUND_PROCESSES"
export const UNSAFE_DISABLE_BACKGROUND_PROCESS_ENV = "OPENCODE_UNSAFE_DISABLE_BACKGROUND_PROCESS_LIMIT"
export const DEFAULT_BACKGROUND_PROCESSES = 3
export const MAX_SAFE_BACKGROUND_PROCESSES = 6

const SLOT_PREFIX = "opencode-background-process-v1"
const SLOT_STALE_MS = 30_000

export function configuredBackgroundProcessLimit(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env[UNSAFE_DISABLE_BACKGROUND_PROCESS_ENV] === "1") return undefined
  const raw = env[BACKGROUND_PROCESS_ENV]
  if (raw === undefined || raw.trim() === "") return DEFAULT_BACKGROUND_PROCESSES
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BACKGROUND_PROCESSES
  return Math.min(parsed, MAX_SAFE_BACKGROUND_PROCESSES)
}

/**
 * Long-lived background jobs use a separate machine-wide budget from finite
 * foreground heavy work. Holding a dev server must not deadlock compilers/tests,
 * but agents also must not be able to accumulate an unbounded forest of Vite,
 * watch, test, or arbitrary shell process trees across several ACP hosts.
 */
export const withBackgroundProcessSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const limit = configuredBackgroundProcessLimit()
  if (limit === undefined) return effect
  return Effect.acquireUseRelease(
    Effect.tryPromise((signal) =>
      acquireMachineSlot({
        prefix: SLOT_PREFIX,
        slots: limit,
        signal,
        staleMs: SLOT_STALE_MS,
        retryMs: 100,
      }),
    ).pipe(Effect.orDie),
    () => effect,
    (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
  )
}

export * as BackgroundProcessConcurrency from "./process-concurrency"
