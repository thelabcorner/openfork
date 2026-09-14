import { sqliteTable, text, integer, index, uniqueIndex, blob, primaryKey } from "drizzle-orm/sqlite-core"
import type { EventV2 } from "../event"
import { compressedJson } from "../database/json-codec"

export const EventSequenceTable = sqliteTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: integer().notNull(),
  owner_id: text(),
})

export const EventTable = sqliteTable(
  "event",
  {
    id: text().$type<EventV2.ID>().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    type: text().notNull(),
    data: compressedJson().$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    index("event_aggregate_type_seq_idx").on(table.aggregate_id, table.type, table.seq),
  ],
)

/**
 * One tiny lifecycle row per content-addressed jumbo event payload.
 *
 * `refs` counts committed semantic event rows, while `time_touched` protects a
 * payload that is currently being (re)staged by another process. Chunk rows
 * stay separate so the final semantic transaction only updates this small row.
 */
export const EventPayloadMetaTable = sqliteTable(
  "event_payload_meta",
  {
    payload_id: text().notNull().primaryKey(),
    chunk_count: integer().notNull(),
    refs: integer().notNull().default(0),
    time_touched: integer().notNull(),
  },
  (table) => [index("event_payload_meta_orphan_idx").on(table.refs, table.time_touched)],
)

/**
 * Pre-committed storage for jumbo durable-event payloads.
 *
 * Chunks intentionally do not FK to `event`: they are staged cooperatively
 * before the semantic event transaction exists. The final event row stores a
 * content-addressed payload reference. A crash between staging and commit can
 * therefore leave an unreachable chunk set, but can never expose a partial
 * durable event. Content addressing also makes concurrent/idempotent staging
 * safe across hosts.
 */
export const EventPayloadChunkTable = sqliteTable(
  "event_payload_chunk",
  {
    payload_id: text().notNull(),
    chunk_index: integer().notNull(),
    text: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.payload_id, table.chunk_index] }),
    index("event_payload_chunk_time_created_idx").on(table.time_created),
  ],
)

/**
 * Epoch-2 ChunkDB externalized payload table (schema owned by schema-v2; this
 * drizzle definition is the read-side handle used by the rehydration path).
 * `bytes` is a BLOB holding either a raw JSON UTF-8 payload or an OCDB v2 frame
 * (see json-codec.decodeValueBytes). `value_id` is the promoting event's
 * `(aggregate_id, seq)`-derived key; `sha256` dedups identical payloads within
 * an aggregate so repeats collapse to one row.
 */
export const EventValueTable = sqliteTable(
  "event_value",
  {
    aggregate_id: text().notNull(),
    value_id: text().notNull(),
    sha256: text().notNull(),
    raw_len: integer().notNull(),
    bytes: blob().notNull(),
    refs: integer().notNull().default(1),
    time_promoted: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.aggregate_id, table.value_id] }),
    uniqueIndex("event_value_agg_sha_idx").on(table.aggregate_id, table.sha256),
  ],
)
