export * as UsageHistoryWatermark from "./history-watermark"

import { Effect } from "effect"
import { observeDataVersion } from "../database/data-version"
import type { DatabaseShape } from "../database/database"
import { UsageRevision } from "./revision"

export interface Value {
  /**
   * In-process committed durable-usage settlements/projection rewrites. Covers
   * this process's own writes, which PRAGMA data_version deliberately ignores.
   */
  readonly localRevision: number
  /**
   * `PRAGMA data_version` on the writer connection: commits made by any other
   * connection, including another process sharing the same database file. NaN
   * when the probe could not be read, which invalidates on every comparison.
   */
  readonly externalDataVersion: number
}

export interface Memo<A> {
  readonly watermark: Value
  readonly value: A
}

/**
 * Combined in-process + cross-process watermark for durable usage state.
 *
 * An in-process revision alone only advances inside one process. A second host
 * (Desktop sidecar plus ACP, or any peer sharing the database file) commits
 * settlements that a revision-keyed memo never observes, so that memo then
 * serves permanently stale projections for the life of the process. The two
 * signals are complementary and neither is sufficient alone:
 *
 *   - `localRevision` is exact for this process and free of false positives.
 *   - `externalDataVersion` is SQLite's own cross-connection commit signal. It
 *     needs no schema change, no watermark table, and no MAX()/mtime scan per
 *     read.
 *
 * Probe `db` — the foreground writer connection — rather than `readDb`. For
 * file-backed databases `readDb` is a separate `query_only` handle, so this
 * process's own commits also change *its* data_version; sampling that handle
 * would conservatively drop the memo on unrelated foreground writes such as
 * resource-learning burn rows. The writer connection keeps the external signal
 * scoped to genuine other writers (peer processes, maintenance connections)
 * while `localRevision` carries our own settlements.
 *
 * `:memory:` databases have no other connection and therefore no cross-process
 * visibility at all; there the local revision remains the complete signal, which
 * is why readers must keep consulting it instead of replacing it.
 *
 * Sample the watermark BEFORE the durable read it guards. Sampling afterwards
 * could label older data with a newer watermark and make the staleness
 * permanent; sampling first can only cost one redundant recompute.
 *
 * A probe that cannot be read is NOT "unchanged". `make` reports that as an
 * unobservable external signal (see UNOBSERVED_DATA_VERSION), which `same` can
 * never match, so the memo misses for as long as the probe stays unhealthy and
 * returns to normal reuse once it recovers. This costs a bounded re-read of an
 * already-materialized projection; it never costs a crashed Capacity request
 * and it never serves data whose freshness could not be established.
 */
export const make = (db: DatabaseShape): Effect.Effect<Value> =>
  Effect.gen(function* () {
    const localRevision = UsageRevision.current()
    const observed = yield* observeDataVersion(db)
    return { localRevision, externalDataVersion: observed ?? UNOBSERVED_DATA_VERSION }
  })

/**
 * "No external signal could be read."
 *
 * NaN is never equal to itself under the strict comparison `same` performs, so
 * it is a self-invalidating sentinel: every sample while the probe is unhealthy
 * differs from every other sample, which is exactly the fail-open behaviour a
 * cache reader needs.
 */
const UNOBSERVED_DATA_VERSION = Number.NaN

export const same = (left: Value, right: Value) =>
  left.localRevision === right.localRevision && left.externalDataVersion === right.externalDataVersion

/**
 * Memoize one durable usage read behind the combined watermark.
 *
 * Returns the watermark alongside the value so a caller that derives a cheaper
 * projection from it (for example a general-usage aggregate) can key that
 * projection on the same exact signal instead of a second, weaker one.
 *
 * Reads are single-flight per watermark. A cold or just-invalidated watermark
 * is exactly when many consumers arrive at once, and a full projection read per
 * consumer would turn one commit into an N-way scan. Concurrent callers that
 * observe the same watermark join the one in-flight round through
 * `Effect.cached`; a caller that observes a newer watermark starts its own round
 * rather than joining one labelled with an older signal. An interrupted or
 * failed round is never memoized, so the next caller retries cleanly instead of
 * inheriting a wedged computation.
 */
export const cached = <A>(read: Effect.Effect<A>, watermark: Effect.Effect<Value>) => {
  let settled: Memo<A> | undefined
  let inflight: { readonly watermark: Value; readonly round: Effect.Effect<Memo<A>> } | undefined

  // Check-and-set on `inflight` has no suspension point between the compare and
  // the assignment, so concurrent callers cannot both open a round.
  const roundFor = Effect.fnUntraced(function* (current: Value) {
    const running = inflight
    if (running && same(running.watermark, current)) return running
    const next = {
      watermark: current,
      round: yield* Effect.cached(
        Effect.suspend(() => read).pipe(
          Effect.map((value): Memo<A> => ({ watermark: current, value })),
        ),
      ),
    }
    inflight = next
    return next
  })

  return Effect.fnUntraced(function* () {
    const current = yield* watermark
    const hit = settled
    if (hit && same(hit.watermark, current)) return hit
    const opened = yield* roundFor(current)
    const next = yield* opened.round.pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          if (inflight === opened) inflight = undefined
        }),
      ),
    )
    settled = next
    return next
  })
}
