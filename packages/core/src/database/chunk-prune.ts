import { isDeepStrictEqual } from "node:util"
import { Duration, Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseShape } from "./database"
import { CHUNKDB_COOLING_MS, CHUNKDB_HOT_TAIL_EVENTS } from "./chunkdb"
import { CHECKPOINT_TYPE, recordCompactedSequences } from "./chunk-compaction"
import { isV5Frame, parseV5Header } from "./json-codec"
import { retrySqliteBusy } from "./sqlite-busy"
import {
  decodeSemanticStorage,
  semanticIdentity,
  semanticRef,
  SemanticKind,
  type SemanticIdentity,
  type SemanticKind as SemanticKindValue,
} from "./chunk-semantic"

/**
 * Semantic compaction sits ahead of ChunkDB's lossless codec layer.
 *
 * The persistent `event_semantic` side-index gives every supported full-
 * snapshot event a tiny identity tuple `(aggregate, seq, kind, entity)`. That
 * turns supersession discovery into indexed B-tree work; payload JSON is only
 * loaded for the latest entity snapshot when we must prove it still matches the
 * authoritative projection.
 *
 * Epoch 4 physically deletes proven-obsolete event rows and records their durable
 * positions in one dense aggregate bitmap. Strict contiguous replay is preserved
 * at transport boundaries by synthesizing `event.compacted.1` fillers; local
 * readers naturally tolerate sparse physical sequences.
 */
const DEFAULT_LIMIT = 128
// Candidate rows are tiny semantic-index records. A wider batch lets one proof
// of a jumbo latest snapshot amortize across thousands of superseded rows while
// write-lock granularity remains bounded separately by WRITE_SLICE_ROWS.
const MAX_LIMIT = 8_192
const CURSOR_KEY = "semantic_prune_cursor_v3"
const BACKFILL_CURSOR_KEY = "semantic_index_backfill_cursor_v2"
const BACKFILL_UPPER_KEY = "semantic_index_backfill_upper_v2"
const TRANSFORMED_CURSOR_KEY = "semantic_index_transformed_cursor_v2"
const DEPENDENCY_CURSOR_KEY = "semantic_dependency_backfill_cursor_v1"
const DEPENDENCY_UPPER_KEY = "semantic_dependency_backfill_upper_v1"
export const SEMANTIC_HISTORY_EPOCH_KEY = "semantic_history_epoch_v1"
// ~36 ms on the 10 GiB corpus measured from the 636k-row/12s full extraction.
// Keep one synchronous SQLite slice small enough not to create a foreground
// latency cliff, then yield to the normal sealer loop.
const BACKFILL_ROWID_SPAN = 2_048
// Historical $cdbRef cells are tiny and decode concurrency remains capped at 4;
// only extracted IDs survive each decode. 256 cuts migration loop overhead ~4x
// versus the original conservative 64 without increasing simultaneous jumbo
// payload retention.
const TRANSFORMED_BACKFILL_ROWS = 256
const DEPENDENCY_BACKFILL_ROWID_SPAN = 2_048
const PROOF_LOOKUP_CHUNK = 256
const TRANSFORMED_IDENTITY_CACHE_ENTRIES = 8_192
// Sparse compaction writes only tiny metadata plus one aggregate bitmap BLOB.
// Separate-process contention benchmark, 8,192 deletions, median-of-3:
//   64 rows  -> ~2.126 s maintenance
//   128 rows -> ~1.135 s
//   256 rows -> ~0.573 s, foreground writer p99 ~2.3 ms
//   512 rows -> ~0.488 s but foreground p99 ~15-16 ms
// 256 is the Pareto point: ~3.7x the 64-row throughput while avoiding the
// 512-row tail-latency cliff. Exact slices retry on SQLITE_BUSY.
const WRITE_SLICE_ROWS = 256
const WRITE_SLICE_PAUSE_MS = 2
const WRITE_SLICE_BUSY_RETRY_MS = 35
const LEGACY_CHECKPOINT_MIGRATE_ROWS = 2_048

// Migration-only cache. Historical dedup refs are immutable while semantic
// index backfill is incomplete, so one canonical payload needs to be decoded at
// most once per process even if hundreds of event rows reference it. Cache only
// the tiny extracted identity; never retain the decoded payload itself.
const transformedIdentityCache = new WeakMap<object, Map<string, SemanticIdentity | null>>()

function cacheIdentity(db: object, key: string, value: SemanticIdentity | undefined) {
  let cache = transformedIdentityCache.get(db)
  if (!cache) {
    cache = new Map()
    transformedIdentityCache.set(db, cache)
  }
  if (cache.size >= TRANSFORMED_IDENTITY_CACHE_ENTRIES && !cache.has(key)) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, value ?? null)
}

function cachedIdentity(db: object, key: string): { hit: boolean; value?: SemanticIdentity } {
  const cache = transformedIdentityCache.get(db)
  if (!cache?.has(key)) return { hit: false }
  return { hit: true, value: cache.get(key) ?? undefined }
}

type Policy = {
  readonly kind: SemanticKindValue
  readonly type: "message.updated.1" | "message.part.updated.1"
  readonly path: "$.info.id" | "$.part.id"
  readonly projection: "message" | "part"
  readonly identity: readonly string[]
}

const POLICIES: readonly Policy[] = [
  {
    kind: SemanticKind.Message,
    type: "message.updated.1",
    path: "$.info.id",
    projection: "message",
    identity: ["id", "sessionID"],
  },
  {
    kind: SemanticKind.Part,
    type: "message.part.updated.1",
    path: "$.part.id",
    projection: "part",
    identity: ["id", "messageID", "sessionID"],
  },
]

type Candidate = {
  readonly id: string
  readonly aggregateID: string
  readonly aggregateKey: number
  readonly seq: number
  readonly type: Policy["type"]
  readonly entityKey: number
  readonly entityID: string
  readonly parentID: string | null
  readonly supersededSeq: number
}

type Proof = {
  readonly supersededSeq: number
  readonly supersededBy: string
  readonly entityID: string
  readonly parentID: string | null
}

export type SemanticPruneOutcome = {
  readonly inspected: number
  readonly compacted: number
  readonly payloadBytesReclaimed: number
  readonly bitmapBytesStored: number
  readonly projectionMismatches: number
  readonly compatibilityRejected: number
  readonly aggregateID?: string
  readonly hasMore: boolean
  readonly indexBackfilled: number
  readonly indexComplete: boolean
  readonly canonicalValuesDeleted: number
  readonly canonicalBytesReclaimed: number
  readonly dependencyBackfilled: number
  readonly dependencyComplete: boolean
  readonly checkpointRowsMigrated: number
}

function projectionMatchesContent(
  candidate: Candidate,
  latestValue: unknown,
  projectionValue: unknown,
  projectionParentID: string | null,
  policy: Policy,
): boolean {
  try {
    if (!latestValue || typeof latestValue !== "object" || Array.isArray(latestValue)) return false
    const source = Reflect.get(latestValue, policy.kind === SemanticKind.Message ? "info" : "part")
    if (!source || typeof source !== "object" || Array.isArray(source)) return false
    if (Reflect.get(source, "id") !== candidate.entityID || Reflect.get(source, "sessionID") !== candidate.aggregateID) {
      return false
    }
    if (
      policy.kind === SemanticKind.Part &&
      (Reflect.get(source, "messageID") !== candidate.parentID ||
        Reflect.get(source, "messageID") !== projectionParentID)
    ) {
      return false
    }
    const projected = Object.assign({}, source)
    for (const key of policy.identity) Reflect.deleteProperty(projected, key)
    return isDeepStrictEqual(projected, projectionValue)
  } catch {
    return false
  }
}

const metaNumber = Effect.fn("ChunkDB.semanticPrune.metaNumber")(function* (db: DatabaseShape, key: string) {
  const row = yield* db.get<{ value: string | null }>(sql`SELECT value FROM ocdb_meta WHERE key = ${key}`).pipe(Effect.orDie)
  if (row?.value == null) return undefined
  const value = Number(row.value)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
})

const historyEpoch = Effect.fn("ChunkDB.semanticPrune.historyEpoch")(function* (db: DatabaseShape) {
  const row = yield* db
    .get<{ value: string | null }>(sql`SELECT value FROM ocdb_meta WHERE key = ${SEMANTIC_HISTORY_EPOCH_KEY}`)
    .pipe(Effect.orDie)
  const value = Number(row?.value ?? 0)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
})

const writeMeta = Effect.fn("ChunkDB.semanticPrune.writeMeta")(function* (
  db: DatabaseShape,
  key: string,
  value: string | number,
  expectedHistoryEpoch: number,
) {
  // Acquire SQLite's writer slot before checking the epoch. A history reset
  // increments the epoch in its own IMMEDIATE transaction; any stale backfill
  // writer waiting behind that reset therefore observes the new epoch and its
  // cursor write becomes a no-op instead of poisoning the fresh database.
  yield* db
    .transaction(
      (tx) =>
        tx.run(sql`
          INSERT INTO ocdb_meta(key, value)
          SELECT ${key}, ${String(value)}
          WHERE COALESCE(
            (SELECT CAST(value AS INTEGER) FROM ocdb_meta WHERE key = ${SEMANTIC_HISTORY_EPOCH_KEY}),
            0
          ) = ${expectedHistoryEpoch}
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
          WHERE COALESCE(
            (SELECT CAST(value AS INTEGER) FROM ocdb_meta WHERE key = ${SEMANTIC_HISTORY_EPOCH_KEY}),
            0
          ) = ${expectedHistoryEpoch}
        `),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

const prepareSemanticStage = Effect.fn("ChunkDB.semanticPrune.prepareStage")(function* (db: DatabaseShape) {
  yield* db.run(`CREATE TEMP TABLE IF NOT EXISTS ocdb_semantic_stage (
    aggregate_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    entity_id TEXT NOT NULL,
    parent_id TEXT
  )`).pipe(Effect.orDie)
  yield* db.run(`DELETE FROM ocdb_semantic_stage`).pipe(Effect.orDie)
})

const flushSemanticStage = Effect.fn("ChunkDB.semanticPrune.flushStage")(function* (
  db: DatabaseShape,
  proven: 0 | 1,
) {
  yield* db.run(`
    INSERT OR IGNORE INTO semantic_aggregate (aggregate_id)
    SELECT DISTINCT stage.aggregate_id
    FROM ocdb_semantic_stage stage
    JOIN event source
      ON source.aggregate_id = stage.aggregate_id
     AND source.seq = stage.seq
  `).pipe(Effect.orDie)
  yield* db.run(`
    INSERT OR IGNORE INTO semantic_entity (aggregate_key, kind, entity_id, parent_id)
    SELECT a.aggregate_key, s.kind, s.entity_id, s.parent_id
    FROM ocdb_semantic_stage s
    JOIN event source
      ON source.aggregate_id = s.aggregate_id
     AND source.seq = s.seq
    JOIN semantic_aggregate a ON a.aggregate_id = s.aggregate_id
    GROUP BY a.aggregate_key, s.kind, s.entity_id, s.parent_id
  `).pipe(Effect.orDie)
  yield* db.run(sql`
    INSERT OR IGNORE INTO event_semantic (aggregate_key, seq, kind, entity_key, proven)
    SELECT a.aggregate_key, s.seq, s.kind, e.entity_key, ${proven}
    FROM ocdb_semantic_stage s
    JOIN event source
      ON source.aggregate_id = s.aggregate_id
     AND source.seq = s.seq
    JOIN semantic_aggregate a ON a.aggregate_id = s.aggregate_id
    JOIN semantic_entity e
      ON e.aggregate_key = a.aggregate_key
      AND e.kind = s.kind
      AND e.entity_id = s.entity_id
      AND e.parent_id IS s.parent_id
  `).pipe(Effect.orDie)
  const changed = yield* db.get<{ changes: number }>(sql`SELECT changes() AS changes`).pipe(Effect.orDie)
  return changed?.changes ?? 0
})

const prepareWriteStage = Effect.fn("ChunkDB.semanticPrune.prepareWriteStage")(function* (db: DatabaseShape) {
  yield* db.run(`CREATE TEMP TABLE IF NOT EXISTS ocdb_semantic_write_v4 (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    type TEXT NOT NULL,
    entity_key INTEGER NOT NULL,
    entity_id TEXT NOT NULL,
    parent_id TEXT,
    latest_seq INTEGER NOT NULL
  ) WITHOUT ROWID`).pipe(Effect.orDie)
  yield* db.run(`CREATE TEMP TABLE IF NOT EXISTS ocdb_semantic_valid_v4 (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    ref_id TEXT,
    raw_bytes INTEGER NOT NULL
  ) WITHOUT ROWID`).pipe(Effect.orDie)
})

/**
 * One bounded v3 -> v4 migration slice. Old binaries materialized one physical
 * `event.compacted.1` row per semantic hole. Epoch 4 folds those rows into the
 * aggregate bitmap and deletes them. This is idempotent: bitmap insertion tests
 * each bit before incrementing its count, so a crash after recording but before
 * deletion is safe to retry.
 */
const migrateLegacyCheckpoints = Effect.fn("ChunkDB.semanticPrune.migrateLegacyCheckpoints")(function* (
  db: DatabaseShape,
) {
  yield* db.run(`CREATE INDEX IF NOT EXISTS ocdb_checkpoint_migrate_idx
    ON event (aggregate_id, seq) WHERE type = 'event.compacted.1'`).pipe(Effect.orDie)
  const rows = yield* db.all<{ id: string; aggregateID: string; seq: number }>(sql`
    SELECT id, aggregate_id AS aggregateID, seq
    FROM event INDEXED BY ocdb_checkpoint_migrate_idx
    WHERE type = 'event.compacted.1'
    ORDER BY aggregate_id, seq
    LIMIT ${LEGACY_CHECKPOINT_MIGRATE_ROWS}
  `).pipe(Effect.orDie)
  if (rows.length === 0) {
    yield* db.run(`DROP INDEX IF EXISTS ocdb_checkpoint_migrate_idx`).pipe(Effect.orDie)
    return { migrated: 0, hasMore: false }
  }

  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const byAggregate = new Map<string, number[]>()
      for (const row of rows) {
        const seqs = byAggregate.get(row.aggregateID)
        if (seqs) seqs.push(row.seq)
        else byAggregate.set(row.aggregateID, [row.seq])
      }
      for (const [aggregateID, seqs] of byAggregate) {
        yield* recordCompactedSequences(tx, aggregateID, seqs)
      }
      const ids = sql.join(rows.map((row) => sql`${row.id}`), sql`, `)
      yield* tx.run(sql`DELETE FROM event WHERE id IN (${ids})`).pipe(Effect.orDie)
      yield* tx.run(sql`
        DELETE FROM ocdb_seal
        WHERE table_name = 'event'
          AND column_name = 'data'
          AND row_id IN (${ids})
      `).pipe(Effect.orDie)
    }),
  ).pipe(Effect.orDie)
  return { migrated: rows.length, hasMore: rows.length >= LEGACY_CHECKPOINT_MIGRATE_ROWS }
})

/**
 * One bounded historical identity-index backfill slice. It never materializes
 * event payloads in JS: SQLite extracts only the two entity IDs and writes the
 * compact key tuples directly. Already framed/ref rows are intentionally skipped
 * here; the sealer now gives semantic indexing first refusal, so a normal
 * pre-ChunkDB database is completely indexed before representation transforms.
 */
export const backfillSemanticIndex = Effect.fn("ChunkDB.semanticPrune.backfillIndex")(function* (
  db: DatabaseShape,
  expectedHistoryEpoch: number,
) {
  let upper = yield* metaNumber(db, BACKFILL_UPPER_KEY)
  if (upper === undefined) {
    upper =
      (yield* db.get<{ value: number }>(sql`SELECT coalesce(max(rowid), 0) AS value FROM event`).pipe(Effect.orDie))
        ?.value ?? 0
    yield* writeMeta(db, BACKFILL_UPPER_KEY, upper, expectedHistoryEpoch)
  }

  let cursor = (yield* metaNumber(db, BACKFILL_CURSOR_KEY)) ?? 0
  let indexed = 0
  if (cursor < upper) {
    const through = Math.min(upper, cursor + BACKFILL_ROWID_SPAN)
    yield* prepareSemanticStage(db)
    yield* db.run(sql`
      INSERT INTO ocdb_semantic_stage (aggregate_id, seq, kind, entity_id, parent_id)
      SELECT aggregate_id,
             seq,
             CASE type
               WHEN 'message.updated.1' THEN ${SemanticKind.Message}
               ELSE ${SemanticKind.Part}
             END,
             CASE type
               WHEN 'message.updated.1' THEN json_extract(data, '$.info.id')
               ELSE json_extract(data, '$.part.id')
             END,
             CASE type
               WHEN 'message.part.updated.1' THEN json_extract(data, '$.part.messageID')
               ELSE NULL
             END
      FROM event
      WHERE rowid > ${cursor} AND rowid <= ${through}
        AND type IN ('message.updated.1', 'message.part.updated.1')
        AND typeof(data) = 'text'
        AND json_valid(data)
        AND CASE type
          WHEN 'message.updated.1' THEN json_type(data, '$.info.id') = 'text'
          ELSE json_type(data, '$.part.id') = 'text'
        END
        AND (type = 'message.updated.1' OR json_type(data, '$.part.messageID') = 'text')
    `).pipe(Effect.orDie)
    indexed += yield* flushSemanticStage(db, 0)
    yield* writeMeta(db, BACKFILL_CURSOR_KEY, through, expectedHistoryEpoch)
    cursor = through
    if (through < upper) return { indexed, cursor: through, upper, complete: false }
  }

  // A database may already contain ChunkDB refs/frames when this feature first
  // ships. Recover only the still-unindexed transformed rows. Their stored event
  // cells are tiny refs/compressed BLOBs, so this never re-materializes giant
  // plain JSON merely to discover identity. Decode is bounded and fail-closed;
  // failures are indexed with NULL identity so they cannot trap the backfill.
  const transformedCursor = (yield* metaNumber(db, TRANSFORMED_CURSOR_KEY)) ?? 0
  const transformed = yield* db.all<{
    rowid: number
    aggregateID: string
    seq: number
    type: string
    data: string | Uint8Array
  }>(sql`
    SELECT e.rowid,
           e.aggregate_id AS aggregateID,
           e.seq,
           e.type,
           e.data
    FROM event e
    LEFT JOIN semantic_aggregate a ON a.aggregate_id = e.aggregate_id
    LEFT JOIN event_semantic s ON s.aggregate_key = a.aggregate_key AND s.seq = e.seq
    WHERE e.rowid > ${transformedCursor} AND e.rowid <= ${upper}
      AND s.aggregate_key IS NULL
      AND e.type IN ('message.updated.1', 'message.part.updated.1')
      AND (
        typeof(e.data) = 'blob'
        OR (
          typeof(e.data) = 'text'
          AND substr(e.data, 1, 12) = '{"$cdbRef":"'
        )
      )
    ORDER BY e.rowid
    LIMIT ${TRANSFORMED_BACKFILL_ROWS}
  `).pipe(Effect.orDie)
  if (transformed.length === 0) return { indexed, cursor, upper, complete: true }

  const decoded = yield* Effect.all(
    transformed.map((row) => {
      const ref = semanticRef(row.data)
      const key = ref ? `${row.aggregateID}\0${ref}` : undefined
      if (key) {
        const cached = cachedIdentity(db, key)
        if (cached.hit) return Effect.succeed({ row, identity: cached.value })
      }
      return decodeSemanticStorage(db, row.aggregateID, row.data).pipe(
        Effect.map((value) => {
          const identity = semanticIdentity(row.type, value)
          if (key) cacheIdentity(db, key, identity)
          return { row, identity }
        }),
        Effect.catch(() => {
          if (key) cacheIdentity(db, key, undefined)
          return Effect.succeed({ row, identity: undefined })
        }),
      )
    }),
    { concurrency: 4 },
  )
  const valid = decoded.flatMap((item) => (item.identity ? [{ row: item.row, identity: item.identity }] : []))
  if (valid.length > 0) {
    yield* prepareSemanticStage(db)
    const tuples = valid.map(({ row, identity }) => sql`(
      ${row.aggregateID},
      ${row.seq},
      ${identity.kind},
      ${identity.entityID},
      ${identity.parentID ?? null}
    )`)
    yield* db.run(sql`
      INSERT INTO ocdb_semantic_stage (aggregate_id, seq, kind, entity_id, parent_id)
      VALUES ${sql.join(tuples, sql`, `)}
    `).pipe(Effect.orDie)
    indexed += yield* flushSemanticStage(db, 0)
  }
  const transformedThrough = transformed.at(-1)?.rowid ?? transformedCursor
  yield* writeMeta(db, TRANSFORMED_CURSOR_KEY, transformedThrough, expectedHistoryEpoch)
  return {
    indexed,
    cursor,
    upper,
    complete: transformedThrough >= upper || transformed.length < TRANSFORMED_BACKFILL_ROWS,
  }
})

/**
 * Recover explicit v5 child -> base edges for databases sealed before the
 * dependency table existed. Parsing a v5 header is O(header) and does not
 * decompress the correction payload. Invalid/missing-base rows are deliberately
 * left without an edge; canonical GC detects that condition per aggregate and
 * refuses to delete anything there.
 */
const backfillDeltaDependencies = Effect.fn("ChunkDB.semanticPrune.backfillDependencies")(function* (
  db: DatabaseShape,
  expectedHistoryEpoch: number,
) {
  const table = yield* db.get<{ one: number }>(sql`
    SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'event_value' LIMIT 1
  `).pipe(Effect.orDie)
  if (!table) return { indexed: 0, complete: true }

  let upper = yield* metaNumber(db, DEPENDENCY_UPPER_KEY)
  if (upper === undefined) {
    upper =
      (yield* db.get<{ value: number }>(sql`SELECT coalesce(max(rowid), 0) AS value FROM event_value`).pipe(Effect.orDie))
        ?.value ?? 0
    yield* writeMeta(db, DEPENDENCY_UPPER_KEY, upper, expectedHistoryEpoch)
  }
  const cursor = (yield* metaNumber(db, DEPENDENCY_CURSOR_KEY)) ?? 0
  if (cursor >= upper) return { indexed: 0, complete: true }

  const through = Math.min(upper, cursor + DEPENDENCY_BACKFILL_ROWID_SPAN)
  const rows = yield* db.all<{ aggregateID: string; valueID: string; bytes: Uint8Array }>(sql`
    SELECT aggregate_id AS aggregateID,
           value_id AS valueID,
           bytes
    FROM event_value
    WHERE rowid > ${cursor} AND rowid <= ${through}
      AND typeof(bytes) = 'blob'
      AND substr(bytes, 1, 5) = X'4F43444205'
    ORDER BY rowid
  `).pipe(Effect.orDie)

  let indexed = 0
  for (const row of rows) {
    try {
      const bytes = row.bytes
      if (!isV5Frame(bytes)) continue
      const header = parseV5Header(bytes)
      yield* db.run(sql`
        INSERT INTO event_value_dependency (aggregate_id, value_id, base_value_id)
        SELECT ${row.aggregateID}, ${row.valueID}, ${header.baseValueId}
        WHERE EXISTS (
          SELECT 1 FROM event_value base
          WHERE base.aggregate_id = ${row.aggregateID}
            AND base.value_id = ${header.baseValueId}
        )
        ON CONFLICT(aggregate_id, value_id) DO UPDATE SET
          base_value_id = excluded.base_value_id
      `).pipe(Effect.orDie)
      const changed = yield* db.get<{ changes: number }>(sql`SELECT changes() AS changes`).pipe(Effect.orDie)
      indexed += changed?.changes ?? 0
    } catch {
      // Fail closed. The row remains dependency-unknown and gcZeroRefValues()
      // will quarantine this aggregate from canonical deletion.
    }
  }
  yield* writeMeta(db, DEPENDENCY_CURSOR_KEY, through, expectedHistoryEpoch)
  return { indexed, complete: through >= upper }
})

/** Find one local aggregate with an indexed, cold, superseded snapshot. */
const nextAggregate = Effect.fn("ChunkDB.semanticPrune.nextAggregate")(function* (
  db: DatabaseShape,
  cutoff: number,
  cursor: string,
) {
  return yield* db.get<{ aggregateID: string; aggregateKey: number }>(sql`
    SELECT se.id AS aggregateID,
           a.aggregate_key AS aggregateKey
    FROM session se
    JOIN event_sequence es ON es.aggregate_id = se.id
    JOIN semantic_aggregate a ON a.aggregate_id = se.id
    WHERE se.id > ${cursor}
      AND se.workspace_id IS NULL
      AND es.owner_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM event_semantic s INDEXED BY event_semantic_scan_idx
        WHERE s.aggregate_key = a.aggregate_key
          AND s.seq <= es.seq
          AND (se.time_updated <= ${cutoff} OR s.seq <= es.seq - ${CHUNKDB_HOT_TAIL_EVENTS})
          AND EXISTS (
            SELECT 1 FROM event_semantic newer INDEXED BY event_semantic_entity_latest_idx
            WHERE newer.entity_key = s.entity_key
              AND newer.seq > s.seq
          )
        LIMIT 1
      )
    ORDER BY se.id
    LIMIT 1
  `).pipe(Effect.orDie)
})

const readCursor = Effect.fn("ChunkDB.semanticPrune.readCursor")(function* (db: DatabaseShape) {
  const row = yield* db.get<{ value: string | null }>(sql`SELECT value FROM ocdb_meta WHERE key = ${CURSOR_KEY}`).pipe(Effect.orDie)
  return row?.value ?? ""
})

const writeCursor = Effect.fn("ChunkDB.semanticPrune.writeCursor")(function* (
  db: DatabaseShape,
  cursor: string,
  expectedHistoryEpoch: number,
) {
  yield* writeMeta(db, CURSOR_KEY, cursor, expectedHistoryEpoch)
})

const candidatesForPolicy = Effect.fn("ChunkDB.semanticPrune.candidatesForPolicy")(function* (
  db: DatabaseShape,
  aggregateID: string,
  aggregateKey: number,
  policy: Policy,
  cutoff: number,
  limit: number,
) {
  return yield* db.all<Candidate>(sql`
    SELECT e.id,
           e.aggregate_id AS aggregateID,
           s.aggregate_key AS aggregateKey,
           e.seq,
           e.type,
           s.entity_key AS entityKey,
           entity.entity_id AS entityID,
           entity.parent_id AS parentID,
           (
             SELECT newer.seq
             FROM event_semantic newer INDEXED BY event_semantic_entity_latest_idx
             WHERE newer.entity_key = s.entity_key
               AND newer.seq > s.seq
             ORDER BY newer.seq DESC
             LIMIT 1
           ) AS supersededSeq
    FROM event_semantic s INDEXED BY event_semantic_scan_idx
    JOIN semantic_entity entity ON entity.entity_key = s.entity_key
    CROSS JOIN event e INDEXED BY event_aggregate_seq_idx
      ON e.aggregate_id = ${aggregateID} AND e.seq = s.seq
    JOIN event_sequence es ON es.aggregate_id = ${aggregateID}
    JOIN session se ON se.id = ${aggregateID}
    WHERE s.aggregate_key = ${aggregateKey}
      AND s.kind = ${policy.kind}
      AND e.type = ${policy.type}
      AND e.seq <= es.seq
      AND (se.time_updated <= ${cutoff} OR e.seq <= es.seq - ${CHUNKDB_HOT_TAIL_EVENTS})
      AND se.workspace_id IS NULL
      AND es.owner_id IS NULL
      AND EXISTS (
        SELECT 1 FROM event_semantic newer INDEXED BY event_semantic_entity_latest_idx
        WHERE newer.entity_key = s.entity_key
          AND newer.seq > s.seq
      )
    ORDER BY s.seq
    LIMIT ${limit + 1}
  `).pipe(Effect.orDie)
})

const loadProofs = Effect.fn("ChunkDB.semanticPrune.loadProofs")(function* (
  db: DatabaseShape,
  aggregateID: string,
  aggregateKey: number,
  policy: Policy,
  candidates: ReadonlyArray<Candidate>,
) {
  const seqs = Array.from(new Set(candidates.map((candidate) => candidate.supersededSeq)))
  if (seqs.length === 0) return new Map<number, Proof>()
  const projectionParent = policy.projection === "part" ? sql`projection.message_id` : sql`NULL`
  type ProvenRow = {
    supersededSeq: number
    supersededBy: string
    entityID: string
    parentID: string | null
    projectionParentID: string | null
  }
  type UnprovenRow = ProvenRow & {
    latestData: string | Uint8Array | Record<string, unknown>
    projectionData: string | Uint8Array | Record<string, unknown>
  }
  const provenRows: ProvenRow[] = []
  const unprovenRows: UnprovenRow[] = []
  for (let start = 0; start < seqs.length; start += PROOF_LOOKUP_CHUNK) {
    const chunk = seqs.slice(start, start + PROOF_LOOKUP_CHUNK)
    const values = sql.join(chunk.map((seq) => sql`${seq}`), sql`, `)
    provenRows.push(
      ...(yield* db.all<ProvenRow>(sql`
        SELECT semantic.seq AS supersededSeq,
               replacement.id AS supersededBy,
               entity.entity_id AS entityID,
               entity.parent_id AS parentID,
               ${projectionParent} AS projectionParentID
        FROM event_semantic semantic INDEXED BY event_semantic_scan_idx
        JOIN semantic_entity entity ON entity.entity_key = semantic.entity_key
        JOIN event replacement
          ON replacement.aggregate_id = ${aggregateID} AND replacement.seq = semantic.seq
        JOIN ${sql.identifier(policy.projection)} projection
          ON projection.id = entity.entity_id AND projection.session_id = ${aggregateID}
        WHERE semantic.aggregate_key = ${aggregateKey}
          AND semantic.kind = ${policy.kind}
          AND semantic.proven = 1
          AND semantic.seq IN (${values})
          AND replacement.type = ${policy.type}
      `).pipe(Effect.orDie)),
    )
    unprovenRows.push(
      ...(yield* db.all<UnprovenRow>(sql`
        SELECT semantic.seq AS supersededSeq,
               replacement.id AS supersededBy,
               entity.entity_id AS entityID,
               entity.parent_id AS parentID,
               replacement.data AS latestData,
               projection.data AS projectionData,
               ${projectionParent} AS projectionParentID
        FROM event_semantic semantic INDEXED BY event_semantic_scan_idx
        JOIN semantic_entity entity ON entity.entity_key = semantic.entity_key
        JOIN event replacement
          ON replacement.aggregate_id = ${aggregateID} AND replacement.seq = semantic.seq
        JOIN ${sql.identifier(policy.projection)} projection
          ON projection.id = entity.entity_id AND projection.session_id = ${aggregateID}
        WHERE semantic.aggregate_key = ${aggregateKey}
          AND semantic.kind = ${policy.kind}
          AND semantic.proven = 0
          AND semantic.seq IN (${values})
          AND replacement.type = ${policy.type}
      `).pipe(Effect.orDie)),
    )
  }

  const verified = new Map<number, Proof>()
  for (const row of provenRows) {
    if (policy.kind === SemanticKind.Part && row.parentID !== row.projectionParentID) continue
    verified.set(row.supersededSeq, {
      supersededSeq: row.supersededSeq,
      supersededBy: row.supersededBy,
      entityID: row.entityID,
      parentID: row.parentID,
    })
  }

  const candidateByLatest = new Map<number, Candidate>()
  for (const candidate of candidates) candidateByLatest.set(candidate.supersededSeq, candidate)
  const decoded = yield* Effect.all(
    unprovenRows.map((row) =>
      Effect.all(
        [
          decodeSemanticStorage(db, aggregateID, row.latestData),
          decodeSemanticStorage(db, aggregateID, row.projectionData),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([latestValue, projectionValue]) => {
          const candidate = candidateByLatest.get(row.supersededSeq)
          if (
            !candidate ||
            candidate.entityID !== row.entityID ||
            !projectionMatchesContent(
              candidate,
              latestValue,
              projectionValue,
              row.projectionParentID,
              policy,
            )
          ) {
            return undefined
          }
          return {
            supersededSeq: row.supersededSeq,
            supersededBy: row.supersededBy,
            entityID: row.entityID,
            parentID: row.parentID,
          } satisfies Proof
        }),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    ),
    { concurrency: 4 },
  )
  const newlyProven = decoded.flatMap((proof) => (proof ? [proof] : []))
  for (const proof of newlyProven) verified.set(proof.supersededSeq, proof)

  // Content proof is a one-time migration cost. Once it succeeds, certify the
  // latest semantic mapping so all later passes stay metadata-only.
  const provenSeqs = newlyProven.map((proof) => proof.supersededSeq)
  for (let start = 0; start < provenSeqs.length; start += PROOF_LOOKUP_CHUNK) {
    const chunk = provenSeqs.slice(start, start + PROOF_LOOKUP_CHUNK)
    const values = sql.join(chunk.map((seq) => sql`${seq}`), sql`, `)
    yield* db.run(sql`
      UPDATE event_semantic
      SET proven = 1
      WHERE aggregate_key = ${aggregateKey}
        AND seq IN (${values})
        AND proven = 0
    `).pipe(Effect.orDie)
  }
  return verified
})

const gcZeroRefValues = Effect.fn("ChunkDB.semanticPrune.gcZeroRefs")(function* (
  db: DatabaseShape,
  aggregateID: string,
) {
  const table = yield* db.get<{ one: number }>(sql`
    SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'event_value' LIMIT 1
  `).pipe(Effect.orDie)
  if (!table) return { values: 0, bytes: 0 }
  // Any v5 value without a recovered child->base edge makes the dependency
  // graph incomplete. Quarantine only that aggregate from canonical deletion;
  // semantic marker rewrites remain safe and can continue.
  const unknownDelta = yield* db.get<{ one: number }>(sql`
    SELECT 1 AS one
    FROM event_value value
    LEFT JOIN event_value_dependency dependency
      ON dependency.aggregate_id = value.aggregate_id
      AND dependency.value_id = value.value_id
    WHERE value.aggregate_id = ${aggregateID}
      AND typeof(value.bytes) = 'blob'
      AND substr(value.bytes, 1, 5) = X'4F43444205'
      AND dependency.value_id IS NULL
    LIMIT 1
  `).pipe(Effect.orDie)
  if (unknownDelta) return { values: 0, bytes: 0 }

  // `refs > 0` are direct roots (events and collapsed projections both bump
  // refs). Follow v5 child->base edges transitively; every value outside this
  // live closure is physically unreachable and may be deleted, even when it is
  // itself a delta or the base of an already-dead delta.
  const reclaim = yield* db.get<{ count: number; bytes: number }>(sql`
    WITH RECURSIVE live(value_id) AS (
      SELECT value_id
      FROM event_value
      WHERE aggregate_id = ${aggregateID} AND refs > 0
      UNION
      SELECT dependency.base_value_id
      FROM event_value_dependency dependency
      JOIN live ON live.value_id = dependency.value_id
      WHERE dependency.aggregate_id = ${aggregateID}
    )
    SELECT count(*) AS count,
           coalesce(sum(length(value.bytes)), 0) AS bytes
    FROM event_value value
    WHERE value.aggregate_id = ${aggregateID}
      AND NOT EXISTS (SELECT 1 FROM live WHERE live.value_id = value.value_id)
  `).pipe(Effect.orDie)
  if ((reclaim?.count ?? 0) === 0) return { values: 0, bytes: 0 }
  yield* db.run(sql`
    WITH RECURSIVE live(value_id) AS (
      SELECT value_id
      FROM event_value
      WHERE aggregate_id = ${aggregateID} AND refs > 0
      UNION
      SELECT dependency.base_value_id
      FROM event_value_dependency dependency
      JOIN live ON live.value_id = dependency.value_id
      WHERE dependency.aggregate_id = ${aggregateID}
    )
    DELETE FROM event_value
    WHERE aggregate_id = ${aggregateID}
      AND NOT EXISTS (SELECT 1 FROM live WHERE live.value_id = event_value.value_id)
  `).pipe(Effect.orDie)
  // Do not rely on PRAGMA foreign_keys being enabled on every maintenance/test
  // connection. Production enables it, but explicit cleanup keeps the derived
  // dependency graph self-consistent even on a recovery connection that does
  // not. A surviving child can never point at a deleted base because the live
  // closure keeps every transitive base of a live child.
  yield* db.run(sql`
    DELETE FROM event_value_dependency
    WHERE aggregate_id = ${aggregateID}
      AND NOT EXISTS (
        SELECT 1 FROM event_value value
        WHERE value.aggregate_id = event_value_dependency.aggregate_id
          AND value.value_id = event_value_dependency.value_id
      )
  `).pipe(Effect.orDie)
  return { values: reclaim?.count ?? 0, bytes: reclaim?.bytes ?? 0 }
})

/** Run one bounded semantic-compaction/indexing pass. */
export const runSemanticPrunePass = Effect.fn("ChunkDB.semanticPrune.runPass")(function* (
  db: DatabaseShape,
  options?: { readonly limit?: number; readonly now?: number; readonly writeSliceRows?: number },
) {
  const requested = options?.limit ?? DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(MAX_LIMIT, requested))
  const writeSliceRows = Math.max(1, Math.min(512, options?.writeSliceRows ?? WRITE_SLICE_ROWS))
  const expectedHistoryEpoch = yield* historyEpoch(db)
  const checkpointMigration = yield* migrateLegacyCheckpoints(db)
  const dependency = yield* backfillDeltaDependencies(db, expectedHistoryEpoch)
  const backfill = yield* backfillSemanticIndex(db, expectedHistoryEpoch)
  if (!backfill.complete || !dependency.complete) {
    return {
      inspected: 0,
      compacted: 0,
      payloadBytesReclaimed: 0,
      bitmapBytesStored: 0,
      projectionMismatches: 0,
      compatibilityRejected: 0,
      hasMore: true,
      indexBackfilled: backfill.indexed,
      indexComplete: false,
      canonicalValuesDeleted: 0,
      canonicalBytesReclaimed: 0,
      dependencyBackfilled: dependency.indexed,
      dependencyComplete: dependency.complete,
      checkpointRowsMigrated: checkpointMigration.migrated,
    } satisfies SemanticPruneOutcome
  }

  const now = options?.now ?? Date.now()
  const cutoff = now - CHUNKDB_COOLING_MS
  const cursor = yield* readCursor(db)
  const aggregate = yield* nextAggregate(db, cutoff, cursor)
  if (!aggregate) {
    if (cursor !== "") yield* writeCursor(db, "", expectedHistoryEpoch)
    return {
      inspected: 0,
      compacted: 0,
      payloadBytesReclaimed: 0,
      bitmapBytesStored: 0,
      projectionMismatches: 0,
      compatibilityRejected: 0,
      hasMore: checkpointMigration.hasMore,
      indexBackfilled: backfill.indexed,
      indexComplete: true,
      canonicalValuesDeleted: 0,
      canonicalBytesReclaimed: 0,
      dependencyBackfilled: dependency.indexed,
      dependencyComplete: true,
      checkpointRowsMigrated: checkpointMigration.migrated,
    } satisfies SemanticPruneOutcome
  }
  const { aggregateID, aggregateKey } = aggregate

  const selected: Array<Candidate & { readonly policy: Policy }> = []
  for (const policy of POLICIES) {
    const rows = yield* candidatesForPolicy(db, aggregateID, aggregateKey, policy, cutoff, limit)
    selected.push(...rows.map((row) => ({ ...row, policy })))
  }
  selected.sort((a, b) => a.seq - b.seq)
  const hasMore = selected.length > limit
  const inspected = selected.slice(0, limit)

  const proofByPolicy = new Map<Policy["kind"], Map<number, Proof>>()
  for (const policy of POLICIES) {
    const policyCandidates = inspected.filter((candidate) => candidate.policy.kind === policy.kind)
    proofByPolicy.set(policy.kind, yield* loadProofs(db, aggregateID, aggregateKey, policy, policyCandidates))
  }
  const safe = inspected.flatMap((candidate) => {
    const proof = proofByPolicy.get(candidate.policy.kind)?.get(candidate.supersededSeq)
    if (!proof || proof.entityID !== candidate.entityID || proof.parentID !== candidate.parentID) return []
    return [{ candidate, proof }]
  })
  const projectionMismatches = inspected.length - safe.length

  // Revalidate ownership/projection in the write transaction. If foreground
  // activity changes either before commit, the conditional UPDATE affects zero
  // rows. Semantic-index deletion is in the same transaction as the rewrite.
  let compacted = 0
  let payloadBytesReclaimed = 0
  let bitmapBytesStored = 0
  let compatibilityRejected = 0

  if (safe.length > 0) {
    yield* prepareWriteStage(db)
    for (let start = 0; start < safe.length; start += writeSliceRows) {
      const slice = safe.slice(start, start + writeSliceRows)
      const outcome = yield* retrySqliteBusy(
        () =>
          db.transaction((tx) =>
            Effect.gen(function* () {
          yield* tx.run(`DELETE FROM ocdb_semantic_write_v4`)
          yield* tx.run(`DELETE FROM ocdb_semantic_valid_v4`)

          const rows = sql.join(
            slice.map(({ candidate, proof }) =>
              sql`(
                ${candidate.id},
                ${candidate.seq},
                ${candidate.policy.kind},
                ${candidate.type},
                ${candidate.entityKey},
                ${candidate.entityID},
                ${proof.parentID},
                ${proof.supersededSeq}
              )`,
            ),
            sql`, `,
          )
          yield* tx.run(sql`
            INSERT INTO ocdb_semantic_write_v4 (
              id, seq, kind, type, entity_key, entity_id, parent_id, latest_seq
            ) VALUES ${rows}
          `)

          // Validate the whole slice against the current authoritative state.
          // The TEMP plan contains only tiny IDs/checkpoints; giant event/projection
          // payloads are never copied into the write transaction. Message/part
          // branches stay separate so SQLite can use their native PK/indexes.
          yield* tx.run(sql`
            INSERT INTO ocdb_semantic_valid_v4 (id, seq, ref_id, raw_bytes)
            SELECT plan.id,
                   plan.seq,
                   CASE
                     WHEN typeof(event.data) = 'text'
                      AND length(event.data) <= 512
                      AND substr(event.data, 1, 12) = '{"$cdbRef":"'
                     THEN json_extract(event.data, '$."$cdbRef"')
                     ELSE NULL
                   END AS ref_id,
                   coalesce(
                     seal.raw_bytes,
                     CASE
                       WHEN typeof(event.data) = 'text'
                        AND length(event.data) <= 512
                        AND substr(event.data, 1, 12) = '{"$cdbRef":"'
                       THEN (
                         SELECT value.raw_len
                         FROM event_value value
                         WHERE value.aggregate_id = ${aggregateID}
                           AND value.value_id = json_extract(event.data, '$."$cdbRef"')
                       )
                       ELSE NULL
                     END,
                     length(CAST(event.data AS BLOB))
                   ) AS raw_bytes
            FROM ocdb_semantic_write_v4 plan
            JOIN event event ON event.id = plan.id
            JOIN message projection ON projection.id = plan.entity_id AND projection.session_id = ${aggregateID}
            LEFT JOIN ocdb_seal seal
              ON seal.table_name = 'event' AND seal.row_id = event.id AND seal.column_name = 'data'
            WHERE plan.kind = ${SemanticKind.Message}
              AND event.aggregate_id = ${aggregateID}
              AND event.seq = plan.seq
              AND event.type = plan.type
              AND EXISTS (
                SELECT 1 FROM event_sequence sequence
                WHERE sequence.aggregate_id = event.aggregate_id AND sequence.owner_id IS NULL
              )
              AND EXISTS (
                SELECT 1 FROM session session
                WHERE session.id = event.aggregate_id AND session.workspace_id IS NULL
              )
              AND plan.latest_seq = (
                SELECT latest.seq
                FROM event_semantic latest INDEXED BY event_semantic_entity_latest_idx
                WHERE latest.entity_key = plan.entity_key
                  AND latest.proven = 1
                ORDER BY latest.seq DESC
                LIMIT 1
              )
            UNION ALL
            SELECT plan.id,
                   plan.seq,
                   CASE
                     WHEN typeof(event.data) = 'text'
                      AND length(event.data) <= 512
                      AND substr(event.data, 1, 12) = '{"$cdbRef":"'
                     THEN json_extract(event.data, '$."$cdbRef"')
                     ELSE NULL
                   END AS ref_id,
                   coalesce(
                     seal.raw_bytes,
                     CASE
                       WHEN typeof(event.data) = 'text'
                        AND length(event.data) <= 512
                        AND substr(event.data, 1, 12) = '{"$cdbRef":"'
                       THEN (
                         SELECT value.raw_len
                         FROM event_value value
                         WHERE value.aggregate_id = ${aggregateID}
                           AND value.value_id = json_extract(event.data, '$."$cdbRef"')
                       )
                       ELSE NULL
                     END,
                     length(CAST(event.data AS BLOB))
                   ) AS raw_bytes
            FROM ocdb_semantic_write_v4 plan
            JOIN event event ON event.id = plan.id
            JOIN part projection
              ON projection.id = plan.entity_id
             AND projection.session_id = ${aggregateID}
             AND projection.message_id = plan.parent_id
            LEFT JOIN ocdb_seal seal
              ON seal.table_name = 'event' AND seal.row_id = event.id AND seal.column_name = 'data'
            WHERE plan.kind = ${SemanticKind.Part}
              AND event.aggregate_id = ${aggregateID}
              AND event.seq = plan.seq
              AND event.type = plan.type
              AND EXISTS (
                SELECT 1 FROM event_sequence sequence
                WHERE sequence.aggregate_id = event.aggregate_id AND sequence.owner_id IS NULL
              )
              AND EXISTS (
                SELECT 1 FROM session session
                WHERE session.id = event.aggregate_id AND session.workspace_id IS NULL
              )
              AND plan.latest_seq = (
                SELECT latest.seq
                FROM event_semantic latest INDEXED BY event_semantic_entity_latest_idx
                WHERE latest.entity_key = plan.entity_key
                  AND latest.proven = 1
                ORDER BY latest.seq DESC
                LIMIT 1
              )
          `)

          const stats = yield* tx.get<{ count: number; rawBytes: number }>(sql`
            SELECT count(*) AS count,
                   coalesce(sum(raw_bytes), 0) AS rawBytes
            FROM ocdb_semantic_valid_v4
          `)
          const validCount = stats?.count ?? 0
          if (validCount === 0) {
            return { validCount: 0, rawBytes: 0, bitmapGrowth: 0 }
          }

          // Group duplicate canonical refs so one UPDATE handles every event in
          // the slice that pointed at the same deduplicated value.
          yield* tx.run(sql`
            UPDATE event_value
            SET refs = max(
              0,
              refs - (
                SELECT count(*)
                FROM ocdb_semantic_valid_v4 valid
                WHERE valid.ref_id = event_value.value_id
              )
            )
            WHERE aggregate_id = ${aggregateID}
              AND value_id IN (
                SELECT ref_id FROM ocdb_semantic_valid_v4 WHERE ref_id IS NOT NULL
              )
          `)

          const validSeqs = yield* tx.all<{ seq: number }>(sql`
            SELECT seq FROM ocdb_semantic_valid_v4 ORDER BY seq
          `)
          const compaction = yield* recordCompactedSequences(
            tx,
            aggregateID,
            validSeqs.map((row) => row.seq),
          )
          yield* tx.run(sql`
            DELETE FROM event
            WHERE id IN (SELECT id FROM ocdb_semantic_valid_v4)
          `)
          yield* tx.run(sql`
            DELETE FROM event_semantic
            WHERE aggregate_key = ${aggregateKey}
              AND seq IN (SELECT seq FROM ocdb_semantic_valid_v4)
          `)
          yield* tx.run(sql`
            DELETE FROM ocdb_seal
            WHERE table_name = 'event'
              AND column_name = 'data'
              AND row_id IN (SELECT id FROM ocdb_semantic_valid_v4)
          `)

          return {
            validCount,
            rawBytes: stats?.rawBytes ?? 0,
            bitmapGrowth: compaction.grewBytes,
          }
            }),
          ),
        WRITE_SLICE_BUSY_RETRY_MS,
      )
      compatibilityRejected += slice.length - outcome.validCount
      compacted += outcome.validCount
      bitmapBytesStored += outcome.bitmapGrowth
      payloadBytesReclaimed += Math.max(0, outcome.rawBytes - outcome.bitmapGrowth)
      if (start + writeSliceRows < safe.length) yield* Effect.sleep(Duration.millis(WRITE_SLICE_PAUSE_MS))
    }
  }

  const gc = compacted > 0 ? yield* gcZeroRefValues(db, aggregateID) : { values: 0, bytes: 0 }

  // Keep draining an aggregate while it makes progress; skip mismatch-only
  // aggregates so one bad projection cannot starve every later session.
  // IMPORTANT: `hasMore` is consumed by the outer sealer as "more semantic
  // work exists anywhere", not merely "this aggregate has another candidate
  // page". When an aggregate is exhausted we therefore probe the NEXT
  // aggregate before returning. Otherwise the sealer falls through to its
  // normal 10-minute maintenance sleep between every session, turning a
  // minutes-long backfill into a multi-day migration.
  let hasLaterAggregate = false
  if (compacted === 0) {
    yield* writeCursor(db, aggregateID, expectedHistoryEpoch)
    hasLaterAggregate = (yield* nextAggregate(db, cutoff, aggregateID)) !== undefined
  }

  return {
    inspected: inspected.length,
    compacted,
    payloadBytesReclaimed,
    bitmapBytesStored,
    projectionMismatches,
    compatibilityRejected,
    aggregateID,
    hasMore: hasMore || checkpointMigration.hasMore || hasLaterAggregate,
    indexBackfilled: backfill.indexed,
    indexComplete: true,
    canonicalValuesDeleted: gc.values,
    canonicalBytesReclaimed: gc.bytes,
    dependencyBackfilled: dependency.indexed,
    dependencyComplete: true,
    checkpointRowsMigrated: checkpointMigration.migrated,
  } satisfies SemanticPruneOutcome
})

export const SemanticPrune = {
  historyEpochKey: SEMANTIC_HISTORY_EPOCH_KEY,
  checkpointType: CHECKPOINT_TYPE,
  policies: POLICIES,
  backfillRowidSpan: BACKFILL_ROWID_SPAN,
  gcCanonicalValues: gcZeroRefValues,
} as const
