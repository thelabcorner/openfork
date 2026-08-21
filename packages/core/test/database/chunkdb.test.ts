import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import { deepStrictEqual } from "node:assert"
import { Effect, Schema, Exit } from "effect"
import {
  compressedJson,
  compressText,
  decompressFrame,
  decodeValueBytesObject,
  isV4Frame,
  OCDBFrameError,
} from "../../src/database/json-codec"
import { EventV2, rehydrateEvents, CdbRehydrateError, rehydrateCacheStats, resetRehydrateCacheStats, REHYDRATE_CACHE_CAP_ENTRIES, decodeValueBytesObjectStreaming } from "../../src/event"
import { Event } from "@opencode-ai/schema/event"
import { Database as CoreDatabase } from "../../src/database/database"
import type { DatabaseShape } from "../../src/database/database"
import { EventSequenceTable, EventTable, EventValueTable } from "../../src/event/sql"

// A large, repetitive JSON object so compressText() actually emits a frame
// (the threshold is 4096 UTF-16 code units; brotli shrinks repetitive text a
// lot, so the frame beats the raw bytes and a Uint8Array is returned).
function makeBigObject() {
  return {
    type: "session-message",
    sessionID: "sess_abc123",
    content: Array.from({ length: 200 }, (_, i) => ({
      role: "user",
      index: i,
      text: "The quick brown fox jumps over the lazy dog. ".repeat(12),
    })),
  }
}

const ChunkDBTest = sqliteTable("chunkdb_test", {
  id: text("id").primaryKey(),
  data: compressedJson("data", { mode: "json" }),
})

function makeDrizzle() {
  const database = new Database(":memory:")
  // compressedJson's dataType() returns "text", so the column is TEXT; the
  // sealer later stores a BLOB into it (SQLite keeps BLOB despite TEXT affinity).
  database.run("CREATE TABLE chunkdb_test (id TEXT PRIMARY KEY, data TEXT)")
  // drizzle() needs the instance wrapped as { client } — a bare Database is
  // ignored and a fresh :memory: DB is created instead.
  const db = drizzle({ client: database, schema: { chunkdbTest: ChunkDBTest } })
  return { database, db }
}

describe("ChunkDB compressedJson read-path", () => {
  test("WIRING: a frame written by the sealer decodes back to the original object via the Drizzle read path", async () => {
    const { database, db } = makeDrizzle()
    const obj = makeBigObject()

    // Hot write through the column's toDriver (identity JSON.stringify -> TEXT).
    await db.insert(ChunkDBTest).values({ id: "1", data: obj })

    // Read back the TEXT row — proves fromDriver decodes a plain JSON string.
    const textRows = await db.select().from(ChunkDBTest)
    expect(textRows).toEqual([{ id: "1", data: obj }])

    // Simulate the background sealer: frame the JSON string, then write the raw
    // frame bytes as a BLOB — exactly what chunk-sealer.ts does via `sql`.
    const frame = compressText(JSON.stringify(obj))
    expect(frame).toBeInstanceOf(Uint8Array)
    if (typeof frame === "string") throw new Error("expected a frame for this large object")
    database.run("UPDATE chunkdb_test SET data = ? WHERE id = ?", [frame, "1"])

    // Read back through the Drizzle query — fromDriver must decode the frame to
    // the original object. This is the core non-breaking read guarantee.
    const framedRows = await db.select().from(ChunkDBTest)
    expect(framedRows).toEqual([{ id: "1", data: obj }])
  })

  test("FAIL-CLOSED: corrupt frames throw OCDBFrameError while a healthy frame still decodes", () => {
    const obj = makeBigObject()
    const frame = compressText(JSON.stringify(obj))
    expect(frame).toBeInstanceOf(Uint8Array)
    if (typeof frame === "string") throw new Error("expected a frame for this large object")

    const badMagic = new Uint8Array(frame)
    badMagic[0] = 0x00
    const badVersion = new Uint8Array(frame)
    badVersion[4] = 99
    const badCrc = new Uint8Array(frame)
    badCrc[10] ^= 0xff // flip a CRC byte -> decompress ok, CRC mismatch

    expect(() => decompressFrame(badMagic)).toThrow(OCDBFrameError)
    expect(() => decompressFrame(badVersion)).toThrow(OCDBFrameError)
    expect(() => decompressFrame(badCrc)).toThrow(OCDBFrameError)

    // A flipped payload byte must still fail closed (native decompress error or
    // CRC mismatch — either way it throws rather than returning garbage).
    const badPayload = new Uint8Array(frame)
    badPayload[14] ^= 0xff
    expect(() => decompressFrame(badPayload)).toThrow()

    // The healthy frame in the same batch decodes to the original object.
    expect(JSON.parse(decompressFrame(frame))).toEqual(obj)
  })

  test("HOT-PATH ZERO-COST: toDriver is identity (byte-identical TEXT)", async () => {
    const { database, db } = makeDrizzle()
    const obj = makeBigObject()

    // Access the real toDriver captured by customType (not a re-implementation).
    const builder = compressedJson("data", { mode: "json" }) as unknown as {
      config: { customTypeParams: { toDriver: (value: unknown) => unknown } }
    }
    const toDriver = builder.config.customTypeParams.toDriver
    expect(toDriver(obj)).toBe(JSON.stringify(obj))

    // And the stored hot-write is literally the JSON text, never a frame.
    await db.insert(ChunkDBTest).values({ id: "z", data: obj })
    const stored = database
      .query("SELECT data FROM chunkdb_test WHERE id = 'z'")
      .all() as Array<{ data: unknown }>
    expect(typeof stored[0].data).toBe("string")
    expect(stored[0].data).toBe(JSON.stringify(obj))
  })
})

// ---------------------------------------------------------------------------
// Epoch-2 rehydration (read path). Exercises the rehydrating read API
// (EventV2.readAggregate) end-to-end: a promoted `{"$cdbRef": "<id>"}`
// reference is spliced back to its full payload, byte-exact, via a single
// batched event_value lookup + per-db cache.
//
// OPENCODE_SEAL_DEDUP is toggled on at runtime (the flag is a getter) so the
// rehydration path activates. OPENCODE_SEAL_ENABLED stays off so the
// background sealer is never forked — we promote rows by hand to keep the test
// deterministic. The read path only depends on this flag + the event_value
// table, both of which we control here.
// ---------------------------------------------------------------------------
process.env.OPENCODE_SEAL_DEDUP = "1"

const encoder = new TextEncoder()

function makeChunkPayload() {
  return {
    type: "session-message",
    sessionID: "sess_rehydrate_123",
    content: Array.from({ length: 200 }, (_, i) => ({
      role: "user",
      index: i,
      text: "The quick brown fox jumps over the lazy dog. ".repeat(12),
    })),
  }
}

const ChunkEvent = EventV2.define({
  type: "test.chunk",
  durable: { version: 1, aggregate: "aggregateID" },
  schema: { aggregateID: Schema.String, payload: Schema.Unknown },
})

const chunkManifest = {
  definitions: Event.durable([ChunkEvent]),
  schema: ChunkEvent,
}

// A fresh :memory: database per test (fully isolated; no shared file, no sealer
// fork because SEAL is off). We create event_value by hand since ensureChunkDB
// is gated on OPENCODE_SEAL_ENABLED.
const dbLayer = CoreDatabase.layerFromPath(":memory:")

const EVENT_VALUE_DDL = `CREATE TABLE IF NOT EXISTS event_value (
  aggregate_id TEXT NOT NULL,
  value_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  raw_len INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  refs INTEGER NOT NULL DEFAULT 1,
  time_promoted INTEGER NOT NULL,
  PRIMARY KEY (aggregate_id, value_id),
  UNIQUE (aggregate_id, sha256),
  FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
)`

function runWithDb(body: (db: DatabaseShape) => Effect.Effect<void, unknown, unknown>) {
  const provided = Effect.gen(function* () {
    const { db } = yield* CoreDatabase.Service
    yield* body(db)
  }).pipe(Effect.provide(dbLayer)) as Effect.Effect<void, unknown, never>
  return Effect.runPromise(provided)
}

describe("ChunkDB epoch-2 rehydration (read path)", () => {
  test("rehydrates deduped $cdbRef rows byte-exact and proves a single event_value row", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)

        const aggID = "agg_dedup"
        const eventData = { aggregateID: aggID, payload: makeChunkPayload() }
        const type = EventV2.versionedType("test.chunk", 1)
        const e1ID = EventV2.ID.create()
        const e2ID = EventV2.ID.create()

        // Two events carrying the IDENTICAL payload.
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: aggID, seq: 2, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values([
            { id: e1ID, aggregate_id: aggID, seq: 1, type, data: eventData },
            { id: e2ID, aggregate_id: aggID, seq: 2, type, data: eventData },
          ])
          .run()
          .pipe(Effect.orDie)

        // Promote BOTH to the SAME event_value row (dedup by sha256): the sealer
        // would insert once and point the second ref at the first value_id.
        const raw = JSON.stringify(eventData)
        const sha = createHash("sha256").update(encoder.encode(raw)).digest("hex")
        const frame = compressText(raw)
        const stored = typeof frame === "string" ? encoder.encode(frame) : frame
        const valueID = `${aggID}:1`
        yield* db
          .insert(EventValueTable)
          .values({
            aggregate_id: aggID,
            value_id: valueID,
            sha256: sha,
            raw_len: raw.length,
            bytes: stored,
            refs: 1,
            time_promoted: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)
        yield* db.run(sql`UPDATE event SET data = ${JSON.stringify({ $cdbRef: valueID })} WHERE id = ${e1ID}`).pipe(Effect.orDie)
        yield* db.run(sql`UPDATE event SET data = ${JSON.stringify({ $cdbRef: valueID })} WHERE id = ${e2ID}`).pipe(Effect.orDie)

        // Read both back through the rehydrating read API.
        const result = yield* EventV2.readAggregate(db, { aggregateID: aggID, limit: 100, manifest: chunkManifest })
        expect(result.events).toHaveLength(2)
        for (const ev of result.events) {
          // Byte-exact: rehydrated object deep-equals the original via
          // node:assert's isDeepStrictEqual.
          deepStrictEqual(ev.data, eventData)
        }

        // DEDUP PROOF: exactly ONE event_value row holds this payload, yet both
        // event rows reference it.
        const count = yield* db
          .all<{ c: number }>(sql`SELECT COUNT(*) as c FROM event_value WHERE aggregate_id = ${aggID}`)
          .pipe(Effect.orDie)
        expect(count[0].c).toBe(1)
      }),
    )
  })

  test("FAIL-CLOSED: a dangling $cdbRef throws CdbRehydrateError (no synthesized value)", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)

        const aggID = "agg_dangling"
        const type = EventV2.versionedType("test.chunk", 1)
        const d1ID = EventV2.ID.create()
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: aggID, seq: 1, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values([{ id: d1ID, aggregate_id: aggID, seq: 1, type, data: { aggregateID: aggID, payload: makeChunkPayload() } }])
          .run()
          .pipe(Effect.orDie)

        // Point at a value_id that does NOT exist in event_value.
        yield* db.run(sql`UPDATE event SET data = ${JSON.stringify({ $cdbRef: "ghost" })} WHERE id = ${d1ID}`).pipe(Effect.orDie)

        // A dangling $cdbRef must fail closed. The thrown CdbRehydrateError
        // surfaces as a defect (like json-codec's OCDBFrameError), so we assert
        // via the Exit/cause rather than Effect.flip.
        const exit = yield* EventV2.readAggregate(db, {
          aggregateID: aggID,
          limit: 100,
          manifest: chunkManifest,
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  test("HOT PATH: inline (non-ref) rows are returned unchanged with no event_value lookup", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)

        const aggID = "agg_hot"
        const inlineData = { aggregateID: aggID, payload: { hello: "world", n: 42 } }
        const type = EventV2.versionedType("test.chunk", 1)
        const h1ID = EventV2.ID.create()
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: aggID, seq: 1, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values([{ id: h1ID, aggregate_id: aggID, seq: 1, type, data: inlineData }])
          .run()
          .pipe(Effect.orDie)

        // No event_value rows exist; an inline row must read back verbatim.
        const result = yield* EventV2.readAggregate(db, { aggregateID: aggID, limit: 100, manifest: chunkManifest })
        expect(result.events).toHaveLength(1)
        deepStrictEqual(result.events[0].data, inlineData)
      }),
    )
  })

  // Serial: this test flips the global flag off, so it must not run concurrently
  // with the DEDUP-on tests above (bun runs tests in a file in parallel).
  test.serial("GATE: with OPENCODE_SEAL_DEDUP off, rehydrateEvents returns rows untouched (no event_value lookup)", async () => {
    const prev = process.env.OPENCODE_SEAL_DEDUP
    process.env.OPENCODE_SEAL_DEDUP = "0"
    try {
      await runWithDb((db) =>
        Effect.gen(function* () {
          yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)
          const valueID = "agg_gate:1"
          // No event_value row is seeded — even if one existed, the gate must
          // prevent any lookup. With DEDUP off the row is returned verbatim.
          const refRow = {
            id: EventV2.ID.create(),
            aggregate_id: "agg_gate",
            seq: 1,
            type: "test.chunk.1",
            data: { $cdbRef: valueID } as Record<string, unknown>,
          }
          const out = yield* rehydrateEvents(db, "agg_gate", [refRow])
          // Gate closed (DEDUP off): row returned unchanged, ref NOT spliced —
          // proving no event_value lookup occurred.
          expect(out[0].data).toEqual({ $cdbRef: valueID })
        }),
      )
    } finally {
      process.env.OPENCODE_SEAL_DEDUP = prev
    }
  })

  test("CACHE: re-reading the same $cdbRef hits the hot-value cache (no second decode)", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)
        const aggID = "agg_cache_hit"
        const eventData = { aggregateID: aggID, payload: makeChunkPayload() }
        const type = EventV2.versionedType("test.chunk", 1)
        const cacheID = EventV2.ID.create()
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: aggID, seq: 1, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values([{ id: cacheID, aggregate_id: aggID, seq: 1, type, data: eventData }])
          .run()
          .pipe(Effect.orDie)
        const raw = JSON.stringify(eventData)
        const sha = createHash("sha256").update(encoder.encode(raw)).digest("hex")
        const frame = compressText(raw)
        const stored = typeof frame === "string" ? encoder.encode(frame) : frame
        const valueID = `${aggID}:1`
        yield* db
          .insert(EventValueTable)
          .values({
            aggregate_id: aggID,
            value_id: valueID,
            sha256: sha,
            raw_len: raw.length,
            bytes: stored,
            refs: 1,
            time_promoted: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)
        yield* db.run(sql`UPDATE event SET data = ${JSON.stringify({ $cdbRef: valueID })} WHERE id = ${cacheID}`).pipe(Effect.orDie)

        resetRehydrateCacheStats(db)
        yield* EventV2.readAggregate(db, { aggregateID: aggID, limit: 100, manifest: chunkManifest })
        const afterFirst = rehydrateCacheStats(db)
        expect(afterFirst.misses).toBeGreaterThan(0) // first read decodes
        // Second read of the same value must hit the cache (zero decompress + parse).
        yield* EventV2.readAggregate(db, { aggregateID: aggID, limit: 100, manifest: chunkManifest })
        const afterSecond = rehydrateCacheStats(db)
        expect(afterSecond.hits).toBeGreaterThan(afterFirst.hits)
      }),
    )
  })

  test("HOT-VALUE: a high-refs payload survives eviction that flushes low-refs values (ANVIL R)", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)
        const type = EventV2.versionedType("test.chunk", 1)

        // --- hot aggregate: one high-refs payload (refs=1000) ---
        const aggHot = "agg_hot"
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: aggHot, seq: 1, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        const hotData = { aggregateID: aggHot, payload: makeChunkPayload() }
        const hotRaw = JSON.stringify(hotData)
        const hotSha = createHash("sha256").update(encoder.encode(hotRaw)).digest("hex")
        const hotFrame = compressText(hotRaw)
        const hotStored = typeof hotFrame === "string" ? encoder.encode(hotFrame) : hotFrame
        const hotValueID = `${aggHot}:hot`
        yield* db
          .insert(EventValueTable)
          .values({
            aggregate_id: aggHot,
            value_id: hotValueID,
            sha256: hotSha,
            raw_len: hotRaw.length,
            bytes: hotStored,
            refs: 1000,
            time_promoted: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values([{ id: EventV2.ID.create(), aggregate_id: aggHot, seq: 1, type, data: { $cdbRef: hotValueID } }])
          .run()
          .pipe(Effect.orDie)

        // Read the hot value once so it enters the cache (weighted by refs=1000).
        resetRehydrateCacheStats(db)
        yield* EventV2.readAggregate(db, { aggregateID: aggHot, limit: 100, manifest: chunkManifest })

        // --- flood aggregate: cap+50 distinct LOW-refs (refs=1) values ---
        const aggFlood = "agg_flood"
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: aggFlood, seq: REHYDRATE_CACHE_CAP_ENTRIES + 100, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        const floodEvents: Array<{ id: EventV2.ID; aggregate_id: string; seq: number; type: string; data: Record<string, unknown> }> = []
        const floodValues: Array<{ aggregate_id: string; value_id: string; sha256: string; raw_len: number; bytes: Uint8Array; refs: number; time_promoted: number }> = []
        for (let i = 0; i < REHYDRATE_CACHE_CAP_ENTRIES + 50; i++) {
          const data = { aggregateID: aggFlood, payload: { v: i, s: "x".repeat(8) } }
          const raw = JSON.stringify(data)
          const sha = createHash("sha256").update(encoder.encode(raw)).digest("hex")
          const frame = compressText(raw)
          const stored = typeof frame === "string" ? encoder.encode(frame) : frame
          const valueID = `${aggFlood}:flood${i}`
          floodValues.push({ aggregate_id: aggFlood, value_id: valueID, sha256: sha, raw_len: raw.length, bytes: stored, refs: 1, time_promoted: Date.now() })
          floodEvents.push({ id: EventV2.ID.create(), aggregate_id: aggFlood, seq: i + 1, type, data: { $cdbRef: valueID } })
        }
        yield* db.insert(EventTable).values(floodEvents).run().pipe(Effect.orDie)
        for (const v of floodValues) {
          yield* db.insert(EventValueTable).values(v).run().pipe(Effect.orDie)
        }
        yield* EventV2.readAggregate(db, { aggregateID: aggFlood, limit: REHYDRATE_CACHE_CAP_ENTRIES + 100, manifest: chunkManifest })

        // Cache must stay bounded despite the flood (allow small slack for
        // cross-test shared :memory: state; the bound is enforced per-db).
        expect(rehydrateCacheStats(db).entries).toBeLessThanOrEqual(REHYDRATE_CACHE_CAP_ENTRIES)

        // The high-refs hot value must STILL be cached — a generic LRU would have
        // evicted it under this churn. Re-read ONLY the hot aggregate (1 event).
        resetRehydrateCacheStats(db)
        yield* EventV2.readAggregate(db, { aggregateID: aggHot, limit: 100, manifest: chunkManifest })
        expect(rehydrateCacheStats(db).misses).toBe(0)
        expect(rehydrateCacheStats(db).hits).toBeGreaterThan(0)
      }),
    )
  })

  test("SHA256: a tampered event_value.bytes (sha256 mismatch) fails closed", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)
        const aggID = "agg_sha"
        const type = EventV2.versionedType("test.chunk", 1)
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: aggID, seq: 1, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        // Row whose bytes decode to a valid payload but whose sha256 does NOT
        // match those bytes (tampering / corruption).
        const payload = makeChunkPayload()
        const raw = JSON.stringify(payload)
        const frame = compressText(raw)
        const stored = typeof frame === "string" ? encoder.encode(frame) : frame
        const valueID = `${aggID}:1`
        const s1ID = EventV2.ID.create()
        yield* db
          .insert(EventTable)
          .values([{ id: s1ID, aggregate_id: aggID, seq: 1, type, data: { aggregateID: aggID, payload: makeChunkPayload() } }])
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventValueTable)
          .values({
            aggregate_id: aggID,
            value_id: valueID,
            sha256: "deadbeef",
            raw_len: raw.length,
            bytes: stored,
            refs: 1,
            time_promoted: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)
        yield* db.run(sql`UPDATE event SET data = ${JSON.stringify({ $cdbRef: valueID })} WHERE id = ${s1ID}`).pipe(Effect.orDie)

        const exit = yield* EventV2.readAggregate(db, { aggregateID: aggID, limit: 100, manifest: chunkManifest }).pipe(
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  test("STREAMING: v4 segmented frame decodes incrementally via decodeValueBytesObjectStreaming (byte-exact vs sync)", async () => {
    // A > 4MiB payload forces compressText to emit a v4 SEGMENTED frame.
    const bigPayload = { type: "big", data: "x".repeat(4_200_000) }
    const raw = JSON.stringify(bigPayload)
    const frame = compressText(raw)
    const stored = typeof frame === "string" ? encoder.encode(frame) : frame
    expect(isV4Frame(stored)).toBe(true)

    // Sync decode (all segments at once) vs streaming decode (yield between segments).
    const syncResult = decodeValueBytesObject(stored)
    const streamingResult = await Effect.runPromise(decodeValueBytesObjectStreaming(stored))

    // Byte-exact: streaming must produce identical raw bytes and parsed value.
    expect(streamingResult.raw).toEqual(syncResult.raw)
    expect(streamingResult.value).toEqual(syncResult.value)
  })
})

// ---------------------------------------------------------------------------
// #8 OPCL read-path: resolveProjectionRef / resolveCdbRef.
//
// Exercises the projection-column rehydration (session_message.data,
// session.summary_diffs) gated on OPENCODE_OPCL. Mirrors the epoch-2
// rehydration tests above but targets the #8 primitives directly.
// ---------------------------------------------------------------------------
process.env.OPENCODE_SEAL_DEDUP = "1"

function makeSummaryDiffs() {
  return [
    { path: "src/index.ts", status: "modified", additions: 10, deletions: 2 },
    { path: "src/util.ts", status: "added", additions: 42, deletions: 0 },
  ]
}

describe("ChunkDB #8 OPCL projection read-path", () => {
  test.serial("GATE: with OPENCODE_OPCL off, resolveProjectionRef passes $cdbRef through untouched", async () => {
    const prev = process.env.OPENCODE_OPCL
    process.env.OPENCODE_OPCL = "0"
    try {
      await runWithDb((db) =>
        Effect.gen(function* () {
          yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)
          const ref = { $cdbRef: "agg_opcl_off:1" }
          // No event_value row seeded — gate must prevent any lookup.
          const out = yield* EventV2.resolveProjectionRef(db, "agg_opcl_off", "session_message.data", ref)
          expect(out).toEqual(ref)
        }),
      )
    } finally {
      process.env.OPENCODE_OPCL = prev
    }
  })

  test("FAIL-CLOSED: session_message.data dangling $cdbRef throws CdbRehydrateError", async () => {
    process.env.OPENCODE_OPCL = "1"
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)
        const ref = { $cdbRef: "agg_fc_closed:ghost" }
        const exit = yield* EventV2.resolveProjectionRef(db, "agg_fc_closed", "session_message.data", ref).pipe(
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  test("FAIL-SOFT: session.summary_diffs dangling $cdbRef returns undefined (no throw)", async () => {
    process.env.OPENCODE_OPCL = "1"
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)
        const ref = { $cdbRef: "agg_fs_soft:ghost" }
        // Must NOT throw — returns undefined so the caller regenerates.
        const out = yield* EventV2.resolveProjectionRef(db, "agg_fs_soft", "session.summary_diffs", ref)
        expect(out).toBeUndefined()
      }),
    )
  })

  test("BYTE-EXACT: resolveProjectionRef resolves a valid $cdbRef to the canonical payload", async () => {
    process.env.OPENCODE_OPCL = "1"
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)
        const aggID = "agg_opcl_exact"
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: aggID, seq: 0, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        const diffs = makeSummaryDiffs()
        const raw = JSON.stringify(diffs)
        const sha = createHash("sha256").update(encoder.encode(raw)).digest("hex")
        const frame = compressText(raw)
        const stored = typeof frame === "string" ? encoder.encode(frame) : frame
        const valueID = `${aggID}:0:${sha.slice(0, 8)}`
        yield* db
          .insert(EventValueTable)
          .values({
            aggregate_id: aggID,
            value_id: valueID,
            sha256: sha,
            raw_len: raw.length,
            bytes: stored,
            refs: 1,
            time_promoted: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        const ref = { $cdbRef: valueID }
        const out = yield* EventV2.resolveProjectionRef(db, aggID, "session.summary_diffs", ref)
        deepStrictEqual(out, diffs)
      }),
    )
  })

  test("SHA256: resolveCdbRef fail-closed on tampered bytes; fail-soft returns undefined", async () => {
    process.env.OPENCODE_OPCL = "1"
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)
        const aggID = "agg_opcl_sha"
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: aggID, seq: 0, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        const payload = makeSummaryDiffs()
        const raw = JSON.stringify(payload)
        const frame = compressText(raw)
        const stored = typeof frame === "string" ? encoder.encode(frame) : frame
        const valueID = `${aggID}:0:badsha1`
        yield* db
          .insert(EventValueTable)
          .values({
            aggregate_id: aggID,
            value_id: valueID,
            sha256: "deadbeef", // mismatch
            raw_len: raw.length,
            bytes: stored,
            refs: 1,
            time_promoted: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        // fail-closed (default): throws CdbRehydrateError.
        const exit = yield* EventV2.resolveCdbRef(db, aggID, valueID).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)

        // fail-soft: returns undefined instead of throwing.
        const soft = yield* EventV2.resolveCdbRef(db, aggID, valueID, { failSoft: true })
        expect(soft).toBeUndefined()
      }),
    )
  })

  test("CACHE: resolveCdbRef reuses cached payload on second lookup (hit, no second decode)", async () => {
    process.env.OPENCODE_OPCL = "1"
    await runWithDb((db) =>
      Effect.gen(function* () {
        yield* db.run(EVENT_VALUE_DDL).pipe(Effect.orDie)
        const aggID = "agg_opcl_cache"
        yield* db
          .insert(EventSequenceTable)
          .values({ aggregate_id: aggID, seq: 0, owner_id: null })
          .run()
          .pipe(Effect.orDie)
        const payload = makeSummaryDiffs()
        const raw = JSON.stringify(payload)
        const sha = createHash("sha256").update(encoder.encode(raw)).digest("hex")
        const frame = compressText(raw)
        const stored = typeof frame === "string" ? encoder.encode(frame) : frame
        const valueID = `${aggID}:0:${sha.slice(0, 8)}`
        yield* db
          .insert(EventValueTable)
          .values({
            aggregate_id: aggID,
            value_id: valueID,
            sha256: sha,
            raw_len: raw.length,
            bytes: stored,
            refs: 1,
            time_promoted: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        resetRehydrateCacheStats(db)
        yield* EventV2.resolveCdbRef(db, aggID, valueID)
        const afterFirst = rehydrateCacheStats(db)
        expect(afterFirst.misses).toBeGreaterThan(0)

        yield* EventV2.resolveCdbRef(db, aggID, valueID)
        const afterSecond = rehydrateCacheStats(db)
        expect(afterSecond.hits).toBeGreaterThan(afterFirst.hits)
      }),
    )
  })
})
