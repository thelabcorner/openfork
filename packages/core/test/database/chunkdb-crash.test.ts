/**
 * ChunkDB crash-recovery stress tests — investigate-v4's race_harden gate.
 *
 * Simulates process death at every point of the promotion pipeline and proves
 * the sealer's crash-consistency contract:
 *   1. ATOMICITY — a batch transaction that fails mid-way leaves ZERO partial
 *      rows (no dangling `$cdbRef`, no orphan event_value rows).
 *   2. IDEMPOTENT RESTART — re-running the pass after a crash (worst case:
 *      nothing committed) converges to the exact clean-run state.
 *   3. PARTIAL CRASH — a crash between batches (some committed, some not)
 *      converges to the exact clean-run state on restart.
 *   4. PROCESS RESTART — real file: state written by one connection is visible
 *      to a fresh connection and a re-run is a no-op (committed batches are
 *      durable via SQLite WAL; test 1 proves batch atomicity).
 *   5. FAIL-CLOSED — a dangling `$cdbRef` (corruption) surfaces
 *      CdbRehydrateError, never garbage.
 *
 * Uses the real schema + migrations (ensureChunkDB) but WITHOUT the forked
 * sealer loop, so the test drives runPassV2 directly (same pattern as
 * bench-chunkdb.ts). Workers are off for determinism.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deepStrictEqual } from "node:assert"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Database as CoreDatabase, Service as DatabaseService } from "../../src/database/database"
import type { DatabaseShape } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import { ensureChunkDB } from "../../src/database/chunkdb"
import { runPassV2 } from "../../src/database/chunk-sealer"
import { rehydrateEvents, CdbRehydrateError } from "../../src/event"
import { EventV2 } from "../../src/event"
import { Event } from "@opencode-ai/schema/event"
import { EventTable, EventSequenceTable } from "../../src/event/sql"
import { sql } from "drizzle-orm"

// Real schema + migrations, but NO forked sealer loop (same as the bench) so the
// test can drive runPassV2 directly without racing the loop's immediate pass.
process.env.OPENCODE_SEAL_ENABLED = "1"
process.env.OPENCODE_SEAL_DEDUP = "1"
process.env.OPENCODE_SEAL_WORKERS = "0" // deterministic: sync compress in tests

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
const crashLayer = (filename: string) =>
  Layer.effect(
    DatabaseService,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      yield* ensureChunkDB(db)
      return { db, filename }
    }).pipe(Effect.orDie),
  ).pipe(
    Layer.provide(
      sqliteLayer({
        filename,
        createTimePragmas: { page_size: 8192, auto_vacuum: 2 },
      }),
    ),
  )

function runWith<T>(path: string, body: (db: DatabaseShape) => Effect.Effect<T, unknown, never>): Promise<T> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DatabaseService
      return yield* body(db)
    }).pipe(Effect.provide(crashLayer(path))),
  )
}

// A layer WITHOUT ensureChunkDB and WITHOUT create-time pragmas — simulates a DB
// created before the ChunkDB feature existed (no ocdb_seal/event_value, no
// page_size/auto_vacuum tuning).
const plainLayer = (filename: string) =>
  Layer.effect(
    DatabaseService,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      return { db, filename }
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(sqliteLayer({ filename })))

function runPlain<T>(path: string, body: (db: DatabaseShape) => Effect.Effect<T, unknown, never>): Promise<T> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DatabaseService
      return yield* body(db)
    }).pipe(Effect.provide(plainLayer(path))),
  )
}

// ~18KB repetitive JSON payload (clears the 4096-char candidate filter; 6 per
// aggregate clears the 64KiB externalization gate).
function makePayload(seed: number) {
  const unit = "The quick brown fox jumps over the lazy dog. ".repeat(12)
  return {
    type: "session-message",
    sessionID: `sess_crash_${seed % 2}`,
    index: seed,
    content: Array.from({ length: 32 }, (_, i) => ({ role: "user", i, text: unit })),
  }
}

const ChunkEvent = EventV2.define({
  type: "test.crash",
  durable: { version: 1, aggregate: "aggregateID" },
  schema: { aggregateID: Schema.String, payload: Schema.Unknown },
})

const crashManifest = {
  definitions: Event.durable([ChunkEvent]),
  schema: ChunkEvent,
}

// Two aggregates, 6 events each; within each aggregate events 2-3 duplicate
// event 1's payload (dedup collapse) and events 5-6 duplicate event 4's.
function makeEvents() {
  const events: Array<{ id: string; agg: string; seq: number; data: Record<string, unknown> }> = []
  for (const agg of ["agg_a", "agg_b"]) {
    for (let seq = 1; seq <= 6; seq++) {
      const payload = seq <= 3 ? makePayload(1) : makePayload(4)
      events.push({ id: `${agg}:${seq}`, agg, seq, data: { aggregateID: agg, payload } })
    }
  }
  return events
}

const seed = (db: DatabaseShape, events: ReturnType<typeof makeEvents>) =>
  Effect.gen(function* () {
    const aggSeq = new Map<string, number>()
    for (const e of events) aggSeq.set(e.agg, Math.max(aggSeq.get(e.agg) ?? 0, e.seq))
    yield* db.insert(EventSequenceTable).values(
      Array.from(aggSeq, ([aggregate_id, seq]) => ({ aggregate_id, seq, owner_id: null })),
    ).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* db.insert(EventTable).values(
      events.map((e) => ({ id: e.id as never, aggregate_id: e.agg, seq: e.seq, type: "test.crash", data: e.data })),
    ).run().pipe(Effect.orDie)
  })

const snapshot = (db: DatabaseShape) =>
  Effect.gen(function* () {
    const valueRows = yield* db.all<{ c: number }>(sql`SELECT COUNT(*) as c FROM event_value`).pipe(Effect.orDie)
    const refs = yield* db.all<{ s: number }>(sql`SELECT COALESCE(SUM(refs), 0) as s FROM event_value`).pipe(Effect.orDie)
    const sealRows = yield* db.all<{ c: number }>(sql`SELECT COUNT(*) as c FROM ocdb_seal`).pipe(Effect.orDie)
    return { valueRows: valueRows[0]?.c ?? 0, refs: refs[0]?.s ?? 0, sealRows: sealRows[0]?.c ?? 0 }
  })

const verifyByteExact = (db: DatabaseShape, events: ReturnType<typeof makeEvents>) =>
  Effect.gen(function* () {
    for (const agg of ["agg_a", "agg_b"]) {
      const rows = yield* db.select().from(EventTable).where(sql`aggregate_id = ${agg}`).all().pipe(Effect.orDie)
      const hydrated = yield* rehydrateEvents(db, agg, rows as never)
      for (let i = 0; i < rows.length; i++) {
        const orig = events.find((e) => e.id === (rows[i] as { id: string }).id)!
        deepStrictEqual((hydrated[i] as { data: unknown }).data, orig.data)
      }
    }
  })

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "chunkdb-crash-"))
  return { dir, path: join(dir, "crash.sqlite") }
}

describe("ChunkDB crash recovery", () => {
  test("ATOMICITY: a batch transaction that fails mid-way leaves zero partial rows", async () => {
    const { dir, path } = tmpDb()
    try {
      await runWith(path, (db) =>
        Effect.gen(function* () {
          const events = makeEvents()
          yield* seed(db, events)

          // Poison: pre-insert an event_value row with the SAME (aggregate_id,
          // value_id) the sealer will use for the first candidate (agg:seq) but a
          // DIFFERENT sha256, so the dedup lookup misses it and the batch's
          // INSERT violates PRIMARY KEY (aggregate_id, value_id) mid-transaction.
          yield* db.run(sql`
            INSERT INTO event_value (aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)
            VALUES ('agg_a', 'agg_a:1', ${"0".repeat(64)}, 1, X'00', 1, 0)
          `).pipe(Effect.orDie)

          const outcome = yield* runPassV2(db).pipe(Effect.exit)
          expect(outcome._tag).toBe("Failure") // the batch transaction failed

          // The whole batch rolled back: no refs, no journal rows, no orphans.
          const refs = yield* db.all<{ c: number }>(sql`SELECT COUNT(*) as c FROM event WHERE data LIKE '{"$cdbRef"%'`).pipe(Effect.orDie)
          expect(refs[0]?.c ?? 0).toBe(0)
          const seals = yield* db.all<{ c: number }>(sql`SELECT COUNT(*) as c FROM ocdb_seal`).pipe(Effect.orDie)
          expect(seals[0]?.c ?? 0).toBe(0)
          const values = yield* db.all<{ c: number }>(sql`SELECT COUNT(*) as c FROM event_value`).pipe(Effect.orDie)
          expect(values[0]?.c ?? 0).toBe(1) // only the poison row

          // Remove the poison and re-run: converges to the clean state.
          yield* db.run(sql`DELETE FROM event_value WHERE value_id = 'agg_a:1'`).pipe(Effect.orDie)
          const clean = yield* runPassV2(db).pipe(Effect.exit)
          expect(clean._tag).toBe("Success")
          if (clean._tag === "Success") expect(clean.value.promoted).toBeGreaterThan(0)
          yield* verifyByteExact(db, events)
        }),
      )
    } finally {
      // Windows keeps the DB file locked while the layer is open; best-effort.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  test("IDEMPOTENT RESTART: crash before ANY batch committed converges to the clean-run state", async () => {
    const { dir, path } = tmpDb()
    try {
      await runWith(path, (db) =>
        Effect.gen(function* () {
          const events = makeEvents()
          yield* seed(db, events)
          yield* runPassV2(db).pipe(Effect.orDie)
          const clean = yield* snapshot(db)
          yield* verifyByteExact(db, events)

          // Worst-case crash: nothing committed. Revert every promotion.
          yield* db.run(sql`DELETE FROM event_value`).pipe(Effect.orDie)
          yield* db.run(sql`DELETE FROM ocdb_seal`).pipe(Effect.orDie)
          for (const e of events) {
            yield* db.run(sql`UPDATE event SET data = ${JSON.stringify(e.data)} WHERE id = ${e.id}`).pipe(Effect.orDie)
          }

          // Restart: re-run the pass -> identical state, byte-exact.
          const rerun = yield* runPassV2(db).pipe(Effect.exit)
          expect(rerun._tag).toBe("Success")
          if (rerun._tag === "Success") expect(rerun.value.promoted).toBeGreaterThan(0)
          const after = yield* snapshot(db)
          expect(after).toEqual(clean)
          yield* verifyByteExact(db, events)
        }),
      )
    } finally {
      // Windows keeps the DB file locked while the layer is open; best-effort.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  test("PARTIAL CRASH: crash between batches converges to the clean-run state", async () => {
    const { dir, path } = tmpDb()
    try {
      await runWith(path, (db) =>
        Effect.gen(function* () {
          const events = makeEvents()
          yield* seed(db, events)
          yield* runPassV2(db).pipe(Effect.orDie)
          const clean = yield* snapshot(db)
          yield* verifyByteExact(db, events)

          // Crash after agg_a's batch committed, before agg_b's: revert ONLY b.
          const bEvents = events.filter((e) => e.agg === "agg_b")
          yield* db.run(sql`DELETE FROM event_value WHERE aggregate_id = 'agg_b'`).pipe(Effect.orDie)
          yield* db.run(sql`DELETE FROM ocdb_seal WHERE row_id IN (${sql.join(bEvents.map((e) => sql`${e.id}`), sql`, `)})`).pipe(Effect.orDie)
          for (const e of bEvents) {
            yield* db.run(sql`UPDATE event SET data = ${JSON.stringify(e.data)} WHERE id = ${e.id}`).pipe(Effect.orDie)
          }

          // Restart: re-run -> identical state (a NOT double-promoted), byte-exact.
          const rerun = yield* runPassV2(db).pipe(Effect.exit)
          expect(rerun._tag).toBe("Success")
          if (rerun._tag === "Success") expect(rerun.value.promoted).toBeGreaterThan(0)
          const after = yield* snapshot(db)
          expect(after).toEqual(clean)
          yield* verifyByteExact(db, events)
        }),
      )
    } finally {
      // Windows keeps the DB file locked while the layer is open; best-effort.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  test("PROCESS RESTART: a fresh connection sees the promoted state; re-run is a no-op", async () => {
    const { dir, path } = tmpDb()
    try {
      // Process A: promote, verify, snapshot.
      const clean = await runWith(path, (db) =>
        Effect.gen(function* () {
          const events = makeEvents()
          yield* seed(db, events)
          yield* runPassV2(db).pipe(Effect.orDie)
          yield* verifyByteExact(db, events)
          return yield* snapshot(db)
        }),
      )

      // Process B: fresh connection on the same file. State survived.
      await runWith(path, (db) =>
        Effect.gen(function* () {
          const events = makeEvents()
          const after = yield* snapshot(db)
          expect(after).toEqual(clean)
          yield* verifyByteExact(db, events)

          // Re-run the pass: idempotent no-op (0 new promotions, state unchanged).
          const rerun = yield* runPassV2(db).pipe(Effect.exit)
          expect(rerun._tag).toBe("Success")
          if (rerun._tag === "Success") {
            expect(rerun.value.promoted).toBe(0)
            expect(rerun.value.repeated).toBe(0)
          }
          expect(yield* snapshot(db)).toEqual(clean)
        }),
      )
    } finally {
      // Windows keeps the DB file locked while the layer is open; best-effort.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  test("FAIL-CLOSED: a dangling $cdbRef surfaces CdbRehydrateError, never garbage", async () => {
    const { dir, path } = tmpDb()
    try {
      await runWith(path, (db) =>
        Effect.gen(function* () {
          yield* db.insert(EventSequenceTable).values({ aggregate_id: "agg_dangling", seq: 1, owner_id: null }).run().pipe(Effect.orDie)
          yield* db.insert(EventTable).values({
            id: "agg_dangling:1" as never,
            aggregate_id: "agg_dangling",
            seq: 1,
            type: "test.crash",
            data: { $cdbRef: "agg_dangling:1" },
          }).run().pipe(Effect.orDie)

          const rows = yield* db.select().from(EventTable).where(sql`aggregate_id = 'agg_dangling'`).all().pipe(Effect.orDie)
          const outcome = yield* rehydrateEvents(db, "agg_dangling", rows as never).pipe(Effect.exit)
          expect(outcome._tag).toBe("Failure")
          if (outcome._tag === "Failure") {
            // rehydrateEvents dies with the CdbRehydrateError as the defect.
            const reasons = (outcome.cause as unknown as { reasons: Array<{ defect: unknown }> }).reasons
            expect(reasons.some((r) => r.defect instanceof CdbRehydrateError)).toBe(true)
          }
        }),
      )
    } finally {
      // Windows keeps the DB file locked while the layer is open; best-effort.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  test("EXISTING DB: a DB created before the feature promotes + rehydrates correctly when the flags turn on", async () => {
    const { dir, path } = tmpDb()
    try {
      // Phase 1: create the DB WITHOUT the feature (no chunk tables, no
      // create-time pragmas) and write events — the pre-ChunkDB world.
      await runPlain(path, (db) =>
        Effect.gen(function* () {
          const events = makeEvents()
          yield* seed(db, events)
          const seal = yield* db.all<{ c: number }>(sql`SELECT COUNT(*) as c FROM sqlite_master WHERE name = 'ocdb_seal'`).pipe(Effect.orDie)
          expect(seal[0]?.c ?? 0).toBe(0) // no chunk schema yet
        }),
      )

      // Phase 2: reopen with the feature ON — ensureChunkDB upgrades in place
      // (epoch gate 0 -> 2), the sealer promotes, rehydration is byte-exact.
      await runWith(path, (db) =>
        Effect.gen(function* () {
          const events = makeEvents()
          const seal = yield* db.all<{ c: number }>(sql`SELECT COUNT(*) as c FROM sqlite_master WHERE name = 'ocdb_seal'`).pipe(Effect.orDie)
          expect(seal[0]?.c ?? 0).toBe(1) // chunk schema created on reopen
          const rerun = yield* runPassV2(db).pipe(Effect.exit)
          expect(rerun._tag).toBe("Success")
          if (rerun._tag === "Success") expect(rerun.value.promoted).toBeGreaterThan(0)
          yield* verifyByteExact(db, events)
        }),
      )
    } finally {
      // Windows keeps the DB file locked while the layer is open; best-effort.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })
})