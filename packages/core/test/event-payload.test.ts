import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "../src/database/sqlite.bun"
import { DatabaseMigration } from "../src/database/migration"
import {
  decrementEventPayloadRefs,
  EVENT_PAYLOAD_ORPHAN_GRACE_MS,
  reclaimOrphanedEventPayloads,
} from "../src/event-payload"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "event-payload-"))
  return { dir, path: join(dir, "db.sqlite") }
}

describe("Event payload ownership", () => {
  test("normalizes duplicate decrements and preserves exact positive ownership", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* db.run(sql`
            INSERT INTO event_payload_meta (payload_id, chunk_count, refs, time_touched)
            VALUES ('payload', 1, 3, 1)
          `).pipe(Effect.orDie)

          yield* decrementEventPayloadRefs(db, [
            { payloadID: "payload", count: 1 },
            { payloadID: "payload", count: 1 },
          ])

          expect(
            yield* db.get<{ refs: number }>(sql`
              SELECT refs FROM event_payload_meta WHERE payload_id = 'payload'
            `).pipe(Effect.orDie),
          ).toEqual({ refs: 1 })
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails closed without partial mutation when any decrement would underflow", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* db.run(sql`
            INSERT INTO event_payload_meta (payload_id, chunk_count, refs, time_touched)
            VALUES
              ('healthy', 1, 2, 1),
              ('underflow', 1, 0, 1)
          `).pipe(Effect.orDie)

          const exit = yield* Effect.exit(
            decrementEventPayloadRefs(db, [
              { payloadID: "healthy", count: 1 },
              { payloadID: "underflow", count: 1 },
            ]),
          )
          expect(Exit.isFailure(exit)).toBe(true)

          expect(
            yield* db.all<{ payloadID: string; refs: number }>(sql`
              SELECT payload_id AS payloadID, refs
              FROM event_payload_meta
              ORDER BY payload_id
            `).pipe(Effect.orDie),
          ).toEqual([
            { payloadID: "healthy", refs: 2 },
            { payloadID: "underflow", refs: 0 },
          ])
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails closed without mutating surviving owners when lifecycle metadata is missing", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          yield* db.run(sql`
            INSERT INTO event_payload_meta (payload_id, chunk_count, refs, time_touched)
            VALUES ('healthy', 1, 2, 1)
          `).pipe(Effect.orDie)

          const exit = yield* Effect.exit(
            decrementEventPayloadRefs(db, [
              { payloadID: "healthy", count: 1 },
              { payloadID: "missing", count: 1 },
            ]),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          expect(
            yield* db.get<{ refs: number }>(sql`
              SELECT refs FROM event_payload_meta WHERE payload_id = 'healthy'
            `).pipe(Effect.orDie),
          ).toEqual({ refs: 2 })
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("reclaims only stale zero-ref payloads and reports a bounded backlog", async () => {
    const { dir, path } = tempDb()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDatabase
          yield* DatabaseMigration.apply(db)
          const now = 2 * EVENT_PAYLOAD_ORPHAN_GRACE_MS
          const stale = now - EVENT_PAYLOAD_ORPHAN_GRACE_MS - 1
          const recent = now - EVENT_PAYLOAD_ORPHAN_GRACE_MS + 1
          yield* db.run(sql`
            INSERT INTO event_payload_meta (payload_id, chunk_count, refs, time_touched)
            VALUES
              ('stale-a', 1, 0, ${stale}),
              ('stale-b', 1, 0, ${stale}),
              ('recent', 1, 0, ${recent}),
              ('live', 1, 1, ${stale})
          `).pipe(Effect.orDie)
          yield* db.run(sql`
            INSERT INTO event_payload_chunk (payload_id, chunk_index, text, time_created)
            VALUES
              ('stale-a', 0, 'a', 1),
              ('stale-b', 0, 'b', 1),
              ('recent', 0, 'r', 1),
              ('live', 0, 'l', 1)
          `).pipe(Effect.orDie)

          const first = yield* reclaimOrphanedEventPayloads(db, { now, limit: 1 })
          expect(first).toEqual({ reclaimed: 1, hasMore: true })
          const second = yield* reclaimOrphanedEventPayloads(db, { now, limit: 8 })
          expect(second).toEqual({ reclaimed: 1, hasMore: false })

          expect(
            yield* db.all<{ payloadID: string; refs: number }>(sql`
              SELECT payload_id AS payloadID, refs
              FROM event_payload_meta
              ORDER BY payload_id
            `).pipe(Effect.orDie),
          ).toEqual([
            { payloadID: "live", refs: 1 },
            { payloadID: "recent", refs: 0 },
          ])
          expect(
            yield* db.all<{ payloadID: string }>(sql`
              SELECT payload_id AS payloadID
              FROM event_payload_chunk
              ORDER BY payload_id
            `).pipe(Effect.orDie),
          ).toEqual([{ payloadID: "live" }, { payloadID: "recent" }])
        }).pipe(Effect.provide(sqliteLayer({ filename: path }))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
