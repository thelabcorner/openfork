import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import repair from "@opencode-ai/core/database/migration/20260920040500_text_primary_key_not_null_convergence"
import { Effect, Exit } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { sql } from "drizzle-orm"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))

function nullableTextPrimaryKeyFixture() {
  return Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys = ON`)
    yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
    yield* db.run(sql`
      CREATE TABLE session_checkpoint (
        id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        diff text
      )
    `)
    yield* db.run(sql`
      CREATE TABLE session_checkpoint_search (
        checkpoint_id text PRIMARY KEY REFERENCES session_checkpoint(id) ON DELETE CASCADE,
        paths text DEFAULT '' NOT NULL
      )
    `)
    yield* db.run(
      sql.raw(
        "CREATE VIRTUAL TABLE session_checkpoint_search_fts USING fts5(paths, content='session_checkpoint_search', content_rowid='rowid', tokenize='trigram')",
      ),
    )
    yield* db.run(
      sql.raw(
        "CREATE TRIGGER session_checkpoint_search_fts_ai AFTER INSERT ON session_checkpoint_search BEGIN INSERT INTO session_checkpoint_search_fts(rowid, paths) VALUES (new.rowid, new.paths); END",
      ),
    )
    yield* db.run(
      sql.raw(
        "CREATE TRIGGER session_checkpoint_search_fts_ad AFTER DELETE ON session_checkpoint_search BEGIN INSERT INTO session_checkpoint_search_fts(session_checkpoint_search_fts, rowid, paths) VALUES ('delete', old.rowid, old.paths); END",
      ),
    )
    yield* db.run(
      sql.raw(
        "CREATE TRIGGER session_checkpoint_search_fts_au AFTER UPDATE OF paths ON session_checkpoint_search BEGIN INSERT INTO session_checkpoint_search_fts(session_checkpoint_search_fts, rowid, paths) VALUES ('delete', old.rowid, old.paths); INSERT INTO session_checkpoint_search_fts(rowid, paths) VALUES (new.rowid, new.paths); END",
      ),
    )
    yield* db.run(
      sql.raw(
        "CREATE TRIGGER session_checkpoint_search_ai AFTER INSERT ON session_checkpoint BEGIN INSERT INTO session_checkpoint_search (checkpoint_id, paths) VALUES (new.id, 'src/fixture.ts') ON CONFLICT(checkpoint_id) DO UPDATE SET paths=excluded.paths; END",
      ),
    )
    yield* db.run(
      sql.raw(
        "CREATE TRIGGER session_checkpoint_search_au AFTER UPDATE OF diff ON session_checkpoint BEGIN INSERT INTO session_checkpoint_search (checkpoint_id, paths) VALUES (new.id, 'src/fixture.ts') ON CONFLICT(checkpoint_id) DO UPDATE SET paths=excluded.paths; END",
      ),
    )
    yield* db.run(sql`
      CREATE TABLE session_context_ops (
        id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        batch_id text NOT NULL,
        operations text NOT NULL,
        timestamp integer NOT NULL
      )
    `)
    yield* db.run(sql`CREATE INDEX session_context_ops_session_idx ON session_context_ops (session_id)`)
    yield* db.run(sql`CREATE INDEX session_context_ops_session_time_idx ON session_context_ops (session_id, timestamp)`)
    yield* db.run(sql`
      CREATE TABLE session_fork_origin (
        session_id text PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
        parent_session_id text NOT NULL,
        source_message_id text,
        source_seq integer,
        edge text,
        kind text NOT NULL,
        workspace_mode text NOT NULL,
        created_at integer NOT NULL
      )
    `)
    yield* db.run(sql`CREATE INDEX session_fork_origin_parent_idx ON session_fork_origin (parent_session_id)`)
    return db
  })
}

describe("fresh-install window schema repair", () => {
  test("restores explicit TEXT primary-key invariants without losing rows, indexes, FTS, or cascades", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* nullableTextPrimaryKeyFixture()
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_parent'), ('ses_child')`)
        yield* db.run(sql`INSERT INTO session_checkpoint (id, session_id, diff) VALUES ('cp_1', 'ses_child', '[]')`)
        yield* db.run(sql`UPDATE session_checkpoint_search SET paths = 'src/fixture.ts' WHERE checkpoint_id = 'cp_1'`)
        yield* db.run(
          sql`INSERT INTO session_context_ops (id, session_id, batch_id, operations, timestamp) VALUES ('op_1', 'ses_child', 'batch_1', '[]', 1)`,
        )
        yield* db.run(sql`
          INSERT INTO session_fork_origin (
            session_id, parent_session_id, kind, workspace_mode, created_at
          ) VALUES ('ses_child', 'ses_parent', 'manual', 'shared-current', 1)
        `)

        yield* DatabaseMigration.applyOnly(db, [repair])

        for (const [table, column] of [
          ["session_checkpoint_search", "checkpoint_id"],
          ["session_context_ops", "id"],
          ["session_fork_origin", "session_id"],
        ] as const) {
          expect(
            yield* db.get<{ is_not_null: number }>(
              sql.raw(`SELECT "notnull" AS is_not_null FROM pragma_table_info('${table}') WHERE name = '${column}'`),
            ),
          ).toEqual({ is_not_null: 1 })
        }

        expect(yield* db.get(sql`SELECT id, batch_id FROM session_context_ops WHERE id = 'op_1'`)).toEqual({
          id: "op_1",
          batch_id: "batch_1",
        })
        expect(yield* db.get(sql`SELECT session_id, parent_session_id FROM session_fork_origin`)).toEqual({
          session_id: "ses_child",
          parent_session_id: "ses_parent",
        })
        expect(
          yield* db.get(sql.raw("SELECT rowid FROM session_checkpoint_search_fts WHERE paths MATCH 'fixture'")),
        ).toBeDefined()
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])

        yield* db.run(sql`DELETE FROM session_checkpoint WHERE id = 'cp_1'`)
        expect(yield* db.get(sql`SELECT checkpoint_id FROM session_checkpoint_search WHERE checkpoint_id = 'cp_1'`)).toBeUndefined()
        expect(
          yield* db.get(sql.raw("SELECT rowid FROM session_checkpoint_search_fts WHERE paths MATCH 'fixture'")),
        ).toBeUndefined()
      }),
    )
  })

  test("fails closed instead of choosing a value when a divergent TEXT primary key contains NULL", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* nullableTextPrimaryKeyFixture()
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_parent')`)
        yield* db.run(
          sql`INSERT INTO session_context_ops (id, session_id, batch_id, operations, timestamp) VALUES (NULL, 'ses_parent', 'batch_1', '[]', 1)`,
        )
        const exit = yield* Effect.exit(DatabaseMigration.applyOnly(db, [repair]))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("session_context_ops.id NOT NULL primary-key invariant")
      }),
    )
  })
})
