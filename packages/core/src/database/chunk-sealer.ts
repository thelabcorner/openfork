import { createHash } from "node:crypto"
import { Effect, Duration } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { sql } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { withBackfillDb, type DatabaseShape } from "./database"
import { compressText, chooseCodec, compressDeltaRef } from "./json-codec"
import { compressTextAsync } from "./compress-pool"
import { Flag } from "../flag/flag"
import {
  CHUNKDB_BATCH_SIZE,
  CHUNKDB_EXTERNALIZE_MIN_AGGREGATE_BYTES,
  CHUNKDB_SEAL_JOURNAL_RETENTION_DAYS,
  CHUNKDB_VACUUM_MAX_ITERATIONS,
  CHUNKDB_VACUUM_PAGES_PER_PASS,
} from "./chunkdb"

/**
 * Epoch-2 reference key. A promoted (deduped) payload is replaced in
 * `event.data` by `{"$cdbRef":"<value_id>"}`; the canonical bytes live once in
 * `event_value`. Owned by schema-v2; the sealer only emits it.
 */
const CDB_REF = "$cdbRef"

function toCdbRef(valueId: string): string {
  return JSON.stringify({ [CDB_REF]: valueId })
}

const encoder = new TextEncoder()

/**
 * Epoch-1/2 background sealer for the OpenCode ChunkDB optimization. Frames
 * large, dormant, settled `event.data` TEXT rows into OCDB v2 BROTLI frames
 * (epoch-1, `runPass`) or externalizes them into the `event_value` reference
 * table (epoch-2, `runPassV2` when `Flag.OPENCODE_SEAL_DEDUP` is on) on a
 * DEDICATED connection (via `withBackfillDb`) so it never contends on the
 * shared live-query client's single-permit semaphore.
 *
 * Eligibility (per row (aggregate_id, seq)):
 *   seq <= event_sequence.seq                    (settled frontier)
 *   AND event_sequence.owner_id IS NULL          (not claimed/running)
 *   AND session.time_updated <= cooling cutoff   (dormant; event has no ts)
 *   AND typeof(event.data) = 'text'              (idempotent: skip framed/ref)
 *   AND length(event.data) >= 4096               (code units; see threshold)
 *
 * Epoch-1: `event.data` becomes an inline OCDB frame; the seal is journaled in
 * `ocdb_seal`. Epoch-2: `event.data` becomes a small `{"$cdbRef": "<id>"}`
 * reference and the payload lives in `event_value` (deduplicated by sha256).
 * Hot writes (live inserts) stay ref-free / inline TEXT in both epochs; only
 * cold/dormant rows are promoted here in the background.
 *
 * Each candidate's UPDATE (+ journal UPSERT, epoch-1, or + event_value write,
 * epoch-2) runs inside a short transaction (crash-consistent); the loop yields
 * between batches so interactive reads interleave. FLAG-GATED behind
 * `Flag.OPENCODE_SEAL_ENABLED`.
 *
 * Epoch-3 storage tuning (storage-frontier-v3), all FLAG-GATED and benchmarked
 * in test/bench-storage.ts:
 *   - batch size is parameterized (default `CHUNKDB_BATCH_SIZE`); median-3 bench
 *     showed 128 gives best/equal promote throughput with the shortest write
 *     lock, so larger batches only starve reads.
 *   - `runPassV2` applies an aggregate-size externalization gate (only promotes
 *     aggregates whose total externalizable bytes exceed
 *     `CHUNKDB_EXTERNALIZE_MIN_AGGREGATE_BYTES`) to avoid tiny-session ref
 *     overhead.
 *   - after each pass, `reclaimSpace` runs a BOUNDED `PRAGMA incremental_vacuum`
 *     (only on fresh DBs with `auto_vacuum = INCREMENTAL`, set create-time in
 *     chunkdb.ts) instead of a blocking VACUUM — reclaiming ~63% of the file in
 *     bench without blocking reads.
 *   - `page_size`/`auto_vacuum` are applied create-time (fresh DBs only) by the
 *     sqlite native layer via `createTimePragmas` before `journal_mode = WAL`;
 *     existing DBs keep their format.
 */

const COOLING_MS = 48 * 60 * 60 * 1000
const MAX_ROWS_PER_PASS = 5_000
// #6 adaptive drain (investigate-v4 scope): when a pass hits its cap (backlog
// remains) the loop switches to BACKFILL mode — back-to-back passes at this
// raised cap so a large existing DB first-seals in hours, not days. Batch size
// stays 128; the cap only bounds batches-per-pass, so write-lock granularity is
// unchanged.
const CHUNKDB_BACKFILL_MAX_ROWS_PER_PASS = 50_000
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000
const DRAIN_SLEEP_MS = 250
// Failure backoff: a failed pass doubles the wait (exponential, capped) so a
// broken DB isn't hammered; reset on success.
const BACKOFF_BASE_MS = 10 * 60 * 1000
const BACKOFF_CAP_MS = 60 * 60 * 1000
// Pacing: if a single batch's write-lock exceeds this, sleep briefly so live
// reads interleave (the sealer holds a dedicated connection).
const WRITE_LOCK_BACKOFF_MS = 250
const PACING_SLEEP_MS = 50

/** Optional tuning knobs for a sealer pass (epoch-3 storage-frontier-v3). */
interface SealerOptions {
  /** Override the promotion batch size (default `CHUNKDB_BATCH_SIZE`). */
  readonly batchSize?: number
  /** Override the per-pass row cap (default `MAX_ROWS_PER_PASS`). */
  readonly maxRowsPerPass?: number
}

/**
 * Bounded, non-blocking space reclaim. After a promotion pass, the `event.data`
 * TEXT rows have shrunk to tiny `{"$cdbRef":...}` strings, freeing many pages
 * inside the file. With `auto_vacuum = INCREMENTAL` (set create-time on fresh
 * DBs by the sqlite native layer), `PRAGMA incremental_vacuum(N)` returns
 * those pages to the OS WITHOUT the blocking full `VACUUM`.
 *
 * A single `incremental_vacuum(100)` only reclaims 100 pages (~800KB) — a bulk
 * promote frees megabytes, so we LOOP in 100-page chunks until the freelist
 * drains (or a cap bounds the pass). Each chunk is its own short write-lock, so
 * reads interleave between chunks instead of being starved by one giant
 * statement. On DBs without INCREMENTAL auto_vacuum (existing files) this is a
 * cheap no-op. Must run OUTSIDE a transaction.
 */
function reclaimSpace(db: DatabaseShape): Effect.Effect<void> {
  return Effect.gen(function* () {
    const rows = yield* db.all<{ auto_vacuum: number }>(`PRAGMA auto_vacuum`).pipe(Effect.orDie)
    if ((rows[0]?.auto_vacuum ?? 0) !== 2) return
    for (let i = 0; i < CHUNKDB_VACUUM_MAX_ITERATIONS; i++) {
      const free = yield* db.all<{ freelist_count: number }>(`PRAGMA freelist_count`).pipe(Effect.orDie)
      if ((free[0]?.freelist_count ?? 0) === 0) break
      yield* db.run(`PRAGMA incremental_vacuum(${CHUNKDB_VACUUM_PAGES_PER_PASS})`).pipe(Effect.orDie)
    }
  })
}

/**
 * Bounded `ocdb_seal` journal prune. The journal is write-only audit (the
 * candidate filter keys off the event table, not this table), so entries older
 * than `CHUNKDB_SEAL_JOURNAL_RETENTION_DAYS` can be dropped each pass without
 * affecting sealing correctness — re-sealing a pruned row is a no-op because it
 * is already a frame / `$cdbRef` and is never re-selected as a text candidate.
 * Keeps the journal from growing 1:1 with every sealed event over the DB's life.
 */
function pruneSealJournal(db: DatabaseShape): Effect.Effect<void> {
  return Effect.gen(function* () {
    const cutoff = Date.now() - CHUNKDB_SEAL_JOURNAL_RETENTION_DAYS * 24 * 60 * 60 * 1000
    yield* db.run(sql`DELETE FROM ocdb_seal WHERE time_sealed < ${cutoff}`).pipe(Effect.orDie)
  })
}

/**
 * One epoch-1 sealing pass over eligible rows: frames each candidate's
 * `event.data` TEXT into an OCDB v2 BROTLI frame, stored inline. Returns the
 * count of rows framed and the raw bytes sealed. Errors are intentionally left
 * in the typed error channel (NOT `Effect.orDie`'d) so the caller's
 * `Effect.ignore` can swallow a failed pass without killing the loop —
 * `Effect.ignore` only catches typed failures, not defects.
 */
export function runPass(
  db: DatabaseShape,
  options?: SealerOptions,
): Effect.Effect<{ promoted: number; bytes: number }, EffectDrizzleQueryError | SqlError> {
  return Effect.gen(function* () {
    const cutoff = Date.now() - COOLING_MS
    const batchSize = options?.batchSize ?? CHUNKDB_BATCH_SIZE
    let promoted = 0
    let bytes = 0

    for (;;) {
      const candidates = yield* db.all<{ id: string; data: string }>(sql`
        SELECT e.id, e.data
        FROM event e
        JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
        LEFT JOIN session se ON se.id = e.aggregate_id
        WHERE e.seq <= es.seq
          AND es.owner_id IS NULL
          AND (se.time_updated IS NULL OR se.time_updated <= ${cutoff})
          AND typeof(e.data) = 'text'
          AND length(e.data) >= 4096
        ORDER BY e.aggregate_id, e.seq
        LIMIT ${batchSize}
      `)

      if (candidates.length === 0) break

      for (const candidate of candidates) {
        const frame = compressText(candidate.data)
        if (typeof frame === "string") continue
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`UPDATE event SET data = ${frame} WHERE id = ${candidate.id}`)
            yield* tx.run(sql`
              INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed, reseal_needed)
              VALUES ('event', ${candidate.id}, 'data', ${candidate.data.length}, ${frame.byteLength}, ${frame[5]}, ${frame[4]}, ${Date.now()}, 0)
              ON CONFLICT (table_name, row_id, column_name) DO UPDATE SET
                raw_bytes = excluded.raw_bytes,
                stored_bytes = excluded.stored_bytes,
                time_sealed = excluded.time_sealed
            `)
          }),
        )
        promoted += 1
        bytes += candidate.data.length
      }

      yield* Effect.yieldNow
      if (promoted >= (options?.maxRowsPerPass ?? MAX_ROWS_PER_PASS)) break
    }

    // Reclaim freed pages (bounded) so the file does not grow unbounded.
    yield* reclaimSpace(db)
    // Drop stale audit-journal entries so ocdb_seal does not grow 1:1 with
    // every sealed event over the DB's lifetime.
    yield* pruneSealJournal(db)

    return { promoted, bytes }
  })
}

/**
 * One epoch-2 promotion pass over eligible rows: externalize each candidate's
 * `event.data` TEXT into `event_value` and leave a small `{"$cdbRef": "<id>"}`
 * inline in `event.data`. Deduplicates by sha256 *within an aggregate*: if an
 * identical payload was already promoted, we bump its `refs` and point the new
 * reference at the existing `value_id` instead of inserting a duplicate row —
 * so 1,284 identical `info.summary` payloads collapse to ONE `event_value` row
 * plus 1,284 tiny refs.
 *
 * `value_id` is `${aggregate_id}:${seq}` (unique & deterministic per event);
 * re-promotion is idempotent because the sha256 lookup finds the prior row. All
 * writes for a batch (every event UPDATE + event_value INSERT/UPDATE + ocdb_seal
 * journal UPSERT) commit in ONE transaction, so a crash mid-batch leaves the DB
 * consistent (either the whole batch promoted or none of it).
 *
 * Returns counts of first-occurrence promotions, repeat (dedup) promotions, and
 * the raw bytes externalized. Errors stay in the typed channel so the loop's
 * `Effect.ignore` swallows a failed pass without dying.
 */
export function runPassV2(
  db: DatabaseShape,
  options?: SealerOptions,
): Effect.Effect<
  { promoted: number; repeated: number; bytes: number },
  EffectDrizzleQueryError | SqlError
> {
  return Effect.gen(function* () {
    const cutoff = Date.now() - COOLING_MS
    const batchSize = options?.batchSize ?? CHUNKDB_BATCH_SIZE
    const maxRowsPerPass = options?.maxRowsPerPass ?? MAX_ROWS_PER_PASS
    // Epoch-3: when OPENCODE_SEAL_WORKERS is on, compression runs on the
    // worker-thread pool (parallel) instead of inline on the main thread.
    const useWorkers = Flag.OPENCODE_SEAL_WORKERS
    let promoted = 0
    let repeated = 0
    let bytes = 0
    // Epoch-4 #10: track the last NON-delta (full-frame) promoted value per
    // aggregate so subsequent candidates can be stored as a sparse correction
    // (v5 delta_ref) against it. Only non-delta bases are tracked — a delta_ref
    // value is never used as a base, which avoids nested deltas (the read path
    // resolves a base via decodeValueBytesRaw, which only handles v1-v4).
    const lastBaseByAggregate = new Map<string, { valueId: string; raw: Uint8Array }>()

    for (;;) {
      // Epoch-3 externalization gate: only promote aggregates whose TOTAL
      // externalizable bytes exceed the threshold, so tiny sessions don't pay
      // the `{"$cdbRef":...}` indirection + event_value row overhead for a
      // negligible space win. Implemented as a per-aggregate SUM(length) HAVING
      // filter over the eligible set (the `agg_total` CTE) joined back to rows.
      const candidates = yield* db.all<{ id: string; aggregate_id: string; seq: number; data: string }>(sql`
        WITH eligible AS (
          SELECT e.id, e.aggregate_id, e.seq, e.data
          FROM event e
          JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
          LEFT JOIN session se ON se.id = e.aggregate_id
          WHERE e.seq <= es.seq
            AND es.owner_id IS NULL
            AND (se.time_updated IS NULL OR se.time_updated <= ${cutoff})
            AND typeof(e.data) = 'text'
            AND length(e.data) >= 4096
        ), agg_total AS (
          SELECT aggregate_id, SUM(length(data)) AS total
          FROM eligible
          GROUP BY aggregate_id
          HAVING total > ${CHUNKDB_EXTERNALIZE_MIN_AGGREGATE_BYTES}
        )
        SELECT e.id, e.aggregate_id, e.seq, e.data
        FROM eligible e
        JOIN agg_total a ON a.aggregate_id = e.aggregate_id
        ORDER BY e.aggregate_id, e.seq
        LIMIT ${batchSize}
      `)

      if (candidates.length === 0) break

      // Decide + compress OUTSIDE the transaction. The dedup lookup is a read
      // and compression is CPU-heavy, so neither belongs on the SQLite write
      // path. With workers, compression runs in parallel on the pool; the
      // transaction below only applies the precomputed writes (crash-consistent
      // as before — either the whole batch commits or none of it).
      type Plan =
        | { kind: "skip" }
        | { kind: "repeat"; candidate: (typeof candidates)[number]; valueId: string }
        | { kind: "first"; candidate: (typeof candidates)[number]; sha: string; frame: string | Uint8Array; valueId: string }
      const plans: Plan[] = []
      // Batch-aware dedup: the event_value lookup below only sees rows committed
      // by PREVIOUS passes. Two candidates in THIS batch with the same
      // (aggregate_id, sha256) would both plan as "first" and the transaction
      // would hit the UNIQUE(aggregate_id, sha256) constraint. Track what this
      // batch already plans to promote so the second occurrence becomes a
      // "repeat" pointing at the first's value_id.
      const batchSeen = new Map<string, string>()
      const shaByCandidate = candidates.map((c) => ({
        candidate: c,
        sha: createHash("sha256").update(c.data).digest("hex"),
      }))
      // ONE batched dedup lookup for the whole batch (row-value IN) instead of a
      // per-candidate SELECT — a bulk promote does 2000 round-trips otherwise.
      const committed = new Map<string, string>()
      if (shaByCandidate.length > 0) {
        const pairs = sql.join(
          shaByCandidate.map(({ candidate, sha }) => sql`(${candidate.aggregate_id}, ${sha})`),
          sql`, `,
        )
        const rows = yield* db.all<{ aggregate_id: string; value_id: string; sha256: string }>(sql`
          SELECT aggregate_id, value_id, sha256 FROM event_value
          WHERE (aggregate_id, sha256) IN (${pairs})
        `).pipe(Effect.orDie)
        for (const r of rows) committed.set(`${r.aggregate_id}:${r.sha256}`, r.value_id)
      }
      for (const { candidate, sha } of shaByCandidate) {
        // Idempotency: a row already promoted to a reference is short TEXT, so
        // the length >= 4096 filter already excludes it; bail early if one
        // slips through (defensive, never re-promote a ref).
        if (candidate.data.startsWith(`{"${CDB_REF}"`)) {
          plans.push({ kind: "skip" })
          continue
        }

        const raw = candidate.data

        const existingValueId = committed.get(`${candidate.aggregate_id}:${sha}`)
        if (existingValueId) {
          // REPEAT — the dedup win. Point this event at the existing row and
          // bump its refcount; the payload is NOT stored again.
          plans.push({ kind: "repeat", candidate, valueId: existingValueId })
          continue
        }

        const batchKey = `${candidate.aggregate_id}:${sha}`
        const batchHit = batchSeen.get(batchKey)
        if (batchHit) {
          // REPEAT within this batch — the identical payload is already planned
          // for promotion below; point at its value_id instead of inserting a
          // duplicate row (which would violate UNIQUE(aggregate_id, sha256)).
          plans.push({ kind: "repeat", candidate, valueId: batchHit })
          continue
        }

        // FIRST occurrence — compress once and store the canonical bytes.
        const rawBytes = encoder.encode(raw)
        const frame = useWorkers
          ? yield* Effect.promise(() => compressTextAsync(raw))
          : compressText(raw)
        const valueId = `${candidate.aggregate_id}:${candidate.seq}`

        // Epoch-4 #10: delta_ref framing. If enabled and a non-delta base exists
        // in the same aggregate, store this value as a sparse correction against
        // the base when the correction is materially smaller than a full frame
        // (the 0.7x margin guards against regressions on non-record-structured
        // payloads). The correction is computed synchronously — it is small.
        let finalFrame: string | Uint8Array = frame
        if (Flag.OPENCODE_SEAL_DELTA && typeof frame !== "string") {
          const base = lastBaseByAggregate.get(candidate.aggregate_id)
          if (base !== undefined) {
            const { codec, level } = chooseCodec(rawBytes.byteLength)
            const delta = compressDeltaRef(rawBytes, base.raw, base.valueId, codec, level)
            if (delta.byteLength < frame.byteLength * 0.7) finalFrame = delta
          }
        }
        // Track the base for FUTURE candidates only when THIS value is stored as a
        // full frame (not a delta) — a delta_ref value is never a base.
        if (finalFrame === frame) {
          lastBaseByAggregate.set(candidate.aggregate_id, { valueId, raw: rawBytes })
        }
        batchSeen.set(batchKey, valueId)
        plans.push({ kind: "first", candidate, sha, frame: finalFrame, valueId })
      }

      const txStart = Date.now()
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          for (const plan of plans) {
            if (plan.kind === "skip") continue
            const candidate = plan.candidate
            const raw = candidate.data

            if (plan.kind === "repeat") {
              const ref = toCdbRef(plan.valueId)
              yield* tx.run(sql`UPDATE event SET data = ${ref} WHERE id = ${candidate.id}`)
              yield* tx.run(sql`
                UPDATE event_value SET refs = refs + 1
                WHERE aggregate_id = ${candidate.aggregate_id} AND value_id = ${plan.valueId}
              `)
              yield* tx.run(sql`
                INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed, reseal_needed)
                VALUES ('event', ${candidate.id}, 'data', ${raw.length}, ${ref.length}, 0, 0, ${Date.now()}, 0)
                ON CONFLICT (table_name, row_id, column_name) DO UPDATE SET
                  raw_bytes = excluded.raw_bytes,
                  stored_bytes = excluded.stored_bytes,
                  time_sealed = excluded.time_sealed
              `)
              repeated += 1
              bytes += raw.length
              continue
            }

            // FIRST occurrence — store the canonical bytes computed above.
            const frame = plan.frame
            const stored = typeof frame === "string" ? encoder.encode(raw) : frame
            const codec = typeof frame === "string" ? 0 : frame[5]
            const ref = toCdbRef(plan.valueId)
            yield* tx.run(sql`UPDATE event SET data = ${ref} WHERE id = ${candidate.id}`)
            yield* tx.run(sql`
              INSERT INTO event_value (aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)
              VALUES (${candidate.aggregate_id}, ${plan.valueId}, ${plan.sha}, ${raw.length}, ${stored}, 1, ${Date.now()})
            `)
            yield* tx.run(sql`
              INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed, reseal_needed)
                VALUES ('event', ${candidate.id}, 'data', ${raw.length}, ${stored.byteLength}, ${codec}, ${typeof frame === "string" ? 0 : frame[4]}, ${Date.now()}, 0)
              ON CONFLICT (table_name, row_id, column_name) DO UPDATE SET
                raw_bytes = excluded.raw_bytes,
                stored_bytes = excluded.stored_bytes,
                time_sealed = excluded.time_sealed
            `)
            promoted += 1
            bytes += raw.length
          }
        }),
      )

      const txMs = Date.now() - txStart

      yield* Effect.yieldNow
      // Pacing: if this batch's write-lock was unusually long, sleep briefly so
      // live reads interleave (the sealer holds a dedicated connection).
      if (txMs > WRITE_LOCK_BACKOFF_MS) {
        yield* Effect.sleep(Duration.millis(PACING_SLEEP_MS))
      }
      if (promoted + repeated >= maxRowsPerPass) break
    }

    // Reclaim freed pages (bounded) so the file does not grow unbounded.
    yield* reclaimSpace(db)
    // Drop stale audit-journal entries so ocdb_seal does not grow 1:1 with
    // every sealed event over the DB's lifetime.
    yield* pruneSealJournal(db)

    return { promoted, repeated, bytes }
  })
}

/**
 * Background sealer loop. Opens a DEDICATED connection via `withBackfillDb`
 * (own native handle + own semaphore, migrations already applied by the
 * Database layer) that persists for the whole loop. Runs an immediate first
 * pass, then repeats. Gated on `Flag.OPENCODE_SEAL_ENABLED`; when
 * `Flag.OPENCODE_SEAL_DEDUP` is on it runs the epoch-2 dedup promotion pass
 * (`runPassV2`), otherwise the epoch-1 framing pass (`runPass`) — epoch-1 is the
 * fallback and is never broken.
 *
 * Adaptive drain (#6, investigate-v4 scope): when a pass hits its cap (backlog
 * remains), the loop switches to BACKFILL mode — back-to-back passes at
 * `CHUNKDB_BACKFILL_MAX_ROWS_PER_PASS` with a short 250ms interleave so live
 * reads aren't starved (batches are 128-row short write-locks on the dedicated
 * connection). When a pass no longer hits the cap (backlog drained) it settles
 * to MAINTENANCE mode: 10-min spaced passes at `MAX_ROWS_PER_PASS`. Mode is
 * derived from the previous pass result — no extra state, no cursor.
 * `Flag.OPENCODE_SEAL_BACKFILL` set to 0 forces maintenance-only. A failed pass
 * doubles the wait (exponential, capped at `BACKOFF_CAP_MS`) so a broken DB
 * isn't hammered; the loop survives and resets on success.
 */
type SealerPassOutcome =
  | { kind: "ok"; promoted: number; repeated: number }
  | { kind: "failed"; promoted: number; repeated: number }

export function runSealerLoop(filename: string): Effect.Effect<void> {
  if (!Flag.OPENCODE_SEAL_ENABLED) return Effect.void
  const backfillAllowed = Flag.OPENCODE_SEAL_BACKFILL
  return withBackfillDb(filename, (db) =>
    Effect.gen(function* () {
      let previousHitCap: boolean = false
      let backoffMs = BACKOFF_BASE_MS
      for (;;) {
        const draining: boolean = previousHitCap && backfillAllowed
        const cap: number = draining ? CHUNKDB_BACKFILL_MAX_ROWS_PER_PASS : MAX_ROWS_PER_PASS
        const outcome: SealerPassOutcome = yield* runSealerPass(db, { maxRowsPerPass: cap }).pipe(
          Effect.catch(() => Effect.succeed({ kind: "failed" as const, promoted: 0, repeated: 0 })),
        )
        if (outcome.kind === "failed") {
          yield* Effect.logError("ChunkDB sealer pass failed; backing off")
          yield* Effect.sleep(Duration.millis(backoffMs))
          backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS)
          previousHitCap = false
          continue
        }
        backoffMs = BACKOFF_BASE_MS
        previousHitCap = outcome.promoted + outcome.repeated >= cap
        const wait = previousHitCap && backfillAllowed ? DRAIN_SLEEP_MS : MAINTENANCE_INTERVAL_MS
        yield* Effect.sleep(Duration.millis(wait))
      }
    }),
  ).pipe(
    Effect.catch((error) => Effect.logError("ChunkDB sealer loop stopped", { error })),
  )
}

/**
 * Runs the flag-selected promotion pass (epoch-2 `runPassV2` when
 * `OPENCODE_SEAL_DEDUP`, else epoch-1 `runPass`) and normalizes the result to a
 * common `{ promoted, repeated }` shape so the loop can treat both uniformly.
 */
function runSealerPass(
  db: DatabaseShape,
  options: SealerOptions,
): Effect.Effect<{ kind: "ok"; promoted: number; repeated: number }, EffectDrizzleQueryError | SqlError> {
  if (Flag.OPENCODE_SEAL_DEDUP) {
    return runPassV2(db, options).pipe(
      Effect.map((result) => ({ kind: "ok" as const, promoted: result.promoted, repeated: result.repeated })),
    )
  }
  return runPass(db, options).pipe(
    Effect.map((result) => ({ kind: "ok" as const, promoted: result.promoted, repeated: 0 })),
  )
}
