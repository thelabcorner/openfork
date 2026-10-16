import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import * as Client from "effect/unstable/sql/SqlClient"
import { layer as bunWorkerLayer } from "../../src/database/sqlite.bun-worker"

/** Six independent SQLite worker connections, not six fibers on one handle.
 * Validates foreground writer progress under real WAL contention. */
test("six contending Bun worker WAL writers each commit once without blocking the runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-bun-wal-stampede-"))
  const filename = join(directory, "test.sqlite")
  const layer = () => bunWorkerLayer({ filename, checkpointOnClose: false })
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const sql = yield* Client.SqlClient
        yield* sql`CREATE TABLE writer_stampede (id INTEGER PRIMARY KEY)`
      }).pipe(Effect.provide(layer()))

      const locked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const writer = (id: number, blocked = false) => Effect.scoped(Effect.gen(function* () {
        const sql = yield* Client.SqlClient
        const connection = yield* sql.reserve
        yield* connection.executeUnprepared("BEGIN IMMEDIATE", [], undefined)
        yield* connection.executeUnprepared(
          "INSERT INTO writer_stampede (id) VALUES (?)", [id], undefined,
        )
        if (blocked) {
          yield* Deferred.succeed(locked, undefined)
          yield* Deferred.await(release)
        }
        yield* connection.executeUnprepared("COMMIT", [], undefined)
      })).pipe(Effect.provide(layer()))

      const first = yield* writer(1, true).pipe(Effect.forkScoped)
      yield* Deferred.await(locked)
      const start = performance.now()
      const followers = yield* Effect.forEach(
        [2, 3, 4, 5, 6],
        (id) => writer(id).pipe(Effect.forkScoped),
      )
      // A blocked synchronous sqlite3_step on the JS thread would prevent
      // this timer from releasing the original writer. Worker requests and
      // bounded BEGIN retries must not cause that dependency cycle.
      yield* Effect.sleep(650)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Effect.forEach(followers, (fiber) => Fiber.join(fiber).pipe(Effect.timeout(12_000)))
      const elapsedMs = performance.now() - start
      const rows = yield* Effect.gen(function* () {
        const sql = yield* Client.SqlClient
        return yield* sql`SELECT id FROM writer_stampede ORDER BY id`
      }).pipe(Effect.provide(layer()))
      expect(rows).toEqual([
        { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 },
      ])
      expect(elapsedMs).toBeGreaterThan(625)
      expect(elapsedMs).toBeLessThan(12_000)
    })))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}, 30_000)
