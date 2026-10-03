import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import usageSessionHistoryMigration from "@opencode-ai/core/database/migration/20260924194800_usage_session_history"
import usageSessionTriggerMigration from "@opencode-ai/core/database/migration/20260924195500_usage_session_triggers"
import usageSessionLateSettlementMigration from "@opencode-ai/core/database/migration/20260924203000_usage_session_late_settlement_guard"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("Usage session history migrations", () => {
  test("backfills existing Usage attribution without deleting already-orphaned scalar history", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb

        // Minimal pre-migration shape required by the Usage history migrations.
        yield* db.run(sql`
          CREATE TABLE project (
            id text PRIMARY KEY,
            name text
          )
        `)
        yield* db.run(sql`
          CREATE TABLE session (
            id text PRIMARY KEY,
            project_id text NOT NULL,
            directory text NOT NULL,
            title text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE usage_record (
            message_id text PRIMARY KEY,
            session_id text NOT NULL,
            completed_at integer NOT NULL
          )
        `)

        yield* db.run(sql`INSERT INTO project (id, name) VALUES ('p-existing', 'Existing Project')`)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
          VALUES ('s-existing', 'p-existing', '/existing', 'Existing Session', 100, 200)
        `)
        yield* db.run(sql`
          INSERT INTO usage_record (message_id, session_id, completed_at)
          VALUES
            ('m-existing-1', 's-existing', 500),
            ('m-existing-2', 's-existing', 700),
            ('m-orphan', 's-already-deleted', 600)
        `)

        yield* DatabaseMigration.applyOnly(db, [
          usageSessionHistoryMigration,
          usageSessionTriggerMigration,
          usageSessionLateSettlementMigration,
        ])

        expect(yield* db.all(sql`
          SELECT
            session_id,
            project_id,
            directory,
            title,
            project_name,
            session_created_at,
            session_updated_at,
            last_usage_at
          FROM usage_session
          ORDER BY session_id
        `)).toEqual([
          {
            session_id: "s-existing",
            project_id: "p-existing",
            directory: "/existing",
            title: "Existing Session",
            project_name: "Existing Project",
            session_created_at: 100,
            session_updated_at: 200,
            last_usage_at: 700,
          },
        ])

        // A previously deleted Session cannot have metadata reconstructed, but
        // the scalar usage row itself must remain intact for the global fallback.
        expect(yield* db.all(sql`
          SELECT message_id, session_id, completed_at
          FROM usage_record
          ORDER BY message_id
        `)).toEqual([
          { message_id: "m-existing-1", session_id: "s-existing", completed_at: 500 },
          { message_id: "m-existing-2", session_id: "s-existing", completed_at: 700 },
          { message_id: "m-orphan", session_id: "s-already-deleted", completed_at: 600 },
        ])
      }),
    )
  })

  test("captures a deletion tombstone before the first post-migration settlement", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY, name text)`)
        yield* db.run(sql`
          CREATE TABLE session (
            id text PRIMARY KEY,
            project_id text NOT NULL,
            directory text NOT NULL,
            title text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE usage_record (
            message_id text PRIMARY KEY,
            session_id text NOT NULL,
            completed_at integer NOT NULL
          )
        `)
        yield* db.run(sql`INSERT INTO project (id, name) VALUES ('p-late', 'Late Project')`)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
          VALUES ('s-late', 'p-late', '/late', 'Late Session', 10, 20)
        `)

        yield* DatabaseMigration.applyOnly(db, [
          usageSessionHistoryMigration,
          usageSessionTriggerMigration,
          usageSessionLateSettlementMigration,
        ])

        yield* db.run(sql`DELETE FROM session WHERE id = 's-late'`)
        expect(yield* db.get(sql`
          SELECT project_id, directory, title, project_name, last_usage_at
          FROM usage_session
          WHERE session_id = 's-late'
        `)).toEqual({
          project_id: "p-late",
          directory: "/late",
          title: "Late Session",
          project_name: "Late Project",
          last_usage_at: 0,
        })

        yield* db.run(sql`
          INSERT INTO usage_record (message_id, session_id, completed_at)
          VALUES ('m-late', 's-late', 900)
        `)
        expect(yield* db.get(sql`
          SELECT project_id, directory, title, project_name, last_usage_at
          FROM usage_session
          WHERE session_id = 's-late'
        `)).toEqual({
          project_id: "p-late",
          directory: "/late",
          title: "Late Session",
          project_name: "Late Project",
          last_usage_at: 900,
        })
      }),
    )
  })
})
