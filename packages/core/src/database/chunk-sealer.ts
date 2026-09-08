import { createHash } from "node:crypto"
import { Cause, Effect, Duration } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { sql } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { withBackfillDb, type DatabaseShape } from "./database"
import { compressText, chooseCodec, compressDeltaRef, isV5Frame, parseV5Header } from "./json-codec"
import { compressTextAsync } from "./compress-pool"
import { runSemanticPrunePass, type SemanticPruneOutcome } from "./chunk-prune"
import { isSqliteBusy } from "./sqlite-busy"
import { Flag } from "../flag/flag"
import {
  CHUNKDB_BATCH_SIZE,
  CHUNKDB_COOLING_MS,
  CHUNKDB_EXTERNALIZE_MIN_AGGREGATE_BYTES,
  CHUNKDB_HOT_TAIL_EVENTS,
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
 *   AND (session is cooled OR row is outside the live hot tail OR session row
 *        no longer exists)
 *   AND typeof(event.data) = 'text'              (idempotent: skip framed/ref)
 *   AND length(event.data) >= 4096               (code units; see threshold)
 * `event_sequence.owner_id` is intentionally NOT an activity gate: it is durable
 * workspace/sync ownership and can remain populated for the lifetime of a
 * session. Treating it as "running" permanently excluded normal synced history.
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
 *   - `runPassV2` externalizes large aggregates for dedup, while small aggregates
 *     are compressed inline to avoid tiny-session ref/index overhead without
 *     giving up compression coverage.
 *   - after each pass, `reclaimSpace` runs a BOUNDED `PRAGMA incremental_vacuum`
 *     (only on fresh DBs with `auto_vacuum = INCREMENTAL`, set create-time in
 *     chunkdb.ts) instead of a blocking VACUUM — reclaiming ~63% of the file in
 *     bench without blocking reads.
 *   - `page_size`/`auto_vacuum` are applied create-time (fresh DBs only) by the
 *     sqlite native layer via `createTimePragmas` before `journal_mode = WAL`;
 *     existing DBs keep their format.
 */

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
// Compression batches stay large enough to keep worker threads busy, but SQLite
// writes are deliberately sliced much smaller. WAL still permits only one writer
// at a time, and a 128-row transaction can hold that slot long enough for a
// foreground 5s busy_timeout to expire on a multi-gigabyte DB.
const CHUNKDB_WRITE_SLICE_ROWS = 8
const CHUNKDB_WRITE_SLICE_BYTES = 512 * 1024
const CHUNKDB_WRITE_SLICE_PAUSE_MS = 15
const CHUNKDB_BUSY_RETRY_MS = 35
const BACKLOG_SAMPLE_ROWS = 2_048
// Once a historical backfill drains, a giant freelist can remain inside the
// SQLite file even though the logical payload has already shrunk dramatically.
// Keep normal maintenance conservative, but enter a dedicated low-priority
// reclaim drain until the freelist falls below this ratio. Vacuum work remains
// split into small statements with yields so foreground writers keep priority.
const CHUNKDB_RECLAIM_DRAIN_FREE_RATIO = 0.05
const CHUNKDB_RECLAIM_DRAIN_MIN_FREE_PAGES = 8_192 // 64 MiB at the tuned 8 KiB page size
const CHUNKDB_RECLAIM_DRAIN_MAX_MS = 15_000
const CHUNKDB_RECLAIM_DRAIN_PAUSE_MS = 10
const CHUNKDB_RECLAIM_DRAIN_SLEEP_MS = 250

// A Database layer can be materialized more than once inside one server process
// (for example by independently-built service graphs). Starting one infinite
// maintenance loop per materialization races duplicate sealers against the same
// SQLite file. Keep exactly one sealer per physical filename in this JS realm.
const ACTIVE_SEALERS = Symbol.for("opencode.chunkdb.active-sealers")
const activeSealers = (() => {
  // `process` is shared across duplicated module/VM realms in one Node sidecar,
  // unlike a realm-local globalThis. This is the correct singleton boundary for
  // a database maintenance loop owned by one OS process.
  const existing: unknown = Reflect.get(process, ACTIVE_SEALERS)
  if (existing instanceof Set) return existing
  const created = new Set<string>()
  Reflect.set(process, ACTIVE_SEALERS, created)
  return created
})()

function sealerKey(filename: string): string {
  const normalized = filename.replaceAll("\\", "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

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
type ReclaimMode = "maintenance" | "drain"

interface ReclaimStats {
  readonly attempted: boolean
  readonly reclaimedPages: number
  readonly freePages: number
  readonly pageCount: number
  readonly needsMore: boolean
}

export function shouldDrainFreelist(freePages: number, pageCount: number): boolean {
  if (freePages < CHUNKDB_RECLAIM_DRAIN_MIN_FREE_PAGES || pageCount <= 0) return false
  return freePages / pageCount > CHUNKDB_RECLAIM_DRAIN_FREE_RATIO
}

function reclaimSpace(db: DatabaseShape, mode: ReclaimMode = "maintenance"): Effect.Effect<ReclaimStats> {
  return Effect.gen(function* () {
    const rows = yield* db.all<{ auto_vacuum: number }>(`PRAGMA auto_vacuum`).pipe(Effect.orDie)
    if ((rows[0]?.auto_vacuum ?? 0) !== 2) {
      return { attempted: false, reclaimedPages: 0, freePages: 0, pageCount: 0, needsMore: false }
    }

    const initialFreeRows = yield* db.all<{ freelist_count: number }>(`PRAGMA freelist_count`).pipe(Effect.orDie)
    const initialPageRows = yield* db.all<{ page_count: number }>(`PRAGMA page_count`).pipe(Effect.orDie)
    const initialFree = initialFreeRows[0]?.freelist_count ?? 0
    const initialPageCount = initialPageRows[0]?.page_count ?? 0
    if (initialFree === 0) {
      return { attempted: true, reclaimedPages: 0, freePages: 0, pageCount: initialPageCount, needsMore: false }
    }

    const started = Date.now()
    const maxIterations = mode === "maintenance" ? CHUNKDB_VACUUM_MAX_ITERATIONS : Number.POSITIVE_INFINITY
    let iterations = 0
    let currentFree = initialFree
    let currentPageCount = initialPageCount

    while (iterations < maxIterations) {
      if (mode === "drain") {
        if (!shouldDrainFreelist(currentFree, currentPageCount)) break
        if (Date.now() - started >= CHUNKDB_RECLAIM_DRAIN_MAX_MS) break
      } else if (currentFree === 0) {
        break
      }

      const vacuum = yield* db.run(`PRAGMA incremental_vacuum(${CHUNKDB_VACUUM_PAGES_PER_PASS})`).pipe(
        Effect.map(() => true),
        Effect.catch((error) => {
          if (isSqliteBusy(error)) return Effect.succeed(false)
          return Effect.die(error)
        }),
      )
      if (!vacuum) {
        // Foreground owns the single SQLite writer slot. Background reclaim does
        // not queue behind it; yield immediately and let the next drain slice try.
        break
      }

      iterations += 1
      const freeRows = yield* db.all<{ freelist_count: number }>(`PRAGMA freelist_count`).pipe(Effect.orDie)
      const pageRows = yield* db.all<{ page_count: number }>(`PRAGMA page_count`).pipe(Effect.orDie)
      const nextFree = freeRows[0]?.freelist_count ?? 0
      const nextPageCount = pageRows[0]?.page_count ?? currentPageCount

      // Defensive escape hatch: a driver/SQLite combination that reports no
      // reclaim progress must never turn the background loop into a CPU spin.
      if (nextFree >= currentFree && nextPageCount >= currentPageCount) {
        currentFree = nextFree
        currentPageCount = nextPageCount
        break
      }

      currentFree = nextFree
      currentPageCount = nextPageCount
      yield* Effect.yieldNow
      if (mode === "drain") yield* Effect.sleep(Duration.millis(CHUNKDB_RECLAIM_DRAIN_PAUSE_MS))
    }

    const needsMore = mode === "drain" && shouldDrainFreelist(currentFree, currentPageCount)

    return {
      attempted: true,
      reclaimedPages: Math.max(0, initialFree - currentFree),
      freePages: currentFree,
      pageCount: currentPageCount,
      needsMore,
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
): Effect.Effect<{ promoted: number; bytes: number; processed: number }, EffectDrizzleQueryError | SqlError> {
  return Effect.gen(function* () {
    const cutoff = Date.now() - CHUNKDB_COOLING_MS
    const batchSize = options?.batchSize ?? CHUNKDB_BATCH_SIZE
    let promoted = 0
    let bytes = 0
    let processed = 0

    for (;;) {
      const candidates = yield* db.all<{ id: string; data: string }>(sql`
        SELECT e.id, e.data
        FROM event e
        JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
        LEFT JOIN session se ON se.id = e.aggregate_id
        WHERE e.seq <= es.seq
          AND (
            se.id IS NULL
            OR se.time_updated <= ${cutoff}
            OR e.seq <= es.seq - ${CHUNKDB_HOT_TAIL_EVENTS}
          )
          AND typeof(e.data) = 'text'
          AND length(e.data) >= 4096
          AND NOT EXISTS (
            SELECT 1 FROM ocdb_seal os
            WHERE os.table_name = 'event'
              AND os.row_id = e.id
              AND os.column_name = 'data'
              AND os.reseal_needed = 0
          )
        ORDER BY e.aggregate_id, e.seq
        LIMIT ${batchSize}
      `)

      if (candidates.length === 0) break

      for (const candidate of candidates) {
        const rawLen = encoder.encode(candidate.data).byteLength
        const frame = compressText(candidate.data)
        processed += 1
        if (typeof frame === "string") {
          yield* db.run(sql`
            INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed, reseal_needed)
            VALUES ('event', ${candidate.id}, 'data', ${rawLen}, ${rawLen}, 0, 0, ${Date.now()}, 0)
            ON CONFLICT (table_name, row_id, column_name) DO UPDATE SET
              raw_bytes = excluded.raw_bytes,
              stored_bytes = excluded.stored_bytes,
              time_sealed = excluded.time_sealed
          `)
          continue
        }
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`UPDATE event SET data = ${frame} WHERE id = ${candidate.id}`)
            yield* tx.run(sql`
              INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed, reseal_needed)
              VALUES ('event', ${candidate.id}, 'data', ${rawLen}, ${frame.byteLength}, ${frame[5]}, ${frame[4]}, ${Date.now()}, 0)
              ON CONFLICT (table_name, row_id, column_name) DO UPDATE SET
                raw_bytes = excluded.raw_bytes,
                stored_bytes = excluded.stored_bytes,
                time_sealed = excluded.time_sealed
            `)
          }),
        )
        promoted += 1
        bytes += rawLen
      }

      yield* Effect.yieldNow
      if (processed >= (options?.maxRowsPerPass ?? MAX_ROWS_PER_PASS)) break
    }

    // Reclaim freed pages (bounded) so the file does not grow unbounded.
    yield* reclaimSpace(db)
    // Drop stale audit-journal entries so ocdb_seal does not grow 1:1 with
    // every sealed event over the DB's lifetime.
    yield* pruneSealJournal(db)

    return { promoted, bytes, processed }
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
  { promoted: number; repeated: number; bytes: number; processed: number },
  EffectDrizzleQueryError | SqlError
> {
  return Effect.gen(function* () {
    const cutoff = Date.now() - CHUNKDB_COOLING_MS
    const batchSize = options?.batchSize ?? CHUNKDB_BATCH_SIZE
    const maxRowsPerPass = options?.maxRowsPerPass ?? MAX_ROWS_PER_PASS
    // Epoch-3: when OPENCODE_SEAL_WORKERS is on, compression runs on the
    // worker-thread pool (parallel) instead of inline on the main thread.
    const useWorkers = Flag.OPENCODE_SEAL_WORKERS
    let promoted = 0
    let repeated = 0
    let bytes = 0
    let processed = 0
    // Epoch-4 #10: track the last NON-delta (full-frame) promoted value per
    // aggregate so subsequent candidates can be stored as a sparse correction
    // (v5 delta_ref) against it. Only non-delta bases are tracked — a delta_ref
    // value is never used as a base, which avoids nested deltas (the read path
    // resolves a base via decodeValueBytesRaw, which only handles v1-v4).
    const lastBaseByAggregate = new Map<string, { valueId: string; raw: Uint8Array }>()

    for (;;) {
      // IMPORTANT: candidate discovery MUST stay bounded. The previous
      // `agg_total` CTE evaluated SUM(length(data)) over the entire eligible
      // history before SQLite could return the first 128 rows. On a 10+ GiB
      // production DB that turned an 8 ms indexed candidate seek into a
      // minutes-long/full-history scan, so the sealer logged "started" but never
      // reached its first transaction. Aggregate sizing is now computed from the
      // already-fetched batch below; aggregates that have ever externalized stay
      // externalized, preserving a stable representation across later batches.
      const candidates = yield* db.all<{
        id: string
        aggregate_id: string
        seq: number
        data: string
      }>(sql`
        SELECT e.id, e.aggregate_id, e.seq, e.data
        FROM event e
        JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
        LEFT JOIN session se ON se.id = e.aggregate_id
        WHERE e.seq <= es.seq
          AND (
            se.id IS NULL
            OR se.time_updated <= ${cutoff}
            OR e.seq <= es.seq - ${CHUNKDB_HOT_TAIL_EVENTS}
          )
          AND typeof(e.data) = 'text'
          AND length(e.data) >= 4096
          AND NOT EXISTS (
            SELECT 1 FROM ocdb_seal os
            WHERE os.table_name = 'event'
              AND os.row_id = e.id
              AND os.column_name = 'data'
              AND os.reseal_needed = 0
          )
        ORDER BY e.aggregate_id, e.seq
        LIMIT ${batchSize}
      `)

      if (candidates.length === 0) break

      // Decide + compress OUTSIDE the transaction. The dedup lookup is a read
      // and compression is CPU-heavy, so neither belongs on the SQLite write
      // path. With workers, compression runs in parallel on the pool; the
      // transaction below only applies the precomputed writes (crash-consistent
      // as before — either the whole batch commits or none of it).
      type Candidate = (typeof candidates)[number]
      type Prepared = { candidate: Candidate; rawBytes: Uint8Array; externalize: boolean; sha?: string }
      type PendingPlan =
        | { kind: "skip" }
        | { kind: "inline"; prepared: Prepared }
        | { kind: "repeat"; prepared: Prepared; valueId: string }
        | { kind: "first"; prepared: Prepared; sha: string; valueId: string }
      type Plan =
        | { kind: "skip" }
        | { kind: "inline"; candidate: Candidate; frame: string | Uint8Array; rawLen: number }
        | { kind: "repeat"; candidate: Candidate; valueId: string; rawLen: number }
        | { kind: "first"; candidate: Candidate; sha: string; frame: string | Uint8Array; valueId: string; rawLen: number }
      const pending: PendingPlan[] = []
      // Batch-aware dedup: the event_value lookup below only sees rows committed
      // by PREVIOUS passes. Two candidates in THIS batch with the same
      // (aggregate_id, sha256) would both plan as "first" and the transaction
      // would hit the UNIQUE(aggregate_id, sha256) constraint. Track what this
      // batch already plans to promote so the second occurrence becomes a
      // "repeat" pointing at the first's value_id.
      const batchSeen = new Map<string, string>()
      const rawPrepared = candidates.map((candidate) => ({ candidate, rawBytes: encoder.encode(candidate.data) }))
      const batchBytesByAggregate = new Map<string, number>()
      for (const { candidate, rawBytes } of rawPrepared) {
        batchBytesByAggregate.set(
          candidate.aggregate_id,
          (batchBytesByAggregate.get(candidate.aggregate_id) ?? 0) + rawBytes.byteLength,
        )
      }

      // One tiny metadata query for the aggregates represented in this batch.
      // Once an aggregate has event_value rows, keep externalizing subsequent
      // batches even if the remaining tail alone is below the size threshold.
      const aggregatesWithValues = new Set<string>()
      const aggregateIDs = [...new Set(candidates.map((candidate) => candidate.aggregate_id))]
      if (aggregateIDs.length > 0) {
        const ids = sql.join(aggregateIDs.map((id) => sql`${id}`), sql`, `)
        const rows = yield* db.all<{ aggregate_id: string }>(sql`
          SELECT DISTINCT aggregate_id FROM event_value WHERE aggregate_id IN (${ids})
        `).pipe(Effect.orDie)
        for (const row of rows) aggregatesWithValues.add(row.aggregate_id)
      }

      const externalizeAggregates = new Set<string>()
      for (const [aggregateID, batchBytes] of batchBytesByAggregate) {
        if (batchBytes > CHUNKDB_EXTERNALIZE_MIN_AGGREGATE_BYTES) externalizeAggregates.add(aggregateID)
      }

      // ORDER BY (aggregate_id, seq) means only the final aggregate can be cut
      // by LIMIT. If its visible slice is below the 64 KiB externalization gate,
      // probe only enough of that aggregate to decide the threshold exactly.
      // Every candidate is >=4 KiB, so 17 rows are sufficient to prove >64 KiB;
      // this stays O(1) and never reintroduces a full-history SUM(length(data)).
      if (candidates.length === batchSize) {
        const trailingAggregate = candidates.at(-1)?.aggregate_id
        if (
          trailingAggregate !== undefined &&
          !aggregatesWithValues.has(trailingAggregate) &&
          !externalizeAggregates.has(trailingAggregate)
        ) {
          const thresholdRows = yield* db.all<{ bytes: number }>(sql`
            SELECT length(CAST(e.data AS BLOB)) AS bytes
            FROM event e
            JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
            LEFT JOIN session se ON se.id = e.aggregate_id
            WHERE e.aggregate_id = ${trailingAggregate}
              AND e.seq <= es.seq
              AND (
                se.id IS NULL
                OR se.time_updated <= ${cutoff}
                OR e.seq <= es.seq - ${CHUNKDB_HOT_TAIL_EVENTS}
              )
              AND typeof(e.data) = 'text'
              AND length(e.data) >= 4096
              AND NOT EXISTS (
                SELECT 1 FROM ocdb_seal os
                WHERE os.table_name = 'event'
                  AND os.row_id = e.id
                  AND os.column_name = 'data'
                  AND os.reseal_needed = 0
              )
            ORDER BY e.seq
            LIMIT 17
          `).pipe(Effect.orDie)
          const aggregateBytes = thresholdRows.reduce((total, row) => total + row.bytes, 0)
          if (aggregateBytes > CHUNKDB_EXTERNALIZE_MIN_AGGREGATE_BYTES) {
            externalizeAggregates.add(trailingAggregate)
          }
        }
      }

      const prepared: Prepared[] = rawPrepared.map(({ candidate, rawBytes }) => {
        const externalize =
          externalizeAggregates.has(candidate.aggregate_id) ||
          aggregatesWithValues.has(candidate.aggregate_id)
        return {
          candidate,
          rawBytes,
          externalize,
          sha: externalize ? createHash("sha256").update(rawBytes).digest("hex") : undefined,
        }
      })
      const external = prepared.filter((entry): entry is Prepared & { sha: string } => entry.externalize && entry.sha !== undefined)
      // ONE batched dedup lookup for the whole batch (row-value IN) instead of a
      // per-candidate SELECT — a bulk promote does 2000 round-trips otherwise.
      const committed = new Map<string, string>()
      if (external.length > 0) {
        const pairs = sql.join(
          external.map(({ candidate, sha }) => sql`(${candidate.aggregate_id}, ${sha})`),
          sql`, `,
        )
        const rows = yield* db.all<{ aggregate_id: string; value_id: string; sha256: string }>(sql`
          SELECT aggregate_id, value_id, sha256 FROM event_value
          WHERE (aggregate_id, sha256) IN (${pairs})
        `).pipe(Effect.orDie)
        for (const r of rows) committed.set(`${r.aggregate_id}:${r.sha256}`, r.value_id)
      }
      for (const item of prepared) {
        const { candidate } = item
        // Idempotency: a row already promoted to a reference is short TEXT, so
        // the length >= 4096 filter already excludes it; bail early if one
        // slips through (defensive, never re-promote a ref).
        if (candidate.data.startsWith(`{"${CDB_REF}"`)) {
          pending.push({ kind: "skip" })
          continue
        }

        if (!item.externalize) {
          pending.push({ kind: "inline", prepared: item })
          continue
        }

        const sha = item.sha!

        const existingValueId = committed.get(`${candidate.aggregate_id}:${sha}`)
        if (existingValueId) {
          // REPEAT — the dedup win. Point this event at the existing row and
          // bump its refcount; the payload is NOT stored again.
          pending.push({ kind: "repeat", prepared: item, valueId: existingValueId })
          continue
        }

        const batchKey = `${candidate.aggregate_id}:${sha}`
        const batchHit = batchSeen.get(batchKey)
        if (batchHit) {
          // REPEAT within this batch — the identical payload is already planned
          // for promotion below; point at its value_id instead of inserting a
          // duplicate row (which would violate UNIQUE(aggregate_id, sha256)).
          pending.push({ kind: "repeat", prepared: item, valueId: batchHit })
          continue
        }

        const valueId = `${candidate.aggregate_id}:${candidate.seq}`
        batchSeen.set(batchKey, valueId)
        pending.push({ kind: "first", prepared: item, sha, valueId })
      }

      // Fill the worker pool instead of awaiting one compression job at a time.
      // The pool itself caps CPU concurrency; Effect concurrency only keeps its
      // queue fed. Sync mode intentionally remains serial.
      const compressionTargets = pending.filter(
        (plan): plan is Extract<PendingPlan, { kind: "inline" | "first" }> =>
          plan.kind === "inline" || plan.kind === "first",
      )
      const compressed = yield* Effect.all(
        compressionTargets.map((plan) => {
          const raw = plan.prepared.candidate.data
          const effect = useWorkers
            ? Effect.promise(() => compressTextAsync(raw))
            : Effect.sync(() => compressText(raw))
          return effect.pipe(Effect.map((frame) => [plan.prepared.candidate.id, frame] as const))
        }),
        { concurrency: useWorkers ? 16 : 1 },
      )
      const frameByID = new Map(compressed)

      const plans: Plan[] = []
      // Delta matching is useful for modest record-shaped values, but it is the
      // wrong representation for jumbo rows. Besides adding read amplification,
      // building a correction requires indexing/comparing both raw values. Keep
      // jumbo payloads on the independently-decodable v4 segmented frame path.
      // This also makes a corrupted/hostile giant event incapable of monopolizing
      // a background sealing pass when delta mode is explicitly enabled.
      const deltaMaxRawBytes = 4 * 1024 * 1024
      for (const plan of pending) {
        if (plan.kind === "skip") {
          plans.push(plan)
          continue
        }
        const { candidate, rawBytes } = plan.prepared
        const rawLen = rawBytes.byteLength
        if (plan.kind === "inline") {
          plans.push({ kind: "inline", candidate, frame: frameByID.get(candidate.id) ?? candidate.data, rawLen })
          continue
        }
        if (plan.kind === "repeat") {
          plans.push({ kind: "repeat", candidate, valueId: plan.valueId, rawLen })
          continue
        }

        const frame = frameByID.get(candidate.id) ?? candidate.data
        let finalFrame: string | Uint8Array = frame
        if (
          Flag.OPENCODE_SEAL_DELTA &&
          typeof frame !== "string" &&
          rawBytes.byteLength <= deltaMaxRawBytes
        ) {
          const base = lastBaseByAggregate.get(candidate.aggregate_id)
          if (base !== undefined && base.raw.byteLength <= deltaMaxRawBytes) {
            const { codec, level } = chooseCodec(rawBytes.byteLength)
            const delta = compressDeltaRef(rawBytes, base.raw, base.valueId, codec, level)
            if (delta.byteLength < frame.byteLength * 0.7) finalFrame = delta
          }
        }
        if (finalFrame === frame) lastBaseByAggregate.set(candidate.aggregate_id, { valueId: plan.valueId, raw: rawBytes })
        plans.push({ kind: "first", candidate, sha: plan.sha, frame: finalFrame, valueId: plan.valueId, rawLen })
      }

      const writePlans = plans.filter((plan): plan is Exclude<Plan, { kind: "skip" }> => plan.kind !== "skip")
      const slices: Array<Array<Exclude<Plan, { kind: "skip" }>>> = []
      let slice: Array<Exclude<Plan, { kind: "skip" }>> = []
      let sliceBytes = 0
      const weight = (plan: Exclude<Plan, { kind: "skip" }>) => {
        if (plan.kind === "repeat") return 256
        if (plan.kind === "inline") return typeof plan.frame === "string" ? 256 : plan.frame.byteLength
        return typeof plan.frame === "string" ? plan.rawLen : plan.frame.byteLength
      }
      for (const plan of writePlans) {
        const bytesForPlan = weight(plan)
        if (
          slice.length > 0 &&
          (slice.length >= CHUNKDB_WRITE_SLICE_ROWS || sliceBytes + bytesForPlan > CHUNKDB_WRITE_SLICE_BYTES)
        ) {
          slices.push(slice)
          slice = []
          sliceBytes = 0
        }
        slice.push(plan)
        sliceBytes += bytesForPlan
      }
      if (slice.length > 0) slices.push(slice)

      for (const writeSlice of slices) {
        for (;;) {
          const outcome = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                let committedPromoted = 0
                let committedRepeated = 0
                let committedBytes = 0
                let committedProcessed = 0
                for (const plan of writeSlice) {
                  const candidate = plan.candidate
                  const raw = candidate.data
                  committedProcessed += 1

                  if (plan.kind === "inline") {
                    if (typeof plan.frame === "string") {
                      // Incompressible small row: remember the decision so it is
                      // not recompressed every ten minutes. It remains ordinary TEXT.
                      yield* tx.run(sql`
                        INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed, reseal_needed)
                        VALUES ('event', ${candidate.id}, 'data', ${plan.rawLen}, ${plan.rawLen}, 0, 0, ${Date.now()}, 0)
                        ON CONFLICT (table_name, row_id, column_name) DO UPDATE SET
                          raw_bytes = excluded.raw_bytes,
                          stored_bytes = excluded.stored_bytes,
                          time_sealed = excluded.time_sealed
                      `)
                      continue
                    }
                    yield* tx.run(sql`UPDATE event SET data = ${plan.frame} WHERE id = ${candidate.id}`)
                    yield* tx.run(sql`
                      INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed, reseal_needed)
                      VALUES ('event', ${candidate.id}, 'data', ${plan.rawLen}, ${plan.frame.byteLength}, ${plan.frame[5]}, ${plan.frame[4]}, ${Date.now()}, 0)
                      ON CONFLICT (table_name, row_id, column_name) DO UPDATE SET
                        raw_bytes = excluded.raw_bytes,
                        stored_bytes = excluded.stored_bytes,
                        codec = excluded.codec,
                        frame_version = excluded.frame_version,
                        time_sealed = excluded.time_sealed
                    `)
                    committedPromoted += 1
                    committedBytes += plan.rawLen
                    continue
                  }

                  if (plan.kind === "repeat") {
                    const ref = toCdbRef(plan.valueId)
                    yield* tx.run(sql`UPDATE event SET data = ${ref} WHERE id = ${candidate.id}`)
                    yield* tx.run(sql`
                      UPDATE event_value SET refs = refs + 1
                      WHERE aggregate_id = ${candidate.aggregate_id} AND value_id = ${plan.valueId}
                    `)
                    yield* tx.run(sql`
                      INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed, reseal_needed)
                      VALUES ('event', ${candidate.id}, 'data', ${plan.rawLen}, ${ref.length}, 0, 0, ${Date.now()}, 0)
                      ON CONFLICT (table_name, row_id, column_name) DO UPDATE SET
                        raw_bytes = excluded.raw_bytes,
                        stored_bytes = excluded.stored_bytes,
                        time_sealed = excluded.time_sealed
                    `)
                    committedRepeated += 1
                    committedBytes += plan.rawLen
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
                    VALUES (${candidate.aggregate_id}, ${plan.valueId}, ${plan.sha}, ${plan.rawLen}, ${stored}, 1, ${Date.now()})
                  `)
                  if (stored instanceof Uint8Array && isV5Frame(stored)) {
                    const dependency = parseV5Header(stored)
                    yield* tx.run(sql`
                      INSERT INTO event_value_dependency (aggregate_id, value_id, base_value_id)
                      VALUES (${candidate.aggregate_id}, ${plan.valueId}, ${dependency.baseValueId})
                      ON CONFLICT(aggregate_id, value_id) DO UPDATE SET
                        base_value_id = excluded.base_value_id
                    `)
                  }
                  yield* tx.run(sql`
                    INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed, reseal_needed)
                      VALUES ('event', ${candidate.id}, 'data', ${plan.rawLen}, ${stored.byteLength}, ${codec}, ${typeof frame === "string" ? 0 : frame[4]}, ${Date.now()}, 0)
                    ON CONFLICT (table_name, row_id, column_name) DO UPDATE SET
                      raw_bytes = excluded.raw_bytes,
                      stored_bytes = excluded.stored_bytes,
                      time_sealed = excluded.time_sealed
                  `)
                  committedPromoted += 1
                  committedBytes += plan.rawLen
                }
                return {
                  promoted: committedPromoted,
                  repeated: committedRepeated,
                  bytes: committedBytes,
                  processed: committedProcessed,
                }
              }),
            )
            .pipe(
              Effect.map((stats) => ({ kind: "ok" as const, stats })),
              Effect.catch((error) => Effect.succeed({ kind: "error" as const, error })),
            )

          if (outcome.kind === "ok") {
            promoted += outcome.stats.promoted
            repeated += outcome.stats.repeated
            bytes += outcome.stats.bytes
            processed += outcome.stats.processed
            break
          }
          if (!isSqliteBusy(outcome.error)) return yield* Effect.fail(outcome.error)
          // Foreground owns the SQLite writer slot. Do not queue behind it for
          // seconds; yield and retry this exact atomic slice later.
          yield* Effect.sleep(Duration.millis(CHUNKDB_BUSY_RETRY_MS))
        }

        yield* Effect.yieldNow
        yield* Effect.sleep(Duration.millis(CHUNKDB_WRITE_SLICE_PAUSE_MS))
      }
      if (processed >= maxRowsPerPass) break
    }

    // Reclaim freed pages (bounded) so the file does not grow unbounded.
    yield* reclaimSpace(db)
    // Drop stale audit-journal entries so ocdb_seal does not grow 1:1 with
    // every sealed event over the DB's lifetime.
    yield* pruneSealJournal(db)

    return { promoted, repeated, bytes, processed }
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
 * reads aren't starved. Compression is planned in 128-row batches, but writes
 * are committed in foreground-priority microtransactions (<=8 rows / <=512KiB)
 * with a yield between slices. When a pass no longer hits the cap it settles
 * to MAINTENANCE mode: 10-min spaced passes at `MAX_ROWS_PER_PASS`. Mode is
 * derived from the previous pass result — no extra state, no cursor.
 * `Flag.OPENCODE_SEAL_BACKFILL` set to 0 forces maintenance-only. A failed pass
 * doubles the wait (exponential, capped at `BACKOFF_CAP_MS`) so a broken DB
 * isn't hammered; the loop survives and resets on success.
 */
type SealerPassOutcome =
  | { kind: "ok"; promoted: number; repeated: number; processed: number; bytes: number }
  | { kind: "failed"; promoted: number; repeated: number; processed: number; bytes: number }

export interface SealerBacklog {
  /** Sampled large TEXT rows still awaiting a seal decision. */
  pending: number
  /** Sampled pending rows that are eligible on this pass. */
  eligible: number
  /** Sampled pending rows deliberately retained in an active session's hot tail. */
  hotDeferred: number
  /** Informational only: sampled rows belonging to a sync-owned aggregate. */
  syncOwned: number
  /** Approximate bytes for eligible rows in the bounded sample. */
  eligibleBytes: number
  /** True when more pending rows exist beyond the bounded diagnostic sample. */
  truncated: boolean
}

/** Bounded operator probe used by the loop. Diagnostics must never turn an idle
 * maintenance pass into a full-history scan, so this inspects at most
 * `BACKLOG_SAMPLE_ROWS + 1` candidate rows and reports whether it truncated. */
export function inspectSealerBacklog(
  db: DatabaseShape,
): Effect.Effect<SealerBacklog, EffectDrizzleQueryError | SqlError> {
  return Effect.gen(function* () {
    const cutoff = Date.now() - CHUNKDB_COOLING_MS
    const rows = yield* db.all<{
      pending: number
      eligible: number
      sync_owned: number
      eligible_bytes: number
    }>(sql`
      WITH sample AS (
        SELECT
          e.seq AS event_seq,
          es.seq AS frontier_seq,
          es.owner_id AS owner_id,
          se.id AS session_id,
          se.time_updated AS session_time_updated,
          length(CAST(e.data AS BLOB)) AS bytes
        FROM event e
        JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
        LEFT JOIN session se ON se.id = e.aggregate_id
        WHERE e.seq <= es.seq
          AND typeof(e.data) = 'text'
          AND length(e.data) >= 4096
          AND NOT EXISTS (
            SELECT 1 FROM ocdb_seal os
            WHERE os.table_name = 'event'
              AND os.row_id = e.id
              AND os.column_name = 'data'
              AND os.reseal_needed = 0
          )
        ORDER BY e.aggregate_id, e.seq
        LIMIT ${BACKLOG_SAMPLE_ROWS + 1}
      )
      SELECT
        COUNT(*) AS pending,
        COALESCE(SUM(CASE WHEN (
          session_id IS NULL
          OR session_time_updated <= ${cutoff}
          OR event_seq <= frontier_seq - ${CHUNKDB_HOT_TAIL_EVENTS}
        ) THEN 1 ELSE 0 END), 0) AS eligible,
        COALESCE(SUM(CASE WHEN owner_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS sync_owned,
        COALESCE(SUM(CASE WHEN (
          session_id IS NULL
          OR session_time_updated <= ${cutoff}
          OR event_seq <= frontier_seq - ${CHUNKDB_HOT_TAIL_EVENTS}
        ) THEN bytes ELSE 0 END), 0) AS eligible_bytes
      FROM sample
    `)
    const row = rows[0]
    const pending = row?.pending ?? 0
    const eligible = row?.eligible ?? 0
    return {
      pending,
      eligible,
      hotDeferred: Math.max(0, pending - eligible),
      syncOwned: row?.sync_owned ?? 0,
      eligibleBytes: row?.eligible_bytes ?? 0,
      truncated: pending > BACKLOG_SAMPLE_ROWS,
    }
  })
}

export function runSealerLoop(filename: string): Effect.Effect<void> {
  if (!Flag.OPENCODE_SEAL_ENABLED) return Effect.void
  const backfillAllowed = Flag.OPENCODE_SEAL_BACKFILL
  const key = sealerKey(filename)
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      if (activeSealers.has(key)) return false
      activeSealers.add(key)
      return true
    }),
    (acquired) => {
      if (!acquired) return Effect.logDebug("ChunkDB sealer already active", { filename, pid: process.pid })
      return withBackfillDb(filename, (db) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("ChunkDB sealer started", {
            filename,
            pid: process.pid,
            dedup: Flag.OPENCODE_SEAL_DEDUP,
            workers: Flag.OPENCODE_SEAL_WORKERS,
            delta: Flag.OPENCODE_SEAL_DELTA,
            semanticPrune: Flag.OPENCODE_SEAL_PRUNE,
            backfill: backfillAllowed,
            coolingMs: CHUNKDB_COOLING_MS,
            hotTailEvents: CHUNKDB_HOT_TAIL_EVENTS,
          })
          let previousHitCap: boolean = false
          let reclaimDraining = false
          let backoffMs = BACKOFF_BASE_MS
          for (;;) {
            const draining: boolean = previousHitCap && backfillAllowed
            const cap: number = draining ? CHUNKDB_BACKFILL_MAX_ROWS_PER_PASS : MAX_ROWS_PER_PASS
            const started = Date.now()
            if (Flag.OPENCODE_SEAL_PRUNE) {
              type SemanticLoopOutcome =
                | { readonly kind: "ok"; readonly value: SemanticPruneOutcome }
                | { readonly kind: "busy" }
                | { readonly kind: "failed" }
              const semanticOutcome: SemanticLoopOutcome = yield* runSemanticPrunePass(db, {
                limit: Math.min(cap, 8_192),
              }).pipe(
                Effect.map((value): SemanticLoopOutcome => ({ kind: "ok", value })),
                // Some migration/backfill helpers intentionally fail closed via
                // Effect.orDie. Catch at the Cause boundary so SQLITE_BUSY is
                // still recognized even when Drizzle wrapped it as a defect.
                // Interruptions are lifecycle signals, not maintenance errors;
                // preserve them exactly so scope shutdown remains prompt.
                Effect.catchCause((cause): Effect.Effect<SemanticLoopOutcome> => {
                  if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
                  if (isSqliteBusy(cause)) return Effect.succeed({ kind: "busy" })
                  return Effect.logWarning("ChunkDB semantic prune pass failed; backing off", {
                    filename,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as<SemanticLoopOutcome>({ kind: "failed" }))
                }),
              )
              if (semanticOutcome.kind === "busy") {
                // Every semantic write unit is atomic + idempotent. If a
                // foreground writer owns SQLite, abandon the current maintenance
                // pass immediately and retry later rather than queueing behind it
                // or killing the infinite sealer loop.
                yield* Effect.sleep(Duration.millis(CHUNKDB_BUSY_RETRY_MS))
                previousHitCap = false
                continue
              }
              if (semanticOutcome.kind === "failed") {
                yield* Effect.sleep(Duration.millis(backoffMs))
                backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS)
                previousHitCap = false
                continue
              }
              const pruned = semanticOutcome.value
              backoffMs = BACKOFF_BASE_MS
              if (pruned.inspected > 0) {
                yield* Effect.logInfo("ChunkDB semantic prune pass complete", { filename, ...pruned })
              }
              // Semantic elimination has priority over representation-level
              // compression. If we just proved and compacted snapshots, start
              // another semantic pass before the normal sealer can frame/ref the
              // remaining JSON and hide its entity key from candidate discovery.
              if (pruned.compacted > 0 || pruned.hasMore) {
                yield* Effect.sleep(Duration.millis(DRAIN_SLEEP_MS))
                continue
              }
            }
            const outcome: SealerPassOutcome = yield* runSealerPass(db, { maxRowsPerPass: cap }).pipe(
              Effect.catch((error) =>
                Effect.logError("ChunkDB sealer pass failed; backing off", { filename, error }).pipe(
                  Effect.as({ kind: "failed" as const, promoted: 0, repeated: 0, processed: 0, bytes: 0 }),
                ),
              ),
            )
            if (outcome.kind === "failed") {
              yield* Effect.sleep(Duration.millis(backoffMs))
              backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS)
              previousHitCap = false
              continue
            }
            backoffMs = BACKOFF_BASE_MS
            previousHitCap = outcome.processed >= cap
            if (outcome.processed > 0) {
              yield* Effect.logInfo("ChunkDB sealer pass complete", {
                filename,
                mode: draining ? "backfill" : "maintenance",
                processed: outcome.processed,
                promoted: outcome.promoted,
                repeated: outcome.repeated,
                rawBytes: outcome.bytes,
                durationMs: Date.now() - started,
                hitCap: previousHitCap,
              })
            } else {
              const backlog = yield* inspectSealerBacklog(db).pipe(
                Effect.catch(() =>
                  Effect.succeed<SealerBacklog>({
                    pending: 0,
                    eligible: 0,
                    hotDeferred: 0,
                    syncOwned: 0,
                    eligibleBytes: 0,
                    truncated: false,
                  }),
                ),
              )
              yield* Effect.logDebug("ChunkDB sealer idle", { filename, ...backlog })
            }

            // When sealing no longer has a capped backlog, immediately inspect
            // the physical freelist. A multi-GB historical backfill can leave the
            // logical DB tiny while SQLite still owns gigabytes of free pages.
            // Drain those pages in low-priority 15s slices until the free-space
            // ratio is sane instead of waiting ten minutes between ~160MB
            // maintenance reclaims. This also repairs a DB that finished its
            // backfill in a previous process before this policy existed.
            if (!previousHitCap) {
              const reclaim = yield* reclaimSpace(db, "drain")
              reclaimDraining = reclaim.needsMore
              if (reclaim.reclaimedPages > 0) {
                yield* Effect.logInfo("ChunkDB space reclaim progress", {
                  filename,
                  reclaimedPages: reclaim.reclaimedPages,
                  freePages: reclaim.freePages,
                  pageCount: reclaim.pageCount,
                  freeRatio: reclaim.pageCount > 0 ? reclaim.freePages / reclaim.pageCount : 0,
                  draining: reclaim.needsMore,
                })
              }
            } else {
              reclaimDraining = false
            }

            const wait = previousHitCap && backfillAllowed
              ? DRAIN_SLEEP_MS
              : reclaimDraining
                ? CHUNKDB_RECLAIM_DRAIN_SLEEP_MS
                : MAINTENANCE_INTERVAL_MS
            yield* Effect.sleep(Duration.millis(wait))
          }
        }),
      )
    },
    (acquired) =>
      acquired
        ? Effect.sync(() => {
            activeSealers.delete(key)
          })
        : Effect.void,
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
): Effect.Effect<
  { kind: "ok"; promoted: number; repeated: number; processed: number; bytes: number },
  EffectDrizzleQueryError | SqlError
> {
  if (Flag.OPENCODE_SEAL_DEDUP) {
    return runPassV2(db, options).pipe(
      Effect.map((result) => ({ kind: "ok" as const, ...result })),
    )
  }
  return runPass(db, options).pipe(
    Effect.map((result) => ({ kind: "ok" as const, promoted: result.promoted, repeated: 0, processed: result.processed, bytes: result.bytes })),
  )
}
