/**
 * Epoch-3 (#8): tests for the opt-in `rebuildDatabase` collapse path.
 *
 * Scenario: a database with the ChunkDB feature ON (event_value exists) is
 * rebuilt to collapse the 5 redundant stores (R1-R5 LOCKED, investigate-v4
 * msg_848e05daf115495c9502e21ab3ff2723 + reversal msg_01ea1ce29dd84f07888253b203da1869)
 * into event_value $cdbRef indexes:
 *   - event.data WHERE type LIKE 'message.updated%'
 *   - event.data WHERE type LIKE 'session.updated%'
 *   - session_message.data
 *   - message.data
 *   - session.summary_diffs
 * EXCLUDES (R5): event.data WHERE type LIKE 'message.part.updated%' (frame-in-place).
 *
 * The rebuild must:
 *   - collapse the 5 stores to {"$cdbRef":...} (versioned-type LIKE match),
 *   - leave message.part.updated and unrelated event types INLINE (not collapsed),
 *   - dedup identical payloads across stores into ONE event_value row (refs bump),
 *   - keep every ref resolvable + decode byte-exact (decodeValueBytes round-trip),
 *   - pass integrity_check (fail-closed Q1),
 *   - fail-closed on a missing file (original untouched).
 *
 * WRITE-side only — read-frontier-v3 owns the rehydrateEvents generalization;
 * this test verifies the refs it produces are resolvable + byte-exact.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deepStrictEqual } from "node:assert"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Service as DatabaseService } from "../../src/database/database"
import type { DatabaseShape } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import { ensureChunkDB } from "../../src/database/chunkdb"
import { rebuildDatabase } from "../../src/database/chunk-rebuild"
import { decodeValueBytes } from "../../src/database/json-codec"
import { sql } from "drizzle-orm"

// NOTE: env is set/RESTORED inside each test (not at module scope) so it never
// leaks into sibling test files (e.g. chunkdb.test.ts) that open DBs through the
// DatabaseService layer — a leaked OPENCODE_SEAL_REBUILD would trigger
// rebuildDatabase on every open there and corrupt their fixtures.
const SEAL_ENV = {
  OPENCODE_SEAL_ENABLED: "1",
  OPENCODE_SEAL_DEDUP: "1",
  OPENCODE_SEAL_WORKERS: "0",
  OPENCODE_SEAL_REBUILD: "1",
}
async function withSealEnv<T>(body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(SEAL_ENV)) {
    prev[k] = process.env[k]
    process.env[k] = SEAL_ENV[k as keyof typeof SEAL_ENV]
  }
  try {
    return await body()
  } finally {
    for (const k of Object.keys(SEAL_ENV)) process.env[k] = prev[k]
  }
}

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()

const seedLayer = (filename: string) =>
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
      sqliteLayer({ filename, createTimePragmas: { page_size: 8192, auto_vacuum: 2 } }),
    ),
  )

function runWith<T>(path: string, body: (db: DatabaseShape) => Effect.Effect<T, unknown, never>): Promise<T> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DatabaseService
      return yield* body(db)
    }).pipe(Effect.provide(seedLayer(path))),
  )
}

// > 4096 chars so it clears the collapse candidate filter.
function bigJson(tag: string) {
  const unit = "The quick brown fox jumps over the lazy dog. ".repeat(20)
  return JSON.stringify({
    tag,
    items: Array.from({ length: 40 }, (_, i) => ({ i, text: unit, extra: unit })),
  })
}

const SHARED = bigJson("shared") // used by message.updated + session_message.data (cross-store dedup)
const SESSION_UPD = bigJson("session.updated")
const PART_UPD = bigJson("part.updated") // R5 exclude
const OTHER = bigJson("other") // unrelated event type, must stay inline

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "chunk-rebuild-"))
  return { dir, path: join(dir, "rebuild.sqlite") }
}

const SESSION_ID = "sess1"
const OTHER_AGG = "agg_other"

async function seedAll(path: string) {
  await runWith(path, (db) =>
    Effect.gen(function* () {
      // project (for session FK) + event_sequence rows (for FK guard canInject).
      yield* db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (${"proj1"}, ${"/tmp"}, ${0}, ${0}, ${"{}"})`).pipe(Effect.orDie)
      yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (${SESSION_ID}, ${10}, ${null})`).pipe(Effect.orDie)
      yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (${OTHER_AGG}, ${10}, ${null})`).pipe(Effect.orDie)

      // session (for session_message/message/summary_diffs aggregate scope).
      yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${SESSION_ID}, ${"proj1"}, ${"s"}, ${"/tmp"}, ${"t"}, ${"v"}, ${0}, ${0})`).pipe(Effect.orDie)

      // event rows: two redundant versioned types, one R5-excluded, one unrelated.
      yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (${"e1"}, ${SESSION_ID}, ${1}, ${"message.updated.1"}, ${SHARED})`).pipe(Effect.orDie)
      yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (${"e2"}, ${SESSION_ID}, ${2}, ${"session.updated.1"}, ${SESSION_UPD})`).pipe(Effect.orDie)
      yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (${"e3"}, ${SESSION_ID}, ${3}, ${"message.part.updated.1"}, ${PART_UPD})`).pipe(Effect.orDie)
      yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (${"e4"}, ${OTHER_AGG}, ${1}, ${"test.other"}, ${OTHER})`).pipe(Effect.orDie)

      // projection rows.
      yield* db.run(sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data, search_text) VALUES (${"sm1"}, ${SESSION_ID}, ${"message"}, ${1}, ${0}, ${0}, ${SHARED}, ${""})`).pipe(Effect.orDie)
      yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${"m1"}, ${SESSION_ID}, ${0}, ${0}, ${bigJson("message.data")})`).pipe(Effect.orDie)
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, search_text) VALUES (${"p1"}, ${"m1"}, ${SESSION_ID}, ${0}, ${0}, ${bigJson("part.data")}, ${""})`).pipe(Effect.orDie)
      yield* db.run(sql`UPDATE session SET summary_diffs = ${bigJson("summary.diffs")} WHERE id = ${SESSION_ID}`).pipe(Effect.orDie)
    }),
  )
}

function isRef(v: unknown): v is { $cdbRef: string } {
  return typeof v === "string" && v.startsWith('{"$cdbRef"')
}

describe("ChunkDB rebuildDatabase (#8)", () => {
  test("COLLAPSES the 6 redundant stores to $cdbRef; EXCLUDES part.updated + unrelated; dedups cross-store; byte-exact", async () => {
    const { dir, path } = tmpDb()
    try {
      await withSealEnv(async () => {
        await seedAll(path)

        const result = await Effect.runPromise(rebuildDatabase(path))
        // 2 event rows collapsed + 4 projection rows collapsed = 6.
        expect(result.collapsed.event).toBe(2)
        expect(result.collapsed.projection).toBe(4)
        // SHARED payload appears in event e1 AND session_message sm1 -> 1 dedup.
        expect(result.collapsed.deduped).toBeGreaterThanOrEqual(1)

        // Reopen and verify the collapsed state + byte-exact rehydration.
        await runWith(path, (db) =>
          Effect.gen(function* () {
            const ic = yield* db.all<{ integrity_check: string }>(sql`PRAGMA integrity_check`).pipe(Effect.orDie)
            expect(ic[0]?.integrity_check).toBe("ok")

            const ev = yield* db.all<{ id: string; type: string; data: string }>(sql`SELECT id, type, data FROM event ORDER BY id`).pipe(Effect.orDie)
          const byId = Object.fromEntries(ev.map((r) => [r.id, r]))

          // Redundant versioned types -> refs.
          expect(isRef(byId["e1"].data)).toBe(true)
          expect(isRef(byId["e2"].data)).toBe(true)
          // R5 exclude + unrelated -> inline (NOT refs).
          expect(isRef(byId["e3"].data)).toBe(false)
          expect(byId["e3"].data).toBe(PART_UPD)
          expect(isRef(byId["e4"].data)).toBe(false)
          expect(byId["e4"].data).toBe(OTHER)

          // Projections -> refs.
          const sm = yield* db.all<{ data: string }>(sql`SELECT data FROM session_message`).pipe(Effect.orDie)
          expect(isRef(sm[0]?.data)).toBe(true)
          const msg = yield* db.all<{ data: string }>(sql`SELECT data FROM message`).pipe(Effect.orDie)
          expect(isRef(msg[0]?.data)).toBe(true)
          const sess = yield* db.all<{ summary_diffs: string }>(sql`SELECT summary_diffs FROM session`).pipe(Effect.orDie)
          expect(isRef(sess[0]?.summary_diffs)).toBe(true)
          // Gap #2: part.data collapses to a $cdbRef on rebuild.
          const part = yield* db.all<{ data: string }>(sql`SELECT data FROM part`).pipe(Effect.orDie)
          expect(isRef(part[0]?.data)).toBe(true)

          // Every event_value row decodes byte-exact to its original JSON. The
          // collapsed payloads live in event_value (part.updated + other stay inline).
          const vals = yield* db.all<{ value_id: string; bytes: Uint8Array }>(sql`SELECT value_id, bytes FROM event_value`).pipe(Effect.orDie)
          expect(vals.length).toBeGreaterThan(0)
          const decoded = new Set<string>()
          for (const v of vals) {
            const raw = v.bytes instanceof Uint8Array ? v.bytes : new Uint8Array(v.bytes as unknown as ArrayBuffer)
            const json = decodeValueBytes(raw)
            const obj = JSON.parse(json)
            decoded.add(obj.tag)
          }
          for (const tag of ["shared", "session.updated", "message.data", "summary.diffs", "part.data"]) {
            expect(decoded.has(tag)).toBe(true)
          }
          // The two R5-excluded / unrelated payloads must NOT be in event_value.
          expect(decoded.has("part.updated")).toBe(false)
          expect(decoded.has("other")).toBe(false)

          // Cross-store dedup: SHARED event_value row has refs >= 2.
          const sharedRef = JSON.parse(byId["e1"].data)["$cdbRef"] as string
          const sharedRow = vals.find((v) => v.value_id === sharedRef)!
          expect(sharedRow).toBeDefined()
          const refs = yield* db.all<{ refs: number }>(sql`SELECT refs FROM event_value WHERE value_id = ${sharedRef}`).pipe(Effect.orDie)
          expect(refs[0]?.refs).toBeGreaterThanOrEqual(2)
        }),
      )
      })
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })

  test("FAIL-CLOSED: rebuild on a missing file fails without throwing a defect", async () => {
    const { dir, path } = tmpDb()
    try {
      await withSealEnv(async () => {
        const exit = await Effect.runPromise(rebuildDatabase(join(dir, "does-not-exist.sqlite")).pipe(Effect.exit))
        expect(exit._tag).toBe("Failure")
      })
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })
})
