import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "../../src/database/sqlite.bun"
import { DatabaseMigration } from "../../src/database/migration"
import { ensureChunkDB } from "../../src/database/chunkdb"
import { pruneSealJournal, SEAL_JOURNAL_PRUNE_PAGE_SIZE } from "../../src/database/chunk-sealer"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()

test("seal journal pruning has a bounded writer page, durable cursor, and never deletes fresh audit rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-seal-journal-page-"))
  const filename = join(directory, "journal.sqlite")
  const previous = process.env.OPENCODE_SEAL_ENABLED
  process.env.OPENCODE_SEAL_ENABLED = "1"
  try {
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase
        yield* DatabaseMigration.apply(db)
        yield* ensureChunkDB(db)
        for (let i = 0; i < 600; i++) {
          yield* db.run(sql`
            INSERT INTO ocdb_seal (
              table_name, row_id, column_name, raw_bytes, stored_bytes,
              codec, frame_version, time_sealed, reseal_needed
            ) VALUES ('event', ${`expired-${i}`}, 'data', 40, 20, 2, 3, 1, 0)
          `)
        }
        yield* db.run(sql`
          INSERT INTO ocdb_seal (
            table_name, row_id, column_name, raw_bytes, stored_bytes,
            codec, frame_version, time_sealed, reseal_needed
          ) VALUES ('event', 'fresh', 'data', 40, 20, 2, 3, ${Date.now()}, 0)
        `)
        yield* pruneSealJournal(db)
        const stats = yield* db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM ocdb_seal WHERE time_sealed = 1`,
        )
        expect(stats?.n).toBe(600 - SEAL_JOURNAL_PRUNE_PAGE_SIZE)
        const cursor = yield* db.get<{ value: string }>(
          sql`SELECT value FROM ocdb_meta WHERE key = 'seal_journal_prune_rowid_v1'`,
        )
        expect(Number(cursor?.value)).toBe(SEAL_JOURNAL_PRUNE_PAGE_SIZE)
      }).pipe(Effect.provide(sqliteLayer({ filename, checkpointOnClose: false }))),
    ))
    // Reopen from disk: the cursor must not depend on a per-process map.
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase
        yield* pruneSealJournal(db)
        const old = yield* db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM ocdb_seal WHERE time_sealed = 1`,
        )
        expect(old?.n).toBe(600 - SEAL_JOURNAL_PRUNE_PAGE_SIZE * 2)
        yield* pruneSealJournal(db)
        const after = yield* db.get<{ old: number; fresh: number }>(sql`
          SELECT
            sum(CASE WHEN time_sealed = 1 THEN 1 ELSE 0 END) AS old,
            sum(CASE WHEN row_id = 'fresh' THEN 1 ELSE 0 END) AS fresh
          FROM ocdb_seal
        `)
        expect(after).toEqual({ old: 0, fresh: 1 })
        yield* pruneSealJournal(db)
        yield* pruneSealJournal(db)
        const alive = yield* db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM ocdb_seal WHERE row_id = 'fresh'`,
        )
        expect(alive?.n).toBe(1)

        // Model a competing process advancing the durable cursor while this
        // pass is paused AFTER its candidate read but BEFORE BEGIN IMMEDIATE.
        // A stale pass may delete a still-expired row, but must not rewind
        // another maintenance owner's committed scanning progress.
        yield* db.run(sql`
          INSERT INTO ocdb_seal (
            table_name, row_id, column_name, raw_bytes, stored_bytes,
            codec, frame_version, time_sealed, reseal_needed
          ) VALUES ('event', 'late-expired', 'data', 40, 20, 2, 3, 1, 0)
        `)
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const gate = {
          wait: Effect.fnUntraced(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
        }
        const stale = yield* pruneSealJournal(db, gate).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* db.run(sql`
          UPDATE ocdb_meta SET value = '9999'
          WHERE key = 'seal_journal_prune_rowid_v1'
        `)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(stale)
        const guarded = yield* db.get<{ value: string }>(
          sql`SELECT value FROM ocdb_meta WHERE key = 'seal_journal_prune_rowid_v1'`,
        )
        expect(guarded?.value).toBe("9999")
        const retained = yield* db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM ocdb_seal WHERE row_id = 'fresh'`,
        )
        expect(retained?.n).toBe(1)
      }).pipe(Effect.provide(sqliteLayer({ filename, checkpointOnClose: false }))),
    ))
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_SEAL_ENABLED
    else process.env.OPENCODE_SEAL_ENABLED = previous
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
}, 30_000)
