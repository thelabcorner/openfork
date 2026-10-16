import * as Effect from "effect/Effect"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"

/** Internal Effect permit deadline, independent of native SQLite busy_timeout.
 *
 * This operates on the interruptible semaphore.take(), BEFORE a SQL statement
 * can start. timeoutOption cancels the waiting fiber; callers only install the
 * permit release finalizer after a successful acquisition. Never retry the
 * partial operation or pretend to have obtained a permit on timeout.
 */
export function boundedSqlitePermit<A, E, R>(
  take: Effect.Effect<A, E, R>,
  requestedMs?: number,
  diagnostic?: () => string,
): Effect.Effect<A, E | SqlError, R> {
  const timeoutMs = requestedMs !== undefined && Number.isFinite(requestedMs)
    ? Math.max(1, Math.min(300_000, Math.floor(requestedMs)))
    : 30_000
  return Effect.timeoutOption(take, timeoutMs).pipe(
    Effect.flatMap((result) => result._tag === "Some"
      ? Effect.succeed(result.value)
      : Effect.fail(new SqlError({
          reason: classifySqliteError(
            new Error("SQLite connection semaphore acquisition timed out"),
            {
               message: `SQLite connection permit unavailable after ${timeoutMs}ms; possible transaction dependency cycle${diagnostic?.() ?? ""}`,
              operation: "acquire",
            },
          ),
        }))),
  )
}