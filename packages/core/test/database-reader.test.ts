import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "@opencode-ai/core/database/database"

test("file-backed readDb bypasses the primary connection permit while preserving WAL isolation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reader-"))
  const filename = path.join(directory, "reader.sqlite")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { db, readDb } = database
        expect(readDb).not.toBe(db)

        yield* db.run(sql`CREATE TABLE reader_probe (id integer PRIMARY KEY, value integer NOT NULL)`)
        yield* db.run(sql`INSERT INTO reader_probe (id, value) VALUES (1, 1)`)

        const writerEntered = yield* Deferred.make<void>()
        const releaseWriter = yield* Deferred.make<void>()
        const writer = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.run(sql`UPDATE reader_probe SET value = 2 WHERE id = 1`)
              yield* Deferred.succeed(writerEntered, undefined)
              yield* Deferred.await(releaseWriter)
            }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.await(writerEntered)

        // The primary client has one native connection guarded by one permit;
        // this read must queue behind the still-open transaction.
        const primaryRead = yield* db
          .get<{ value: number }>(sql`SELECT value FROM reader_probe WHERE id = 1`)
          .pipe(Effect.forkScoped)
        const primaryCompletedEarly = yield* Effect.race(
          Fiber.await(primaryRead).pipe(Effect.as(true)),
          Effect.sleep("20 millis").pipe(Effect.as(false)),
        )
        expect(primaryCompletedEarly).toBe(false)

        // A separate WAL reader is not queued behind that permit and sees the
        // last committed snapshot, not the writer's uncommitted value.
        expect(yield* readDb.get<{ value: number }>(sql`SELECT value FROM reader_probe WHERE id = 1`)).toEqual({ value: 1 })

        // Guardrail: consumers cannot accidentally turn the latency-isolated
        // connection into a second writer and create a new lock race.
        expect(Exit.isFailure(yield* readDb.run(sql`UPDATE reader_probe SET value = 99 WHERE id = 1`).pipe(Effect.exit))).toBe(
          true,
        )

        yield* Deferred.succeed(releaseWriter, undefined)
        yield* Fiber.join(writer)
        expect(yield* Fiber.join(primaryRead)).toEqual({ value: 2 })
        expect(yield* readDb.get<{ value: number }>(sql`SELECT value FROM reader_probe WHERE id = 1`)).toEqual({ value: 2 })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test(":memory: readDb aliases db so ephemeral databases retain one shared store", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db, readDb } = yield* Database.Service
      expect(readDb).toBe(db)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
