import { Cause, Duration, Effect, Exit } from "effect"

/**
 * Bounded SQLite contention classification. Drizzle/Effect can wrap the
 * original native error in Cause/reason objects, sometimes behind symbols.
 * Inspect native code/errno first and only use the native error's known
 * message forms as a compatibility fallback. Never recursively walk an
 * unbounded arbitrary graph or mistake unrelated user text for a lock error.
 */
export function sqliteBusyCode(error: unknown): "SQLITE_BUSY" | "SQLITE_BUSY_SNAPSHOT" | undefined {
  const seen = new Set<object>()
  const stack: unknown[] = [error]
  let checked = 0
  while (stack.length > 0 && checked++ < 96) {
    const value = stack.pop()
    if (!value || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    // Error values can originate from native adapters, arbitrary error
    // subclasses or proxies. Reading properties must never itself turn an
    // optional contention classification into an uncaught defect.
    const read = (key: PropertyKey): unknown => {
      try { return Reflect.get(value, key) } catch { return undefined }
    }
    const code = read("code")
    const errno = read("errno") ?? read("errcode")
    if (code === "SQLITE_BUSY_SNAPSHOT" || errno === 517) return "SQLITE_BUSY_SNAPSHOT"
    if (typeof code === "string" && /^SQLITE_BUSY(?:_[A-Z_]+)?$/.test(code)) return "SQLITE_BUSY"
    if (typeof errno === "number" && (errno & 255) === 5) return "SQLITE_BUSY"
    const message = read("message")
    if (
      typeof message === "string" &&
      (/^database (?:table )?is locked(?:$|[:\s])/i.test(message) || /^SQLITE_BUSY(?:_SNAPSHOT)?(?:$|[:\s])/i.test(message))
    ) return message.includes("SNAPSHOT") ? "SQLITE_BUSY_SNAPSHOT" : "SQLITE_BUSY"
    // Effect can place native errors in non-enumerable/symbol-keyed causes.
    // Bound traversal by explicitly following error-shaped values, not every
    // property of an arbitrary object (which may contain large query data).
    const keys: PropertyKey[] = ["cause", "reason", "reasons", "error", "errors", "defect", "failure"]
    try {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") keys.push(key)
      }
    } catch {}
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < Math.min(value.length, 32); index++) {
          const entry = read(index)
          if (entry && typeof entry === "object") stack.push(entry)
        }
      }
    } catch {}
    for (const key of keys) {
      const nested = read(key)
      if (nested && typeof nested === "object") stack.push(nested)
    }
  }
  return undefined
}

export function isSqliteBusy(error: unknown): boolean {
  return sqliteBusyCode(error) !== undefined
}

/**
 * A failed SQLite BEGIN has not executed any user statement and can safely
 * be retried while keeping the connection permit. Never retry COMMIT,
 * ROLLBACK, SAVEPOINT, or statements inside an already-open transaction.
 */
export function sqliteRetryableBegin(query: string): boolean {
  return /^\s*BEGIN(?:\s+(?:IMMEDIATE|EXCLUSIVE|DEFERRED))?(?:\s+TRANSACTION)?\s*;?\s*$/i.test(query)
}

/** SQLite has one WAL writer across ALL connections and host processes.
 * A low-priority maintenance worker must stop attempting BEGIN quickly,
 * rather than form a 15-second writer-wait stampede when 6+ hosts backfill.
 * Critical Session ownership/control gets a bounded intermediate window;
 * foreground durable user work retains the established full admission budget.
 * Only native BEGIN is repeated, never an admitted transaction body. */
export function sqliteBeginRetryElapsedMs(lane?: string): number {
  if (lane === "maintenance" || lane === "activity") return 350
  if (lane === "control") return 3_000
  return 15_000
}

/** Retry exactly the supplied SQLite operation when the failure is SQLITE_BUSY.
 * Non-busy failures propagate immediately. The caller supplies a thunk so every
 * retry constructs a fresh Effect while preserving the exact atomic operation.
 * Low-priority maintenance must eventually yield to the foreground writer:
 * an indefinitely busy database is not permission to retry forever. */
export function retrySqliteBusy<A, E, R>(
  attempt: () => Effect.Effect<A, E, R>,
  delayMs = 35,
  beforeAttempt?: () => Effect.Effect<void>,
  options: { readonly maxElapsedMs?: number } = {},
): Effect.Effect<A, E, R> {
  const maxElapsedMs = Number.isFinite(options.maxElapsedMs) ? Math.max(0, Math.floor(options.maxElapsedMs!)) : 2_000
  const delay = Number.isFinite(delayMs) ? Math.max(1, Math.floor(delayMs)) : 35
  return Effect.gen(function* () {
    const startedAt = performance.now()
    for (;;) {
      if (beforeAttempt) yield* beforeAttempt()
      const outcome = yield* attempt().pipe(
        Effect.map((value) => ({ kind: "ok" as const, value })),
        Effect.catch((error) => Effect.succeed({ kind: "error" as const, error })),
      )
      if (outcome.kind === "ok") return outcome.value
      if (!isSqliteBusy(outcome.error)) return yield* Effect.fail(outcome.error)
      const remaining = maxElapsedMs - (performance.now() - startedAt)
      if (remaining <= 0) return yield* Effect.fail(outcome.error)
      yield* Effect.sleep(Duration.millis(Math.min(delay, remaining)))
    }
  })
}

/**
 * Retry only the caller-certified safe operation when a BUSY escapes as
 * either a typed failure or an Effect defect. For arbitrary transactions,
 * this is ONLY a failed native BEGIN, before any callback executes. Retrying
 * a post-BEGIN transaction or COMMIT can replay irreversible state changes.
 * A separate idempotent single-statement CAS may opt in explicitly.
 *
 * The time bound prevents background liveness writes from occupying a fiber
 * forever under sustained contention. The caller chooses an operation that is
 * safe to rerun atomically.
 */
export function retrySqliteBusyCause<A, E, R>(
  attempt: () => Effect.Effect<A, E, R>,
  options: { readonly maxElapsedMs?: number; readonly delayMs?: number; readonly maxDelayMs?: number } = {},
): Effect.Effect<A, E, R> {
  const maxElapsedMs = Number.isFinite(options.maxElapsedMs)
    ? Math.max(0, Math.floor(options.maxElapsedMs!))
    : 15_000
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(1, Math.floor(options.delayMs!)) : 50
  const maxDelayMs = Number.isFinite(options.maxDelayMs)
    ? Math.max(delayMs, Math.floor(options.maxDelayMs!))
    : delayMs
  return Effect.gen(function* () {
    const startedAt = performance.now()
    let retry = 0
    for (;;) {
      const outcome = yield* Effect.exit(attempt())
      if (Exit.isSuccess(outcome)) return outcome.value
      if (!isSqliteBusy(Cause.squash(outcome.cause)) || performance.now() - startedAt >= maxElapsedMs) {
        return yield* Effect.failCause(outcome.cause)
      }
      // Independent ACP/Desktop hosts must not all retry on the same clock
      // boundary. Bounded jitter breaks synchronized writer stampedes.
      const cap = Math.min(maxDelayMs, delayMs * 2 ** Math.min(retry++, 30))
      const backoffMs = Math.max(1, Math.floor(cap * (0.75 + Math.random() * 0.5)))
      if (performance.now() - startedAt + backoffMs >= maxElapsedMs) {
        return yield* Effect.failCause(outcome.cause)
      }
      yield* Effect.sleep(Duration.millis(backoffMs))
    }
  })
}
