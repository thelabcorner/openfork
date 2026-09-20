import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import cleanup from "@opencode-ai/core/database/migration/20260920041939_retire_orphan_tool_call"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped) as Effect.Effect<
      A,
      E,
      never
    >,
  )

const abandonedToolCall = sql.raw(
  "CREATE TABLE tool_call (" +
    "id TEXT PRIMARY KEY, " +
    "session_id TEXT REFERENCES session(id), " +
    "message_id TEXT REFERENCES message(id), " +
    "tool_name TEXT NOT NULL, " +
    "args_json TEXT, " +
    "status TEXT CHECK(status IN ('success','error')), " +
    "error_message TEXT, " +
    "token_input INTEGER DEFAULT 0, " +
    "token_output INTEGER DEFAULT 0, " +
    "duration_ms INTEGER DEFAULT 0, " +
    "time_created INTEGER NOT NULL DEFAULT (unixepoch()))",
)

function fixture() {
  return Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql.raw("PRAGMA foreign_keys = ON"))
    yield* db.run(sql.raw("CREATE TABLE session (id TEXT PRIMARY KEY)"))
    yield* db.run(sql.raw("CREATE TABLE message (id TEXT PRIMARY KEY)"))
    yield* db.run(abandonedToolCall)
    return db
  })
}

describe("orphan schema cleanup", () => {
  test("retires the exact empty abandoned tool_call audit table", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* fixture()
        yield* DatabaseMigration.applyOnly(db, [cleanup])
        expect(
          yield* db.get(sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_call'")),
        ).toBeUndefined()
      }),
    )
  })

  test("fails closed when the abandoned table contains data", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* fixture()
        yield* db.run(sql.raw("INSERT INTO tool_call (id, tool_name) VALUES ('call_1', 'read')"))
        const exit = yield* Effect.exit(DatabaseMigration.applyOnly(db, [cleanup]))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("expected abandoned audit table to be empty")
        expect(yield* db.get(sql.raw("SELECT id, tool_name FROM tool_call"))).toEqual({
          id: "call_1",
          tool_name: "read",
        })
      }),
    )
  })

  test("fails closed when a different owner has reused the table name", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql.raw("CREATE TABLE tool_call (id TEXT PRIMARY KEY, owner TEXT)"))
        const exit = yield* Effect.exit(DatabaseMigration.applyOnly(db, [cleanup]))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("unexpected column shape")
        expect(
          yield* db.get(sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_call'")),
        ).toEqual({ name: "tool_call" })
      }),
    )
  })
})
