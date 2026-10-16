import { Effect, Option } from "effect"

export const DEFAULT_SEARCH_TIMEOUT_MS = 20_000
export const MAX_SEARCH_TIMEOUT_MS = 120_000
export const SEARCH_TIMEOUT_ENV = "OPENFORK_RIPGREP_SEARCH_TIMEOUT_MS"

/** User-tunable, positive and bounded; malformed configuration cannot disable it. */
export function configuredSearchTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env[SEARCH_TIMEOUT_ENV]
  if (!raw || !raw.trim()) return DEFAULT_SEARCH_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 1_000
    ? Math.min(parsed, MAX_SEARCH_TIMEOUT_MS)
    : DEFAULT_SEARCH_TIMEOUT_MS
}

/**
 * Put a deadline around the entire scoped ripgrep lifetime, including waiting
 * for its first matching file. Effect interrupts the scoped subprocess on
 * expiry; no prefix of partial search results is presented as a complete hit.
 */
export function withRipgrepSearchBudget<A, E, R>(
  work: Effect.Effect<A, E, R>,
  timeoutMs = configuredSearchTimeoutMs(),
): Effect.Effect<A, E | Error, R> {
  return work.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.flatMap((outcome) =>
      Option.isSome(outcome)
        ? Effect.succeed(outcome.value)
        : Effect.fail(new Error(
          `Ripgrep search exceeded ${timeoutMs}ms without completing; narrow the directory or pattern, or adjust ${SEARCH_TIMEOUT_ENV}.`,
        )),
    ),
  )
}