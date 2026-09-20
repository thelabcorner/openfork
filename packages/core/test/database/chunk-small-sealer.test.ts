import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "../../src/database/sqlite.bun"
import { DatabaseMigration } from "../../src/database/migration"
import { ensureChunkDB } from "../../src/database/chunkdb"
import { runPassV2 } from "../../src/database/chunk-sealer"
import { compressSmallText, decodeValueBytesRaw } from "../../src/database/json-codec"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
const decoder = new TextDecoder()

const previous = {
  enabled: process.env.OPENCODE_SEAL_ENABLED,
  dedup: process.env.OPENCODE_SEAL_DEDUP,
}

beforeEach(() => {
  process.env.OPENCODE_SEAL_ENABLED = "1"
  process.env.OPENCODE_SEAL_DEDUP = "1"
})

function payload(chars: number, label: string) {
  const text = (label + "-abcdef0123456789").repeat(Math.ceil(chars / (label.length + 17))).slice(0, chars)
  return JSON.stringify({ kind: "small-seal-test", label, text })
}

describe("ChunkDB production small inline lane", () => {
  test("Brotli-5 helper owns only the measured 512..4095-character band", () => {
    const tiny = payload(200, "tiny")
    const small = payload(900, "small")
    const large = payload(5_000, "large")

    expect(typeof compressSmallText(tiny)).toBe("string")
    const frame = compressSmallText(small)
    expect(frame).toBeInstanceOf(Uint8Array)
    if (!(frame instanceof Uint8Array)) throw new Error("expected small frame")
    expect(frame[4]).toBe(3)
    expect(frame[5]).toBe(2)
    expect(decoder.decode(decodeValueBytesRaw(frame))).toBe(small)
    expect(typeof compressSmallText(large)).toBe("string")
  })

  test("runPassV2 frames cold 512..4095 event text inline, journals it, and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chunk-small-seal-"))
    const path = join(dir, "db.sqlite")
    try {
      const small = payload(900, "small")
      const tiny = payload(200, "tiny")
      const now = Date.now()

      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* ensureChunkDB(db)
          yield* db.run(sql`
            INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
            VALUES ('global', '/tmp', '[]', 1, 1)
          `)
          yield* db.run(sql`
            INSERT INTO session (
              id, project_id, slug, directory, title, version, time_created, time_updated
            ) VALUES ('ses_small', 'global', 'small', '/tmp', 'small', 'test', 1, 1)
          `)
          yield* db.run(sql`
            INSERT INTO event_sequence (aggregate_id, seq, owner_id)
            VALUES ('ses_small', 2, NULL)
          `)
          yield* db.run(sql`
            INSERT INTO event (id, aggregate_id, seq, type, data)
            VALUES
              ('evt_small', 'ses_small', 0, 'test.small', ${small}),
              ('evt_tiny', 'ses_small', 1, 'test.tiny', ${tiny})
          `)

          const first = yield* runPassV2(db, { batchSize: 32, maxRowsPerPass: 32 })
          expect(first.processed).toBe(1)
          expect(first.promoted).toBe(1)
          expect(first.repeated).toBe(0)
          expect(first.bytes).toBeGreaterThan(0)

          const stored = yield* db.get<{ data: Uint8Array; storage: string }>(sql`
            SELECT data, typeof(data) AS storage FROM event WHERE id = 'evt_small'
          `)
          expect(stored?.storage).toBe("blob")
          expect(stored?.data).toBeInstanceOf(Uint8Array)
          expect(decoder.decode(decodeValueBytesRaw(stored!.data))).toBe(small)

          const seal = yield* db.get<{
            codec: number
            frameVersion: number
            rawBytes: number
            storedBytes: number
          }>(sql`
            SELECT codec,
                   frame_version AS frameVersion,
                   raw_bytes AS rawBytes,
                   stored_bytes AS storedBytes
            FROM ocdb_seal
            WHERE table_name = 'event' AND row_id = 'evt_small' AND column_name = 'data'
          `)
          expect(seal?.codec).toBe(2)
          expect(seal?.frameVersion).toBe(3)
          expect(seal?.storedBytes).toBeLessThan(seal!.rawBytes)

          const untouched = yield* db.all<{ id: string; storage: string }>(sql`
            SELECT id, typeof(data) AS storage
            FROM event
            WHERE id = 'evt_tiny'
            ORDER BY id
          `)
          expect(untouched).toEqual([{ id: "evt_tiny", storage: "text" }])

          const second = yield* runPassV2(db, { batchSize: 32, maxRowsPerPass: 32 })
          expect(second.processed).toBe(0)
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

afterEach(() => {
  if (previous.enabled === undefined) delete process.env.OPENCODE_SEAL_ENABLED
  else process.env.OPENCODE_SEAL_ENABLED = previous.enabled
  if (previous.dedup === undefined) delete process.env.OPENCODE_SEAL_DEDUP
  else process.env.OPENCODE_SEAL_DEDUP = previous.dedup
})
