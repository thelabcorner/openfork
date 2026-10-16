import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "../../src/database/database"

/** 3.5 million SQLite VM recursive rows require substantial CPU work. */
const expensive = `WITH RECURSIVE counting(n) AS (
  SELECT 0 UNION ALL SELECT n + 1 FROM counting WHERE n < 3500000
) SELECT sum(n) AS total FROM counting`

test("file-backed interactive and analytical scans never block Bun's JS event loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-read-worker-scheduling-"))
  const filename = join(directory, "reads.sqlite")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { readDb, scanDb, db } = yield* Database.Service
      yield* db.run("CREATE TABLE read_boundary_probe (value INTEGER NOT NULL)")
      const readers = [
        { name: "interactive", db: readDb },
        { name: "scan", db: yield* scanDb() },
      ]
      for (const reader of readers) {
        const entered = yield* Deferred.make<void>()
        const started = performance.now()
        const query = yield* Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          return yield* reader.db.get<{ total: number }>(expensive)
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        // If the read lane uses synchronous Bun SQLite, it blocks the main
        // event loop for the whole query; the timer then fires far too late.
        const timerStart = performance.now()
        yield* Effect.sleep(50)
        const timerDelay = performance.now() - timerStart
        const result = yield* Fiber.join(query).pipe(Effect.timeout(10_000))
        const queryDuration = performance.now() - started
        expect(result?.total).toBe(6_125_001_750_000)
        expect(queryDuration).toBeGreaterThan(100)
        expect(timerDelay).toBeLessThan(250)
        expect((yield* reader.db.get<{ query_only: number }>("PRAGMA query_only"))?.query_only).toBe(1)
        // This checks the underlying native connection is actually read-only
        // rather than merely relying on the mutable query_only PRAGMA.
        yield* reader.db.run("PRAGMA query_only = OFF")
        const accidentalWrite = yield* Effect.exit(reader.db.run("INSERT INTO read_boundary_probe VALUES (99)"))
        yield* reader.db.run("PRAGMA query_only = ON")
        expect(Exit.isFailure(accidentalWrite)).toBe(true)
      }
      expect((yield* db.get<{ count: number }>("SELECT COUNT(*) AS count FROM read_boundary_probe"))?.count).toBe(0)
      expect(readers[0]!.db).not.toBe(db)
      expect(readers[1]!.db).not.toBe(db)
      expect(readers[0]!.db).not.toBe(readers[1]!.db)
    }).pipe(Effect.provide(Database.layerFromPath(filename, { asyncReadWorker: true })))))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}, 30_000)
