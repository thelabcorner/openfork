import { Duration, Effect } from "effect"

/**
 * Detect SQLITE_BUSY through Effect/Drizzle's nested error/cause wrappers.
 *
 * EffectDrizzleQueryError can bury SqlError inside Effect.Cause.reasons rather
 * than a conventional `.cause`. Walk every own property (including symbol and
 * non-enumerable fields) without coupling maintenance code to one wrapper
 * version. Used by all low-priority ChunkDB writers so foreground work owns the
 * SQLite writer slot.
 */
export function isSqliteBusy(error: unknown): boolean {
  const seen = new Set<object>()
  const stack: unknown[] = [error]
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value === "string") {
      const text = value.toLowerCase()
      if (
        text.includes("database is locked") ||
        text.includes("database table is locked") ||
        text.includes("sqlite_busy")
      ) {
        return true
      }
      continue
    }
    if (!value || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    for (const key of Reflect.ownKeys(value)) {
      try {
        stack.push(Reflect.get(value, key))
      } catch {}
    }
  }
  return false
}

/** Retry exactly the supplied SQLite operation when the failure is SQLITE_BUSY.
 * Non-busy failures propagate immediately. The caller supplies a thunk so every
 * retry constructs a fresh Effect while preserving the exact atomic operation. */
export function retrySqliteBusy<A, E, R>(
  attempt: () => Effect.Effect<A, E, R>,
  delayMs = 35,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    for (;;) {
      const outcome = yield* attempt().pipe(
        Effect.map((value) => ({ kind: "ok" as const, value })),
        Effect.catch((error) => Effect.succeed({ kind: "error" as const, error })),
      )
      if (outcome.kind === "ok") return outcome.value
      if (!isSqliteBusy(outcome.error)) return yield* Effect.fail(outcome.error)
      yield* Effect.sleep(Duration.millis(delayMs))
    }
  })
}
