import { Effect } from "effect"
import { Flag } from "../flag/flag"
import type { DatabaseShape } from "./database"

/**
 * Epoch-3 storage-tuning constants (storage-frontier-v3). All are FLAG-GATED
 * behind `Flag.OPENCODE_SEAL_ENABLED` and chosen from bench-storage.ts numbers.
 *
 * `page_size` and `auto_vacuum` are CREATE-TIME ONLY: SQLite refuses to change
 * them once any table exists or once WAL is enabled (doing so requires a full
 * blocking VACUUM), so they are applied by the sqlite native layer via
 * `createTimePragmas` BEFORE `journal_mode = WAL` (see sqlite.node.ts /
 * sqlite.bun.ts) and only take effect on a FRESH database. Existing DBs keep
 * their on-disk format forever (backward compatible, fail-closed on future
 * user_version). `mmap_size` was benchmarked and found NOT beneficial on this
 * workload/platform (slightly slower rehydration), so it is intentionally left
 * at the default (0) rather than set.
 */
/** 8192 is the pareto-optimal page for the event_value BLOB mix (50% 8KiB / 30% 32KiB / 20% 128KiB): fits the median value in one page while keeping slack on small rows lower than 16384. */
export const CHUNKDB_PAGE_SIZE = 8192
/** 2 = INCREMENTAL auto_vacuum. Enables bounded `PRAGMA incremental_vacuum(N)` reclaim instead of a blocking VACUUM. Create-time only. */
export const CHUNKDB_AUTO_VACUUM = 2
/** Pages reclaimed per sealer pass. Bounded so space reclamation never blocks reads. */
export const CHUNKDB_VACUUM_PAGES_PER_PASS = 100
/** Max incremental_vacuum chunks per reclaim pass (100 pages each). A bulk
 *  promote frees megabytes, so reclaimSpace loops in chunks until the freelist
 *  drains; this cap bounds a single pass (~16000 pages = 128MB at 8KiB pages). */
export const CHUNKDB_VACUUM_MAX_ITERATIONS = 200
/** Promotion batch size. Median-3 bench: 128 gives best/equal promote throughput AND the shortest write-lock window (110ms vs 170ms@256, 209ms@512); larger batches regress slightly and starve reads longer. Kept at 128; tunable via runPass/runPassV2 options. */
export const CHUNKDB_BATCH_SIZE = 128
/** Keep the newest events of a live session inline. Older immutable prefixes may
 * be sealed even while the session remains active; this bounds hot-path replay
 * amplification without waiting for the whole session to become dormant. */
export const CHUNKDB_HOT_TAIL_EVENTS = 256
/** Once a session has been idle this long, its remaining hot tail becomes
 * eligible too. Sealing is lossless and sync/replay paths rehydrate references,
 * so a one-hour cooling window is sufficient while still avoiding churn around
 * immediately active sessions. */
export const CHUNKDB_COOLING_MS = 60 * 60 * 1000
/** Externalization gate: only promote aggregates whose total externalizable bytes exceed this, so tiny sessions don't pay the $cdbRef indirection + event_value row overhead. */
export const CHUNKDB_EXTERNALIZE_MIN_AGGREGATE_BYTES = 64 * 1024
/** `ocdb_seal` is a write-only audit journal (the candidate filter keys off the
 *  event table, not this table), so it can be pruned aggressively. Entries older
 *  than this many days are dropped each pass; re-sealing a pruned row is a
 *  harmless no-op because it is already a frame / `$cdbRef` and won't be
 *  re-selected as a text candidate. */
export const CHUNKDB_SEAL_JOURNAL_RETENTION_DAYS = 30

/**
 * Epoch-1/2 ChunkDB schema wiring + epoch gate + DB-open integration.
 *
 * Idempotent. Creates the seal journal (`ocdb_seal`), the seal-candidate
 * partial index, the framing-epoch metadata row, and (epoch-2, when
 * `Flag.OPENCODE_SEAL_DEDUP` is on) the `event_value` reference table.
 * Enforces the epoch gate via `PRAGMA user_version`.
 *
 * REFERENCE ENCODING (epoch-2, owned here):
 *   When a payload is promoted under `OPENCODE_SEAL_DEDUP`, `event.data` is
 *   replaced by a SMALL inline JSON reference object:
 *       {"$cdbRef": "<value_id>"}
 *   where `value_id` is a string (the promoting event's identity, e.g.
 *   `${aggregate_id}:${seq}` — see the sealer's `runPassV2`). The
 *   `compressedJson` column's `fromDriver` simply
 *   JSON-parses this object — NO database access happens there. Rehydration
 *   (turning the reference back into the full payload, byte-exact) is the
 *   responsibility of the read path (readpath-v2): it reads `event_value.bytes`
 *   for `(aggregate_id, value_id)` and decodes it (see `decodeValueBytes` in
 *   json-codec.ts). `event_value.bytes` holds either a raw JSON UTF-8 BLOB
 *   (when compression gained nothing at seal time) or an OCDB v2 frame; the
 *   decoder detects the magic and decompresses or decodes accordingly. Because
 *   the original object is `JSON.parse(decode(bytes))` and `decode` is
 *   lossless (CRC-verified frame or verbatim UTF-8), rehydration is byte-exact
 *   via `node:assert`'s `isDeepStrictEqual`.
 *
 *   Deduplication: `event_value` is UNIQUE on `(aggregate_id, sha256)`, so two
 *   events in the same aggregate with identical payloads share one row; the
 *   second promotion bumps `refs` and points its `$cdbRef` at the first
 *   promoter's `value_id` instead of inserting a duplicate.
 *
 * EPOCH GATE (via `PRAGMA user_version`):
 *   0            -> claim as the highest enabled representation epoch
 *   <target      -> upgrade in place (e.g. an epoch-1 DB reopened with DEDUP on:
 *                   1 -> 2). Safe because the new schema is a strict superset.
 *   >maxAllowed  -> FAIL CLOSED (a future/newer binary owns a schema this one
 *                   cannot understand). `maxAllowed` is 1 when only
 *                   OPENCODE_SEAL_ENABLED is set, and 2 when OPENCODE_SEAL_DEDUP
 *                   is on. An epoch-1-only binary reading a `$cdbRef` DB
 *                   (user_version=2) therefore refuses, because it would
 *                   otherwise surface nonsense `{$cdbRef}` objects to consumers
 *                   instead of the real payload.
 *
 * All of this is FLAG-GATED behind `Flag.OPENCODE_SEAL_ENABLED`; when the flag
 * is off the function is a no-op so existing users are unaffected.
 */
/**
 * Create-time storage pragmas (`page_size`, `auto_vacuum = INCREMENTAL`) are
 * applied by the sqlite native layer (see `createTimePragmas` in sqlite.node.ts
 * / sqlite.bun.ts) BEFORE `journal_mode = WAL`, because `page_size`/`auto_vacuum`
 * are silent no-ops once WAL is enabled or any table exists. They are populated
 * from `CHUNKDB_PAGE_SIZE` / `CHUNKDB_AUTO_VACUUM` by the Database layer when
 * `Flag.OPENCODE_SEAL_ENABLED` is on, and are harmless no-ops on existing DBs
 * (whose on-disk format is frozen). This keeps the policy values here while the
 * mechanism lives in the connection-open path where it can actually take effect.
 */

export function ensureChunkDB(db: DatabaseShape): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!Flag.OPENCODE_SEAL_ENABLED) return

    const dedup = Flag.OPENCODE_SEAL_DEDUP
    const semantic = Flag.OPENCODE_SEAL_PRUNE

    yield* db.run(`CREATE TABLE IF NOT EXISTS ocdb_seal (
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      column_name TEXT NOT NULL,
      raw_bytes INTEGER NOT NULL,
      stored_bytes INTEGER NOT NULL,
      codec INTEGER NOT NULL,
      frame_version INTEGER NOT NULL,
      time_sealed INTEGER NOT NULL,
      reseal_needed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (table_name, row_id, column_name)
    )`).pipe(Effect.orDie)

    // Partial expression index over the sealer's candidate filter so eligibility
    // SELECTs seek directly to text rows >=4KiB instead of scanning all event rows.
    yield* db.run(`CREATE INDEX IF NOT EXISTS idx_event_seal_candidates
      ON event (aggregate_id, seq)
      WHERE typeof(data) = 'text' AND length(data) >= 4096`).pipe(Effect.orDie)

    yield* db.run(`CREATE TABLE IF NOT EXISTS ocdb_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )`).pipe(Effect.orDie)

    // Semantic identity is interned instead of repeating 25-40 byte session /
    // message / part IDs in every mapping row. On the 636,808-row production
    // corpus this layout measured ~54 MB versus ~174 MB for the original
    // string-heavy side-index, while preserving covering-index candidate seeks.
    //
    // `event_semantic.proven=1` is a projection-provenance certificate. New
    // durable snapshots are inserted only after their projector succeeds in the
    // same SQLite transaction, so they can be certified without ever reparsing
    // their payload. Historical backfill starts at 0 and upgrades a latest row
    // to 1 only after the one-time content proof succeeds.
    //
    // This side-index is DERIVED state. If a developer ran an earlier prototype
    // schema, discard it and rebuild from event history rather than carrying an
    // expensive migration for unpublished metadata. Legacy epoch-3 physical
    // `event.compacted.1` rows are migrated separately into the epoch-4 bitmap.
    const semanticColumns = yield* db.all<{ name: string }>(`PRAGMA table_info(event_semantic)`).pipe(Effect.orDie)
    const semanticColumnNames = new Set(semanticColumns.map((column) => column.name))
    const semanticSchemaReady =
      semanticColumns.length > 0 &&
      semanticColumnNames.has("aggregate_key") &&
      semanticColumnNames.has("entity_key") &&
      semanticColumnNames.has("proven") &&
      !semanticColumnNames.has("aggregate_id")
    if (semanticColumns.length > 0 && !semanticSchemaReady) {
      yield* db.run(`DROP INDEX IF EXISTS event_semantic_entity_latest_idx`).pipe(Effect.orDie)
      yield* db.run(`DROP INDEX IF EXISTS event_semantic_scan_idx`).pipe(Effect.orDie)
      yield* db.run(`DROP TABLE event_semantic`).pipe(Effect.orDie)
      yield* db.run(`DROP TABLE IF EXISTS semantic_entity`).pipe(Effect.orDie)
      yield* db.run(`DROP TABLE IF EXISTS semantic_aggregate`).pipe(Effect.orDie)
      yield* db.run(`DELETE FROM ocdb_meta WHERE key LIKE 'semantic_index_%' OR key LIKE 'semantic_prune_cursor_%'`).pipe(
        Effect.orDie,
      )
    }

    yield* db.run(`CREATE TABLE IF NOT EXISTS semantic_aggregate (
      aggregate_key INTEGER PRIMARY KEY,
      aggregate_id TEXT NOT NULL UNIQUE,
      FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
    )`).pipe(Effect.orDie)
    yield* db.run(`CREATE TABLE IF NOT EXISTS semantic_entity (
      entity_key INTEGER PRIMARY KEY,
      aggregate_key INTEGER NOT NULL,
      kind INTEGER NOT NULL,
      entity_id TEXT NOT NULL,
      parent_id TEXT,
      UNIQUE (aggregate_key, kind, entity_id),
      FOREIGN KEY (aggregate_key) REFERENCES semantic_aggregate(aggregate_key) ON DELETE CASCADE
    )`).pipe(Effect.orDie)
    yield* db.run(`CREATE TABLE IF NOT EXISTS event_semantic (
      aggregate_key INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      kind INTEGER NOT NULL,
      entity_key INTEGER NOT NULL,
      proven INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (aggregate_key, seq),
      FOREIGN KEY (aggregate_key) REFERENCES semantic_aggregate(aggregate_key) ON DELETE CASCADE,
      FOREIGN KEY (entity_key) REFERENCES semantic_entity(entity_key) ON DELETE CASCADE
    ) WITHOUT ROWID`).pipe(Effect.orDie)
    yield* db.run(`CREATE INDEX IF NOT EXISTS event_semantic_entity_latest_idx
      ON event_semantic (entity_key, seq DESC)`).pipe(Effect.orDie)
    yield* db.run(`CREATE INDEX IF NOT EXISTS event_semantic_scan_idx
      ON event_semantic (aggregate_key, kind, seq, entity_key)`).pipe(Effect.orDie)

    const existingSemanticEpoch = yield* db.all<{ value: string | null }>(
      `SELECT value FROM ocdb_meta WHERE key = 'semantic_epoch'`,
    ).pipe(Effect.orDie)
    const semanticCapability = semantic || Number(existingSemanticEpoch[0]?.value ?? 0) >= 1
    if (semanticCapability) {
      // Epoch-4 sparse semantic compaction. One bit per durable aggregate
      // sequence replaces hundreds of thousands of physical no-op marker rows.
      // New binaries synthesize `event.compacted.1` only at wire boundaries and
      // consume those fillers back into this bitmap during replay.
      yield* db.run(`CREATE TABLE IF NOT EXISTS event_compaction (
        aggregate_id TEXT PRIMARY KEY,
        bitmap BLOB NOT NULL,
        compacted_count INTEGER NOT NULL DEFAULT 0,
        time_updated INTEGER NOT NULL,
        FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
      ) WITHOUT ROWID`).pipe(Effect.orDie)

      // Projection provenance must survive writes outside the EventV2 projector
      // (for example CLI import). Any authoritative data mutation first clears
      // certificates for that entity. The normal durable projector fires this
      // trigger and then indexSemanticEvent() re-certifies the newly committed
      // snapshot later in the SAME transaction.
      yield* db.run(`CREATE TRIGGER IF NOT EXISTS ocdb_semantic_message_insert
        AFTER INSERT ON message
        BEGIN
          UPDATE event_semantic SET proven = 0
          WHERE entity_key IN (
            SELECT entity.entity_key
            FROM semantic_entity entity
            JOIN semantic_aggregate aggregate ON aggregate.aggregate_key = entity.aggregate_key
            WHERE aggregate.aggregate_id = NEW.session_id
              AND entity.kind = 1
              AND entity.entity_id = NEW.id
          );
        END`).pipe(Effect.orDie)
      yield* db.run(`CREATE TRIGGER IF NOT EXISTS ocdb_semantic_message_update
        AFTER UPDATE OF data ON message
        BEGIN
          UPDATE event_semantic SET proven = 0
          WHERE entity_key IN (
            SELECT entity.entity_key
            FROM semantic_entity entity
            JOIN semantic_aggregate aggregate ON aggregate.aggregate_key = entity.aggregate_key
            WHERE aggregate.aggregate_id = NEW.session_id
              AND entity.kind = 1
              AND entity.entity_id = NEW.id
          );
        END`).pipe(Effect.orDie)
      yield* db.run(`CREATE TRIGGER IF NOT EXISTS ocdb_semantic_message_delete
        AFTER DELETE ON message
        BEGIN
          UPDATE event_semantic SET proven = 0
          WHERE entity_key IN (
            SELECT entity.entity_key
            FROM semantic_entity entity
            JOIN semantic_aggregate aggregate ON aggregate.aggregate_key = entity.aggregate_key
            WHERE aggregate.aggregate_id = OLD.session_id
              AND entity.kind = 1
              AND entity.entity_id = OLD.id
          );
        END`).pipe(Effect.orDie)
      yield* db.run(`CREATE TRIGGER IF NOT EXISTS ocdb_semantic_part_insert
        AFTER INSERT ON part
        BEGIN
          UPDATE event_semantic SET proven = 0
          WHERE entity_key IN (
            SELECT entity.entity_key
            FROM semantic_entity entity
            JOIN semantic_aggregate aggregate ON aggregate.aggregate_key = entity.aggregate_key
            WHERE aggregate.aggregate_id = NEW.session_id
              AND entity.kind = 2
              AND entity.entity_id = NEW.id
          );
        END`).pipe(Effect.orDie)
      yield* db.run(`CREATE TRIGGER IF NOT EXISTS ocdb_semantic_part_update
        AFTER UPDATE OF data ON part
        BEGIN
          UPDATE event_semantic SET proven = 0
          WHERE entity_key IN (
            SELECT entity.entity_key
            FROM semantic_entity entity
            JOIN semantic_aggregate aggregate ON aggregate.aggregate_key = entity.aggregate_key
            WHERE aggregate.aggregate_id = NEW.session_id
              AND entity.kind = 2
              AND entity.entity_id = NEW.id
          );
        END`).pipe(Effect.orDie)
      yield* db.run(`CREATE TRIGGER IF NOT EXISTS ocdb_semantic_part_delete
        AFTER DELETE ON part
        BEGIN
          UPDATE event_semantic SET proven = 0
          WHERE entity_key IN (
            SELECT entity.entity_key
            FROM semantic_entity entity
            JOIN semantic_aggregate aggregate ON aggregate.aggregate_key = entity.aggregate_key
            WHERE aggregate.aggregate_id = OLD.session_id
              AND entity.kind = 2
              AND entity.entity_id = OLD.id
          );
        END`).pipe(Effect.orDie)
    }

    // Epoch-2 reference table: holds the externalized, deduplicated payloads.
    // Gated on OPENCODE_SEAL_DEDUP (which implies epoch-1). The FK to
    // event_sequence gives cascade cleanup when an aggregate is reset; `refs`
    // counts how many events point at the same (aggregate_id, sha256) value.
    if (dedup) {
      yield* db.run(`CREATE TABLE IF NOT EXISTS event_value (
        aggregate_id TEXT NOT NULL,
        value_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        raw_len INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        refs INTEGER NOT NULL DEFAULT 1,
        time_promoted INTEGER NOT NULL,
        PRIMARY KEY (aggregate_id, value_id),
        UNIQUE (aggregate_id, sha256),
        FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
      )`).pipe(Effect.orDie)

      // Explicit dependency edge for v5 delta_ref values. `refs` counts direct
      // event/projection references; this graph records the additional implicit
      // child -> base liveness edge so semantic GC can compute the exact
      // transitive live set instead of conservatively leaking every zero-ref
      // value in an aggregate that happens to contain a delta.
      yield* db.run(`CREATE TABLE IF NOT EXISTS event_value_dependency (
        aggregate_id TEXT NOT NULL,
        value_id TEXT NOT NULL,
        base_value_id TEXT NOT NULL,
        PRIMARY KEY (aggregate_id, value_id),
        FOREIGN KEY (aggregate_id, value_id)
          REFERENCES event_value(aggregate_id, value_id) ON DELETE CASCADE,
        FOREIGN KEY (aggregate_id, base_value_id)
          REFERENCES event_value(aggregate_id, value_id) ON DELETE NO ACTION
      ) WITHOUT ROWID`).pipe(Effect.orDie)
      yield* db.run(`CREATE INDEX IF NOT EXISTS event_value_dependency_base_idx
        ON event_value_dependency (aggregate_id, base_value_id)`).pipe(Effect.orDie)

      // NOTE: `idx_event_value_sha` (aggregate_id, sha256) is fully redundant
      // with the UNIQUE(aggregate_id, sha256) constraint, which already creates
      // `sqlite_autoindex_event_value_2` and serves the dedup seek (verified via
      // EXPLAIN QUERY PLAN: `SEARCH event_value USING INDEX
      // sqlite_autoindex_event_value_2 (aggregate_id=? AND sha256=?)`). Drop it
      // on every open so both fresh and existing DBs end up maintaining one
      // fewer index during promotion (less write amplification). Idempotent.
      yield* db.run(`DROP INDEX IF EXISTS idx_event_value_sha`).pipe(Effect.orDie)
    }

    // Representation metadata is MONOTONIC. Turning a writer flag off must not
    // pretend an existing DB no longer contains the representation that flag
    // previously emitted.
    const framing = yield* db.all<{ value: string | null }>(
      `SELECT value FROM ocdb_meta WHERE key = 'framing_epoch'`,
    ).pipe(Effect.orDie)
    const existingFraming = Number(framing[0]?.value ?? 0)
    const framingEpoch = Math.max(Number.isSafeInteger(existingFraming) ? existingFraming : 0, dedup ? 2 : 1)
    yield* db.run(
      `INSERT INTO ocdb_meta(key, value) VALUES ('framing_epoch', '${framingEpoch}')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).pipe(Effect.orDie)
    if (semantic) {
      yield* db.run(
        `INSERT INTO ocdb_meta(key, value) VALUES ('semantic_epoch', '2')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).pipe(Effect.orDie)
    }

    const rows = yield* db.all<{ user_version: number }>(`PRAGMA user_version`).pipe(Effect.orDie)
    const version = rows[0]?.user_version ?? 0
    // v3 understands physical event.compacted.1 markers. v4 additionally
    // understands sparse sequence holes certified by event_compaction. Sparse
    // reads are compiled in unconditionally, so a v4 DB remains readable if the
    // pruning writer is later disabled. Older binaries fail closed on user_version.
    const target = semantic ? 4 : framingEpoch >= 2 ? 2 : 1
    const maxAllowed = 4
    if (framingEpoch >= 2 && !dedup) {
      throw new Error(
        "OpenCode ChunkDB: this database contains epoch-2 reference framing, but OPENCODE_SEAL_DEDUP is disabled. Refusing to open.",
      )
    }
    if (version === 0 || version < target) {
      yield* db.run(`PRAGMA user_version = ${target}`).pipe(Effect.orDie)
    } else if (version > maxAllowed) {
      throw new Error(
        `OpenCode ChunkDB: database user_version ${version} is newer than this binary supports (max ${maxAllowed}). Refusing to open.`,
      )
    }
  })
}
