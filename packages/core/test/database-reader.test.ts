import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Ref, Scope } from "effect"
import { acquireScopedResource, Database } from "@opencode-ai/core/database/database"

test("lazy database resource acquisition closes partial resources on failure and interruption", async () => {
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const owner = yield* Scope.make()
      const closed = yield* Ref.make(0)
      const failed = yield* acquireScopedResource(owner, (candidate) =>
        Effect.gen(function* () {
          yield* Scope.addFinalizer(candidate, Ref.update(closed, (count) => count + 1))
          return yield* Effect.fail("setup failed")
        }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* Ref.get(closed)).toBe(1)

      const entered = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      const interrupted = yield* acquireScopedResource(owner, (candidate) =>
        Effect.gen(function* () {
          yield* Scope.addFinalizer(candidate, Ref.update(closed, (count) => count + 1))
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(never)
          return "unreachable"
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(interrupted)
      expect(yield* Ref.get(closed)).toBe(2)

      const succeeded = yield* acquireScopedResource(owner, (candidate) =>
        Effect.gen(function* () {
          yield* Scope.addFinalizer(candidate, Ref.update(closed, (count) => count + 1))
          return "ready"
        }),
      )
      expect(succeeded).toBe("ready")
      expect(yield* Ref.get(closed)).toBe(2)
      yield* Scope.close(owner, Exit.void)
      expect(yield* Ref.get(closed)).toBe(3)
    })),
  )
})

test("file-backed readDb bypasses the primary connection permit while preserving WAL isolation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reader-"))
  const filename = path.join(directory, "reader.sqlite")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { db, readDb, scanDb } = database
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

        // Heavy analytics get their own lazy persistent connection. Its
        // lifetime belongs to Database, not to the request scope that first
        // asks for it.
        const scanFirst = yield* Effect.scoped(scanDb())
        const scanSecond = yield* scanDb()
        expect(scanSecond).toBe(scanFirst)
        expect(scanFirst).not.toBe(db)
        expect(scanFirst).not.toBe(readDb)
        expect(yield* scanFirst.get<{ value: number }>(sql`SELECT value FROM reader_probe WHERE id = 1`)).toEqual({ value: 1 })

        // Guardrail: consumers cannot accidentally turn the latency-isolated
        // connections into additional writers and create a new lock race.
        expect(Exit.isFailure(yield* readDb.run(sql`UPDATE reader_probe SET value = 99 WHERE id = 1`).pipe(Effect.exit))).toBe(
          true,
        )
        expect(Exit.isFailure(yield* scanFirst.run(sql`UPDATE reader_probe SET value = 98 WHERE id = 1`).pipe(Effect.exit))).toBe(
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

test("file-backed scanDb is persistent, query-only, and owned by the Database lifetime", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-scan-reader-"))
  const filename = path.join(directory, "reader.sqlite")
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.run(sql`CREATE TABLE scan_probe (id integer PRIMARY KEY, value integer NOT NULL)`)
        yield* database.db.run(sql`INSERT INTO scan_probe (id, value) VALUES (1, 7)`)

        // Acquire from a deliberately short caller scope. The connection must
        // remain alive because its native layer belongs to Database's scope.
        const initial = yield* Effect.all(
          Array.from({ length: 6 }, () => Effect.scoped(database.scanDb())),
          { concurrency: "unbounded" },
        )
        const first = initial[0]!
        expect(initial.every((connection) => connection === first)).toBe(true)
        expect(first).not.toBe(database.db)
        expect(first).not.toBe(database.readDb)
        expect(yield* first.get<{ query_only: number }>("PRAGMA query_only")).toEqual({ query_only: 1 })
        expect(yield* first.get<{ value: number }>(sql`SELECT value FROM scan_probe WHERE id = 1`)).toEqual({ value: 7 })
        expect(Exit.isFailure(yield* first.run(sql`UPDATE scan_probe SET value = 9 WHERE id = 1`).pipe(Effect.exit))).toBe(true)

        const second = yield* database.scanDb()
        expect(second).toBe(first)
        expect(yield* second.get<{ value: number }>(sql`SELECT value FROM scan_probe WHERE id = 1`)).toEqual({ value: 7 })
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test(":memory: readDb aliases db so ephemeral databases retain one shared store", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db, readDb, scanDb } = yield* Database.Service
      expect(readDb).toBe(db)
      const scan = yield* scanDb()
      expect(scan).toBe(db)
      yield* db.run(sql`CREATE TABLE scan_memory_probe (id integer PRIMARY KEY)`)
      yield* db.run(sql`INSERT INTO scan_memory_probe (id) VALUES (1)`)
      expect(yield* scan.get<{ id: number }>(sql`SELECT id FROM scan_memory_probe WHERE id = 1`)).toEqual({ id: 1 })
      // Acquiring the scan lane must not install query_only on the shared
      // :memory: handle.
      yield* db.run(sql`INSERT INTO scan_memory_probe (id) VALUES (2)`)
      expect(yield* scan.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM scan_memory_probe`)).toEqual({ count: 2 })
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
