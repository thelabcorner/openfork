import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventPayloadChunkTable, EventPayloadMetaTable, EventTable } from "@opencode-ai/core/event/sql"
import { SEMANTIC_HISTORY_EPOCH_KEY } from "@opencode-ai/core/database/chunk-prune"
import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"

/**
 * Tables whose rows are user history or rebuildable projections of that
 * history. Order matters: explicit children come before parents so the reset
 * remains correct even when a supplemental table uses a restrictive FK.
 *
 * This is deliberately an allowlist. A new table must be consciously classified
 * as resettable or preserved instead of silently being destroyed by a broad
 * "delete every table" implementation.
 */
export const RESET_TABLES_IN_ORDER = [
  "fork_message_credential",
  "memory_evidence",
  "memory_anchor",
  "memory_entry",
  "memory_topic",
  "memory_ingest",
  "memory_suppression",
  "goal_automation",
  "goal_focus",
  "goal_evidence",
  "goal_event",
  "goal_step",
  "goal_criterion",
  "goal",
  "session_share",
  "todo",
  "session_context_ops",
  "session_context_state",
  "session_fork_origin",
  "session_context_epoch",
  "session_checkpoint",
  "session_input",
  "session_group_member",
  "part",
  "message",
  "session_message_tool_overlay",
  "session_message_lifecycle",
  "session_message",
  "session_telemetry",
  "usage_record",
  "session",
  "session_group",
  "maintenance_usage",
  "search_backfill",
  "part_search_backfill",
] as const

/**
 * Event/ChunkDB tables need aggregate-scoped deletion instead of blanket
 * truncation. Today every production durable event is session-scoped, but the
 * event layer intentionally supports arbitrary aggregate types. Keeping these
 * separate prevents a future account/project durable stream from being erased
 * by a local-session reset.
 */
export const SESSION_EVENT_TABLES = [
  "event_value_dependency",
  "event_semantic",
  "semantic_entity",
  "semantic_aggregate",
  "event_compaction",
  "event_value",
  "event",
  "event_sequence",
  "event_payload_chunk",
  "event_payload_meta",
  "ocdb_seal",
] as const

/** Setup/state that a history reset must never destroy. */
export const PRESERVED_TABLES = [
  "migration",
  "__drizzle_migrations",
  "data_migration",
  "account",
  "account_state",
  "control_account",
  "credential",
  "device",
  "push_subscription",
  "push_vapid_key",
  "fork_credential",
  "project",
  "project_directory",
  "workspace",
  "permission",
  "ocdb_meta",
] as const

const FTS_TABLES = ["session_message_fts", "part_fts", "memory_entry_fts"] as const

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`

export interface ResetLocalDataResult {
  readonly success: true
  readonly sessionsDeleted: number
  readonly memoriesDeleted: number
  readonly compacted: boolean
}

export const resetLocalData = Effect.fn("ResetLocalData.run")(function* () {
  const { db, filename } = yield* Database.Service
  const existing = new Set(
    (
      yield* db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .pipe(Effect.orDie)
    ).map((row) => row.name),
  )

  const { sessionsDeleted, memoriesDeleted } = yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          // Count under the same serialized writer transaction that performs
          // the deletion. Concurrent reset requests then report exactly what
          // each transaction removed instead of both observing the same
          // pre-lock snapshot and double-reporting deleted rows.
          const sessionsDeleted = existing.has("session")
            ? Number(
                (
                  yield* tx.get<{ count: number }>(
                    `SELECT count(*) AS count FROM ${quoteIdentifier("session")}`,
                  )
                )?.count ?? 0,
              )
            : 0
          const memoriesDeleted = existing.has("memory_entry")
            ? Number(
                (
                  yield* tx.get<{ count: number }>(
                    `SELECT count(*) AS count FROM ${quoteIdentifier("memory_entry")}`,
                  )
                )?.count ?? 0,
              )
            : 0

          // Capture session aggregate identity before deleting the session
          // projection. Also include orphaned durable session aggregates left by
          // an interrupted/older deletion. Session IDs use the branded `ses...`
          // namespace, so future non-session aggregate classes remain intact.
          yield* tx.run(
            "CREATE TEMP TABLE IF NOT EXISTS reset_local_session_aggregate (id TEXT PRIMARY KEY) WITHOUT ROWID",
          )
          yield* tx.run("DELETE FROM reset_local_session_aggregate")
          if (existing.has("session")) {
            yield* tx.run("INSERT OR IGNORE INTO reset_local_session_aggregate(id) SELECT id FROM session")
          }
          if (existing.has("event_sequence")) {
            yield* tx.run(
              "INSERT OR IGNORE INTO reset_local_session_aggregate(id) SELECT aggregate_id FROM event_sequence WHERE aggregate_id LIKE 'ses%'",
            )
          }

          // Jumbo event payloads are content-addressed globally, so they cannot
          // be truncated with the session event tables. Mirror EventV2.remove:
          // decode the tiny payload refs through the normal Drizzle codec,
          // decrement only refs owned by aggregates being reset, and eagerly
          // reclaim a payload only when no durable event still references it.
          if (existing.has("event_payload_meta") && existing.has("event_payload_chunk") && existing.has("event")) {
            const aggregates = yield* tx.all<{ id: string }>("SELECT id FROM reset_local_session_aggregate")
            const payloadRefs = new Map<string, number>()
            const batchSize = 200
            for (let offset = 0; offset < aggregates.length; offset += batchSize) {
              const ids = aggregates.slice(offset, offset + batchSize).map((row) => row.id)
              if (ids.length === 0) continue
              const rows = yield* tx
                .select({ data: EventTable.data })
                .from(EventTable)
                .where(inArray(EventTable.aggregate_id, ids))
                .all()
                .pipe(Effect.orDie)
              for (const row of rows) {
                const ref = row.data?.$eventPayload
                if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue
                const payloadID = (ref as { id?: unknown }).id
                if (typeof payloadID !== "string") continue
                payloadRefs.set(payloadID, (payloadRefs.get(payloadID) ?? 0) + 1)
              }
            }
            for (const [payloadID, count] of payloadRefs) {
              const meta = yield* tx
                .select({ refs: EventPayloadMetaTable.refs })
                .from(EventPayloadMetaTable)
                .where(eq(EventPayloadMetaTable.payload_id, payloadID))
                .get()
                .pipe(Effect.orDie)
              if (!meta) continue
              const refs = Math.max(0, meta.refs - count)
              if (refs === 0) {
                yield* tx
                  .delete(EventPayloadChunkTable)
                  .where(eq(EventPayloadChunkTable.payload_id, payloadID))
                  .run()
                  .pipe(Effect.orDie)
                yield* tx
                  .delete(EventPayloadMetaTable)
                  .where(eq(EventPayloadMetaTable.payload_id, payloadID))
                  .run()
                  .pipe(Effect.orDie)
                continue
              }
              yield* tx
                .update(EventPayloadMetaTable)
                .set({ refs, time_touched: Date.now() })
                .where(eq(EventPayloadMetaTable.payload_id, payloadID))
                .run()
                .pipe(Effect.orDie)
            }
          }

          if (existing.has("ocdb_meta")) {
            yield* tx.run(`
              INSERT INTO ocdb_meta(key, value) VALUES ('${SEMANTIC_HISTORY_EPOCH_KEY}', '1')
              ON CONFLICT(key) DO UPDATE SET
                value = CAST(COALESCE(ocdb_meta.value, '0') AS INTEGER) + 1
            `)
          }

          for (const table of RESET_TABLES_IN_ORDER) {
            if (!existing.has(table)) continue
            yield* tx.run(`DELETE FROM ${quoteIdentifier(table)}`)
          }

          // `ocdb_seal` has no aggregate column, so remove only journal rows
          // whose source event belongs to a reset session before deleting the
          // event rows themselves. Other aggregate classes remain untouched.
          if (existing.has("ocdb_seal") && existing.has("event")) {
            yield* tx.run(`
              DELETE FROM ocdb_seal
              WHERE table_name = 'event'
                AND row_id IN (
                  SELECT event.id
                  FROM event
                  JOIN reset_local_session_aggregate reset
                    ON reset.id = event.aggregate_id
                )
            `)
          }
          if (existing.has("event_value_dependency")) {
            yield* tx.run(
              "DELETE FROM event_value_dependency WHERE aggregate_id IN (SELECT id FROM reset_local_session_aggregate)",
            )
          }
          if (existing.has("event_semantic") && existing.has("semantic_aggregate")) {
            yield* tx.run(`
              DELETE FROM event_semantic
              WHERE aggregate_key IN (
                SELECT aggregate_key FROM semantic_aggregate
                WHERE aggregate_id IN (SELECT id FROM reset_local_session_aggregate)
              )
            `)
          }
          if (existing.has("semantic_entity") && existing.has("semantic_aggregate")) {
            yield* tx.run(`
              DELETE FROM semantic_entity
              WHERE aggregate_key IN (
                SELECT aggregate_key FROM semantic_aggregate
                WHERE aggregate_id IN (SELECT id FROM reset_local_session_aggregate)
              )
            `)
          }
          if (existing.has("semantic_aggregate")) {
            yield* tx.run(
              "DELETE FROM semantic_aggregate WHERE aggregate_id IN (SELECT id FROM reset_local_session_aggregate)",
            )
          }
          for (const table of ["event_compaction", "event_value", "event"] as const) {
            if (!existing.has(table)) continue
            yield* tx.run(
              `DELETE FROM ${quoteIdentifier(table)} WHERE aggregate_id IN (SELECT id FROM reset_local_session_aggregate)`,
            )
          }
          if (existing.has("event_sequence")) {
            yield* tx.run(
              "DELETE FROM event_sequence WHERE aggregate_id IN (SELECT id FROM reset_local_session_aggregate)",
            )
          }
          if (existing.has("ocdb_seal") && existing.has("event")) {
            // Seal rows are a rebuildable audit journal. If their source event
            // is already gone (for example after an interrupted older cleanup),
            // there is no aggregate identity left to classify and no valid
            // reason to preserve the orphan.
            yield* tx.run(`
              DELETE FROM ocdb_seal
              WHERE table_name = 'event'
                AND NOT EXISTS (
                  SELECT 1 FROM event WHERE event.id = ocdb_seal.row_id
                )
            `)
          }
          yield* tx.run("DROP TABLE reset_local_session_aggregate")

          // ChunkDB representation epochs describe the physical database
          // format and must survive. Backfill/prune cursors describe deleted
          // history and must restart from zero on the next maintenance pass.
          if (existing.has("ocdb_meta")) {
            yield* tx.run(
              "DELETE FROM ocdb_meta WHERE key LIKE 'semantic_index_%' OR key LIKE 'semantic_prune_cursor_%' OR key LIKE 'semantic_dependency_%'",
            )
          }

          // External-content FTS normally follows DELETE triggers. Rebuild from
          // the now-empty source tables as a second invariant so an old broken
          // trigger or stale index cannot leave searchable remnants behind.
          for (const table of FTS_TABLES) {
            if (!existing.has(table)) continue
            const name = quoteIdentifier(table)
            yield* tx.run(`INSERT INTO ${name}(${name}) VALUES ('rebuild')`)
          }

          return { sessionsDeleted, memoriesDeleted }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)

  // The ChunkDB rehydration cache is keyed by the long-lived database
  // connection and can otherwise retain decoded payloads after their backing
  // event_value rows are deleted. Drop it immediately so the reset is also a
  // process-memory boundary, not only a SQLite boundary.
  EventV2.resetRehydrateCache(db)

  // DELETE makes the logical state empty. Checkpoint + VACUUM also return the
  // main file/WAL to a compact physical representation. Compaction is best
  // effort because the destructive transaction is already committed and a
  // transient SQLITE_BUSY here must not make the UI claim the reset failed.
  const compacted =
    filename === ":memory:"
      ? true
      : yield* Effect.gen(function* () {
          yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)")
          yield* db.run("VACUUM")
          yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)")
          return true
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("local data reset completed but database compaction failed", { cause }).pipe(
              Effect.as(false),
            ),
          ),
        )

  return {
    success: true as const,
    sessionsDeleted,
    memoriesDeleted,
    compacted,
  }
})

export * as ResetLocalData from "./reset-local-data"
