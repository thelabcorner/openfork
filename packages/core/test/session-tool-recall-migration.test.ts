import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import toolRecallMigration from "@opencode-ai/core/database/migration/20261007192518_session_tool_recall_projection"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("Session tool recall migration", () => {
  test("reconciles the predecessor one-column FTS shape without losing sidecar rows", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb

        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE part (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_message (id text PRIMARY KEY)`)
        yield* db.run(sql`
          CREATE TABLE session_tool_recall (
            id integer PRIMARY KEY AUTOINCREMENT,
            source text NOT NULL,
            session_id text NOT NULL,
            message_id text NOT NULL,
            part_id text NOT NULL,
            tool text NOT NULL,
            time_created integer NOT NULL,
            search_text text NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE session_tool_recall_backfill (
            source text PRIMARY KEY,
            watermark_rowid integer DEFAULT -1 NOT NULL,
            done integer DEFAULT 0 NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE VIRTUAL TABLE session_tool_recall_fts USING fts5(
            search_text,
            content='session_tool_recall',
            content_rowid='id',
            tokenize='unicode61'
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_recall
            (source, session_id, message_id, part_id, tool, time_created, search_text)
          VALUES ('v2_message', 'ses_test', 'msg_test', 'call_test', 'read', 7, '{"path":"AGENTS.md"}')
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_recall_fts(rowid, search_text)
          SELECT id, search_text FROM session_tool_recall
        `)

        yield* db.transaction((tx) => toolRecallMigration.reconcile!(tx))

        expect(
          yield* db.all<{ name: string }>(
            sql`SELECT name FROM pragma_table_info('session_tool_recall_fts') ORDER BY cid`,
          ),
        ).toEqual([{ name: "tool" }, { name: "search_text" }])

        expect(
          yield* db.get<{ tool: string; searchText: string }>(sql`
            SELECT tool, search_text AS searchText
            FROM session_tool_recall
            WHERE part_id = 'call_test'
          `),
        ).toEqual({ tool: "read", searchText: '{"path":"AGENTS.md"}' })

        expect(
          yield* db.get<{ count: number }>(sql`
            SELECT count(*) AS count
            FROM session_tool_recall_fts
            WHERE session_tool_recall_fts MATCH '{tool} : (read*) AND {search_text} : (AGENTS*)'
          `),
        ).toEqual({ count: 1 })

        // Reconcile is a startup path; once the shape is current it must be
        // idempotent and preserve indexed content rather than rebuilding again.
        yield* db.transaction((tx) => toolRecallMigration.reconcile!(tx))
        expect(
          yield* db.get<{ count: number }>(sql`
            SELECT count(*) AS count
            FROM session_tool_recall_fts
            WHERE session_tool_recall_fts MATCH '{tool} : (read*) AND {search_text} : (AGENTS*)'
          `),
        ).toEqual({ count: 1 })
      }),
    )
  })
})
