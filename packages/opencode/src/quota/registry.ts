import { Cause, Deferred, Effect, Exit } from "effect"
import { buildResult } from "./format"
import type { ProviderResult } from "./schema"

/**
 * Quota adapter registry primitives: the adapter contract, alias resolution,
 * and same-provider single-flight. Ported from OpenChamber (MIT)
 * packages/web/server/lib/quota/providers/index.js.
 */

export interface Adapter {
  readonly id: string
  readonly name: string
  /** Additional quota-source IDs that resolve to this adapter (e.g. "kimi"). */
  readonly aliases: readonly string[]
  /** Cheap credential presence check; must not touch the network. */
  readonly configured: () => Effect.Effect<boolean>
  /** Reads the provider account endpoint. Never fails: failures become ok=false results. */
  readonly fetch: () => Effect.Effect<ProviderResult>
}

const normalizeId = (id: string) => id.trim().toLowerCase().replace(/[\s_]+/g, "-")

export const resolveAdapter = (adapters: readonly Adapter[], id: string): Adapter | undefined => {
  const normalized = normalizeId(id)
  return adapters.find(
    (adapter) => normalizeId(adapter.id) === normalized || adapter.aliases.some((alias) => normalizeId(alias) === normalized),
  )
}

/**
 * Coalesces concurrent fetches for the same adapter into one execution:
 * callers that arrive while a fetch is running share its result. This is
 * account-endpoint load protection, not result caching — completion removes
 * the entry immediately. One instance belongs to the Quota service layer.
 */
export function createSingleFlight() {
  const pending = new Map<string, Deferred.Deferred<ProviderResult, never>>()

  return (key: string, task: Effect.Effect<ProviderResult>): Effect.Effect<ProviderResult> =>
    Effect.gen(function* () {
      const existing = pending.get(key)
      if (existing) return yield* Deferred.await(existing)
      const deferred = yield* Deferred.make<ProviderResult>()
      pending.set(key, deferred)
      const exit = yield* Effect.exit(task)
      if (pending.get(key) === deferred) pending.delete(key)
      // The adapter contract is "never fails"; a defect here is a bug in one
      // adapter and must not fail the route or strand awaiters, so collapse
      // it into an error result for every caller of this round.
      if (Exit.isSuccess(exit)) {
        yield* Deferred.succeed(deferred, exit.value)
        return exit.value
      }
      const failure = Cause.squash(exit.cause)
      // The "Request failed" placeholder used to hide whatever the adapter
      // actually threw. Real causes are a mix: an `Error` (most), a defect
      // string (e.g. `throw "upstream busy"`), a structured object, or
      // `undefined` (an interrupt). Coerce each into something a user can
      // act on — a generic fallback is a UX failure, not a safe default.
      const reason = describeCause(failure)
      const failureResult = buildResult({
        providerId: key,
        providerName: key,
        ok: false,
        configured: true,
        error: reason,
      })
      yield* Deferred.succeed(deferred, failureResult)
      return failureResult
    })
}

/**
 * Best-effort human-readable rendering of whatever an adapter threw. The
 * previous "Request failed" fallback hid real failures behind a generic
 * placeholder — every user who has ever asked "why does the WorkBuddy card
 * just say Request failed?" was a victim of that. Coerce defensively:
 * Errors carry a useful message, plain objects may carry `.message`/`.name`,
 * primitives stringify safely, and `undefined` (an interrupt) gets a real
 * reason rather than a vanishing placeholder.
 */
function describeCause(failure: unknown): string {
  if (failure instanceof Error) return failure.message || failure.name || "Adapter threw an error"
  if (failure === null) return "Adapter returned null"
  if (failure === undefined) return "Adapter exited without a result"
  if (typeof failure === "string") return failure
  if (typeof failure === "number" || typeof failure === "boolean" || typeof failure === "bigint") return String(failure)
  if (typeof failure === "object") {
    const obj = failure as { message?: unknown; name?: unknown; error?: unknown }
    if (typeof obj.message === "string" && obj.message.length > 0) return obj.message
    if (typeof obj.name === "string" && obj.name.length > 0) {
      return typeof obj.error === "string" && obj.error.length > 0 ? `${obj.name}: ${obj.error}` : obj.name
    }
    if (typeof obj.error === "string" && obj.error.length > 0) return obj.error
  }
  return "Adapter threw a non-error value"
}
