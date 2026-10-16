import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "@opencode-ai/core/database/database"

test("opt-in read leases preserve WAL snapshots, cancellation, write progress and file cleanup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openfork-read-pool-"))
  const filename = path.join(directory, "pool.sqlite")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const database = yield* Database.Service
      const { db } = database
      // Real Database layers always supply the lease; legacy hand-written
      // test fixtures may omit it for backward compatibility.
      const withScanDb = database.withScanDb!
      yield* db.run(sql`CREATE TABLE leased_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`)
      yield* db.run(sql`INSERT INTO leased_probe VALUES (1, 7)`)
      yield* db.run(sql`CREATE TABLE writer_probe (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL)`)
      const entered = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
      const release = yield* Deferred.make<void>()
      const hold = (index: number) => withScanDb((conn) =>
        conn.transaction((tx) => Effect.gen(function* () {
          const before = yield* tx.get<{ value: number }>(sql`SELECT value FROM leased_probe WHERE id = 1`)
          yield* Deferred.succeed(entered[index]!, undefined)
          yield* Deferred.await(release)
          const after = yield* tx.get<{ value: number }>(sql`SELECT value FROM leased_probe WHERE id = 1`)
          return { connection: conn, before: before?.value, after: after?.value }
        }), { behavior: "deferred" }),
      )
      const first = yield* hold(0).pipe(Effect.forkScoped)
      const second = yield* hold(1).pipe(Effect.forkScoped)
      yield* Deferred.await(entered[0]!)
      yield* Deferred.await(entered[1]!)
      const queued = yield* withScanDb(() => Effect.succeed("should not run")).pipe(Effect.forkScoped)
      yield* Fiber.interrupt(queued)
      // Two independent reader WAL snapshots remain valid after a writer commits.
      yield* db.run(sql`UPDATE leased_probe SET value = 9 WHERE id = 1`)
      const writerSamples: number[] = []
      for (let sample = 0; sample < 1_000; sample++) {
        const started = performance.now()
        yield* db.run(sql`INSERT INTO writer_probe(created_at) VALUES (${sample})`)
        writerSamples.push(performance.now() - started)
      }
      const ordered = writerSamples.sort((a, b) => a - b)
      const writerP95 = ordered[Math.floor(ordered.length * .95)]!
      expect(writerP95).toBeLessThan(25)
      expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM writer_probe`))
        .toEqual({ count: 1000 })
      console.log("openfork-reader-pool-writer-p95-ms", writerP95.toFixed(3))
      // PASSIVE must not wait for the two pinned readers or take their
      // connection permits. A held snapshot can leave uncheckpointed frames.
      const checkpointPinned = yield* db.get<{ busy: number; log: number; checkpointed: number }>(
        sql`PRAGMA wal_checkpoint(PASSIVE)`,
      )
      expect(checkpointPinned).toBeDefined()
      expect(checkpointPinned!.checkpointed).toBeLessThanOrEqual(checkpointPinned!.log)
      yield* Deferred.succeed(release, undefined)
      const a = yield* Fiber.join(first)
      const b = yield* Fiber.join(second)
      expect(a.connection).not.toBe(b.connection)
      expect([a.before, a.after, b.before, b.after]).toEqual([7, 7, 7, 7])
      // Once both read transactions release their snapshots, TRUNCATE should
      // recover WAL space without waiting for the worker lifetime to end.
      const checkpointReleased = yield* db.get<{ busy: number; log: number; checkpointed: number }>(
        sql`PRAGMA wal_checkpoint(TRUNCATE)`,
      )
      expect(checkpointReleased?.busy).toBe(0)
      expect(checkpointReleased?.log).toBe(0)
      expect(yield* withScanDb((conn) => conn.get<{ value: number }>(
        sql`SELECT value FROM leased_probe WHERE id = 1`,
      ))).toEqual({ value: 9 })
      const forbidden = yield* withScanDb((conn) => conn.run(
        sql`UPDATE leased_probe SET value = 11 WHERE id = 1`,
      )).pipe(Effect.exit)
      expect(Exit.isFailure(forbidden)).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(filename, { scanReaders: 2 })))))
  } finally {
    // Closing the Database owner must await worker finalizers.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
