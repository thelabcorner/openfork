import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { deepStrictEqual } from "node:assert"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Service as DatabaseService } from "../../src/database/database"
import type { DatabaseShape } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import { ensureChunkDB } from "../../src/database/chunkdb"
import {
  compressText,
  decodeValueBytesRaw,
  isV5Frame,
  parseV5Header,
  decodeV5Correction,
  applyV5Correction,
  compressDeltaRef,
  OCDBFrameError,
} from "../../src/database/json-codec"
import { EventV2, CdbRehydrateError } from "../../src/event"
import { EventValueTable } from "../../src/event/sql"
import { sql } from "drizzle-orm"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Large enough to clear the 4096 code-unit framing threshold so compressText
// emits a real v3 frame (not a raw string).
function makeBase() {
  return { type: "summary", text: "A".repeat(5000) }
}
function makeNew() {
  // Record-structured: identical except one appended char (high span overlap).
  return { type: "summary", text: "A".repeat(5000) + "B" }
}

// Fresh, fully-migrated :memory: database per test (mirrors chunk-rebuild.test.ts
// — avoids the memoized-layer state leak that breaks INSERTs in the full suite).
const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
const seedLayer = () =>
  Layer.effect(
    DatabaseService,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* DatabaseMigration.apply(db)
      yield* ensureChunkDB(db)
      return { db, filename: ":memory:" }
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(sqliteLayer({ filename: ":memory:", createTimePragmas: { page_size: 8192, auto_vacuum: 2 } })))

function runWithDb(body: (db: DatabaseShape) => Effect.Effect<void, unknown, unknown>) {
  const provided = Effect.gen(function* () {
    const { db } = yield* DatabaseService
    return yield* body(db)
  }).pipe(Effect.provide(seedLayer())) as Effect.Effect<void, unknown, never>
  return Effect.runPromise(provided)
}

describe("ChunkDB epoch-4 v5 delta_ref frame", () => {
  test("round-trips byte-exact (encode -> parse -> decode -> apply)", () => {
    const baseObj = makeBase()
    const newObj = makeNew()
    const baseRaw = encoder.encode(JSON.stringify(baseObj))
    const newRaw = encoder.encode(JSON.stringify(newObj))
    const baseFrame = compressText(JSON.stringify(baseObj))
    const baseFrameBytes = typeof baseFrame === "string" ? encoder.encode(baseFrame) : baseFrame
    expect(baseFrameBytes).toBeInstanceOf(Uint8Array) // base is a real v3 frame

    const v5 = compressDeltaRef(newRaw, baseRaw, "agg:1", 1, 1)
    expect(isV5Frame(v5)).toBe(true)

    const header = parseV5Header(v5)
    const correction = decodeV5Correction(header.correction, header.codec, header.storedCrc)
    const baseDecoded = decodeValueBytesRaw(baseFrameBytes)
    const reconstructed = applyV5Correction(baseDecoded, correction, header.totalRawLen)

    expect(reconstructed).toEqual(newRaw)
    expect(JSON.parse(decoder.decode(reconstructed))).toEqual(newObj)
  })

  test("fail-closed on corrupt correction CRC", () => {
    const baseRaw = encoder.encode(JSON.stringify(makeBase()))
    const newRaw = encoder.encode(JSON.stringify(makeNew()))
    const v5 = compressDeltaRef(newRaw, baseRaw, "agg:1", 1, 1)
    const header = parseV5Header(v5)
    const corrupt = new Uint8Array(header.correction)
    corrupt[0] ^= 0xff
    expect(() => decodeV5Correction(corrupt, header.codec, header.storedCrc)).toThrow(OCDBFrameError)
  })

  test("fail-closed (wrong content) on wrong base", () => {
    const baseRaw = encoder.encode(JSON.stringify(makeBase()))
    const newRaw = encoder.encode(JSON.stringify(makeNew()))
    // Same length as baseRaw so the COPY offsets stay in-bounds (no length
    // throw) but the copied spans come from the wrong base -> wrong content.
    const wrongBase = encoder.encode(JSON.stringify({ type: "summary", text: "Z".repeat(5000) }))
    const v5 = compressDeltaRef(newRaw, baseRaw, "agg:1", 1, 1)
    const header = parseV5Header(v5)
    const correction = decodeV5Correction(header.correction, header.codec, header.storedCrc)
    const reconstructed = applyV5Correction(wrongBase, correction, header.totalRawLen)
    expect(reconstructed).not.toEqual(newRaw)
  })

  test("resolveCdbRef decodes v5 delta_ref byte-exact", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        const aggID = "agg_delta"
        const baseObj = makeBase()
        const newObj = makeNew()
        const baseRaw = encoder.encode(JSON.stringify(baseObj))
        const newRaw = encoder.encode(JSON.stringify(newObj))
        const baseFrame = compressText(JSON.stringify(baseObj))
        const baseStored = typeof baseFrame === "string" ? encoder.encode(baseFrame) : baseFrame
        const baseValueID = `${aggID}:1`
        const baseSha = createHash("sha256").update(baseRaw).digest("hex")
        yield* db
          .insert(EventValueTable)
          .values({
            aggregate_id: aggID,
            value_id: baseValueID,
            sha256: baseSha,
            raw_len: baseRaw.length,
            bytes: baseStored,
            refs: 1,
            time_promoted: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        const v5 = compressDeltaRef(newRaw, baseRaw, baseValueID, 1, 1)
        const v5ValueID = `${aggID}:2`
        const v5Sha = createHash("sha256").update(newRaw).digest("hex")
        yield* db
          .insert(EventValueTable)
          .values({
            aggregate_id: aggID,
            value_id: v5ValueID,
            sha256: v5Sha,
            raw_len: newRaw.length,
            bytes: v5,
            refs: 1,
            time_promoted: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        const resolved = yield* EventV2.resolveCdbRef(db, aggID, v5ValueID)
        deepStrictEqual(resolved, newObj)
      }),
    )
  })

  test("resolveCdbRef fail-closed on missing delta_ref base", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        const aggID = "agg_delta_missing"
        const newObj = makeNew()
        const newRaw = encoder.encode(JSON.stringify(newObj))
        // Base "agg:999" does not exist in event_value.
        const v5 = compressDeltaRef(newRaw, newRaw, "agg:999", 1, 1)
        const v5ValueID = `${aggID}:2`
        const v5Sha = createHash("sha256").update(newRaw).digest("hex")
        yield* db
          .insert(EventValueTable)
          .values({
            aggregate_id: aggID,
            value_id: v5ValueID,
            sha256: v5Sha,
            raw_len: newRaw.length,
            bytes: v5,
            refs: 1,
            time_promoted: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        const exit = yield* EventV2.resolveCdbRef(db, aggID, v5ValueID).pipe(Effect.exit)
        // Fail-closed: a missing base is a Failure (CdbRehydrateError), never a
        // silent partial decode.
        expect(exit._tag).toBe("Failure")
      }),
    )
  })
})
