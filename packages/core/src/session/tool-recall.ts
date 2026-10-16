export * as SessionToolRecall from "./tool-recall"

import { and, eq, ne, or, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import type { Database } from "../database/database"
import type { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { toolRecallSearchText } from "./search-text"
import { PartTable, SessionMessageTable, SessionToolRecallTable } from "./sql"

export type Source = "v1_part" | "v2_message"

type DatabaseService = Database.Interface["db"]
type WriteDatabase = Pick<DatabaseService, "insert" | "delete" | "run">
const HistoricalInsertChunk = 128

export type Row = {
  readonly source: Source
  readonly session_id: SessionSchema.ID
  readonly message_id: string
  readonly part_id: string
  readonly tool: string
  readonly time_created: number
  readonly search_text: string
}

type V1RecallPart = {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly messageID: string
  readonly type: string
  readonly tool?: string
  readonly state?: { readonly input?: unknown; readonly metadata?: unknown }
}

export function fromV1Part(part: V1RecallPart, timeCreated: number): Row | undefined {
  if (part.type !== "tool" || typeof part.tool !== "string" || !part.state || !("input" in part.state)) return
  return {
    source: "v1_part",
    session_id: part.sessionID,
    message_id: String(part.messageID),
    part_id: String(part.id),
    tool: part.tool,
    time_created: timeCreated,
    search_text: toolRecallSearchText(part.tool, part.state.input, part.state.metadata),
  }
}

export function fromV2Message(sessionID: SessionSchema.ID, message: SessionMessage.Message): Row[] {
  if (message.type !== "assistant") return []
  const rows: Row[] = []
  for (const part of message.content) {
    if (part.type !== "tool") continue
    rows.push({
      source: "v2_message",
      session_id: sessionID,
      message_id: String(message.id),
      part_id: part.id,
      tool: part.name,
      time_created: DateTime.toEpochMillis(part.time.created),
      search_text: toolRecallSearchText(part.name, part.state.input),
    })
  }
  return rows
}

export function upsert(db: WriteDatabase, row: Row) {
  return db
    .insert(SessionToolRecallTable)
    .values(row)
    .onConflictDoUpdate({
      target: [
        SessionToolRecallTable.source,
        SessionToolRecallTable.message_id,
        SessionToolRecallTable.part_id,
      ],
      set: {
        session_id: row.session_id,
        tool: row.tool,
        time_created: row.time_created,
        search_text: row.search_text,
      },
      // V1 ToolParts are republished as running/progress/completed state
      // changes. Those mutations do not usually change recall identity/input;
      // suppress the no-op UPDATE so the FTS update trigger also stays quiet.
      setWhere: or(
        ne(SessionToolRecallTable.session_id, row.session_id),
        ne(SessionToolRecallTable.tool, row.tool),
        ne(SessionToolRecallTable.time_created, row.time_created),
        ne(SessionToolRecallTable.search_text, row.search_text),
      ),
    })
    .run()
}

/**
 * V2 authoritative producer projection. Tool.Called already owns the exact
 * structural identity and bounded input source, so this write never reads the
 * assistant row or resolves an OPCL/CDB payload.
 */
export function projectV2Call(
  db: DatabaseService,
  event: SessionEvent.Tool.Called,
) {
  return upsert(db, {
    source: "v2_message",
    session_id: event.data.sessionID,
    message_id: String(event.data.assistantMessageID),
    part_id: event.data.callID,
    tool: event.data.tool,
    time_created: DateTime.toEpochMillis(event.data.timestamp),
    search_text: toolRecallSearchText(event.data.tool, event.data.input),
  })
}

/**
 * V1 authoritative producer projection. A PartUpdated event already contains
 * the decoded part, so exact tool identity is projected before storage rather
 * than reconstructed by a future reader.
 */
export function projectV1Part(
  db: WriteDatabase,
  part: V1RecallPart,
  timeCreated: number,
) {
  const row = fromV1Part(part, timeCreated)
  if (row) return upsert(db, row)
  // Defensive cleanup for an id-preserving part type replacement.
  return db
    .delete(SessionToolRecallTable)
    .where(
      and(
        eq(SessionToolRecallTable.source, "v1_part"),
        eq(SessionToolRecallTable.part_id, String(part.id)),
      ),
    )
    .run()
}

/**
 * Historical backfill insert. Producer-side projection wins races: if a live
 * event already materialized the identity, never overwrite it with an older
 * snapshot captured before the repair transaction began.
 */
export function insertHistoricalRowsIfAbsent(db: WriteDatabase, rows: readonly Row[]) {
  if (rows.length === 0) return Effect.void

  // A parent can disappear or be type-replaced after the cold snapshot was
  // decoded but before this transaction obtains its write lock. Re-check the
  // narrow authoritative source in the INSERT itself. That closes the race
  // without N existence reads; producer rows still win the unique conflict.
  const insert = (source: Source, sourceRows: readonly Row[]) => {
    if (sourceRows.length === 0) return Effect.void
    const values = sql.join(
      sourceRows.map((row) => sql`(
        ${row.session_id},
        ${row.message_id},
        ${row.part_id},
        ${row.tool},
        ${row.time_created},
        ${row.search_text}
      )`),
      sql`,`,
    )
    const candidates = sql`candidate(session_id, message_id, part_id, tool, time_created, search_text) AS (VALUES ${values})`
    if (source === "v1_part") {
      return db.run(sql`
        WITH ${candidates}
        INSERT OR IGNORE INTO ${SessionToolRecallTable} (
          source, session_id, message_id, part_id, tool, time_created, search_text
        )
        SELECT
          'v1_part', c.session_id, c.message_id, c.part_id, c.tool, c.time_created, c.search_text
        FROM candidate c
        JOIN ${PartTable} p
          ON p.id = c.part_id
         AND p.message_id = c.message_id
         AND p.session_id = c.session_id
         WHERE CASE
           WHEN p.context_projection_version = 1 THEN
             p.context_kind = 'tool' AND p.context_preview = c.tool
           ELSE (
             json_extract(p.data, '$.type') = 'tool'
             AND json_extract(p.data, '$.tool') = c.tool
           ) OR (
             json_type(p.data, '$."$cdbRef"') IS NOT NULL
             AND instr(' ' || p.search_text || ' ', ' tool:' || c.tool || ' ') > 0
           )
         END
      `)
    }
    return db.run(sql`
      WITH ${candidates}
      INSERT OR IGNORE INTO ${SessionToolRecallTable} (
        source, session_id, message_id, part_id, tool, time_created, search_text
      )
      SELECT
        'v2_message', c.session_id, c.message_id, c.part_id, c.tool, c.time_created, c.search_text
      FROM candidate c
      JOIN ${SessionMessageTable} m
        ON m.id = c.message_id
       AND m.session_id = c.session_id
      WHERE m.type = 'assistant'
        AND (
          (
            json_type(m.data, '$.content') = 'array'
            AND EXISTS (
              SELECT 1
              FROM json_each(m.data, '$.content') part
              WHERE json_extract(part.value, '$.type') = 'tool'
                AND json_extract(part.value, '$.id') = c.part_id
                AND json_extract(part.value, '$.name') = c.tool
            )
          )
          OR (
            json_type(m.data, '$."$cdbRef"') IS NOT NULL
            AND instr(' ' || m.search_text || ' ', ' tool:' || c.tool || ' ') > 0
          )
        )
    `)
  }

  const v1 = rows.filter((row) => row.source === "v1_part")
  const v2 = rows.filter((row) => row.source === "v2_message")
  const insertChunks = (source: Source, sourceRows: readonly Row[]) =>
    Effect.forEach(
      Array.from({ length: Math.ceil(sourceRows.length / HistoricalInsertChunk) }, (_, index) =>
        sourceRows.slice(index * HistoricalInsertChunk, (index + 1) * HistoricalInsertChunk),
      ),
      (chunk) => insert(source, chunk),
      { discard: true, concurrency: 1 },
    )
  return Effect.all([insertChunks("v1_part", v1), insertChunks("v2_message", v2)], {
    discard: true,
    concurrency: 1,
  })
}
