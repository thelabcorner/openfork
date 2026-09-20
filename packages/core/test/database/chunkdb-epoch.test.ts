import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { DatabaseMigration } from "../../src/database/migration"
import { CHUNKDB_MAX_USER_VERSION, ensureChunkDB } from "../../src/database/chunkdb"

const tracked = [
  "OPENCODE_SEAL_ENABLED",
  "OPENCODE_SEAL_DEDUP",
  "OPENCODE_SEAL_PRUNE",
  "OPENCODE_SEAL_DELTA",
] as const
const previous = Object.fromEntries(tracked.map((key) => [key, process.env[key]])) as Record<
  (typeof tracked)[number],
  string | undefined
>

afterEach(() => {
  for (const key of tracked) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()

describe("ChunkDB durable capability epoch", () => {
  test("reference-capable databases are fenced at epoch 5 even when delta writes are disabled", async () => {
    process.env.OPENCODE_SEAL_ENABLED = "1"
    process.env.OPENCODE_SEAL_DEDUP = "1"
    process.env.OPENCODE_SEAL_PRUNE = "0"
    process.env.OPENCODE_SEAL_DELTA = "0"

    expect(CHUNKDB_MAX_USER_VERSION).toBe(5)
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDatabase
        yield* DatabaseMigration.apply(db)
        yield* ensureChunkDB(db)
        const fresh = yield* db.get<{ user_version: number }>(sql`PRAGMA user_version`).pipe(Effect.orDie)
        expect(fresh?.user_version).toBe(5)

        // Regression for databases produced before the v5 fence existed:
        // delta_ref was able to persist while reference-capable DBs still
        // advertised epoch 2. A current open must monotonically close that
        // downgrade hole without scanning event_value.
        yield* db.run(sql`PRAGMA user_version = 2`).pipe(Effect.orDie)
        yield* ensureChunkDB(db)
        const upgraded = yield* db.get<{ user_version: number }>(sql`PRAGMA user_version`).pipe(Effect.orDie)
        expect(upgraded?.user_version).toBe(5)
      }).pipe(
        Effect.provide(
          sqliteLayer({
            filename: ":memory:",
            createTimePragmas: { page_size: 8192, auto_vacuum: 2 },
          }),
        ),
      ),
    )
  })

  test("framing-only databases do not pay the reference capability fence", async () => {
    process.env.OPENCODE_SEAL_ENABLED = "1"
    process.env.OPENCODE_SEAL_DEDUP = "0"
    process.env.OPENCODE_SEAL_PRUNE = "0"
    process.env.OPENCODE_SEAL_DELTA = "0"

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDatabase
        yield* DatabaseMigration.apply(db)
        yield* ensureChunkDB(db)
        const epoch = yield* db.get<{ user_version: number }>(sql`PRAGMA user_version`).pipe(Effect.orDie)
        expect(epoch?.user_version).toBe(1)
      }).pipe(
        Effect.provide(
          sqliteLayer({
            filename: ":memory:",
            createTimePragmas: { page_size: 8192, auto_vacuum: 2 },
          }),
        ),
      ),
    )
  })
})
