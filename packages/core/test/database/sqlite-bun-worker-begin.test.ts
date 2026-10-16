import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import * as Client from "effect/unstable/sql/SqlClient"
import { layer as bunWorkerLayer } from "../../src/database/sqlite.bun-worker"

/**
 * Exercise the actual Bun worker transport, regardless of #sqlite condition,
 * environment flag, or which driver Database.layerFromPath happens to select.
 */
const fixture = async (name: string, run: (
  filename: string,
  layer: () => ReturnType<typeof bunWorkerLayer>,
) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-" + name + "-"))
  const filename = join(directory, "test.sqlite")
  try {
    await run(filename, () => bunWorkerLayer({ filename, checkpointOnClose: false }))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

test("Bun worker BEGIN IMMEDIATE retries when another WAL worker owns the writer slot", async () =>
  fixture("worker-retry", async (_filename, layer) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const client = yield* Client.SqlClient
        yield* client`CREATE TABLE worker_retry (id INTEGER PRIMARY KEY)`
      }).pipe(Effect.provide(layer()))
      const locked = yield* Deferred.make<void>()
      const unlock = yield* Deferred.make<void>()
      const owner = yield* Effect.scoped(Effect.gen(function* () {
        const client = yield* Client.SqlClient
        const connection = yield* client.reserve
        yield* connection.executeUnprepared("BEGIN IMMEDIATE", [], undefined)
        yield* connection.executeUnprepared("INSERT INTO worker_retry VALUES (1)", [], undefined)
        yield* Deferred.succeed(locked, undefined)
        yield* Deferred.await(unlock)
        yield* connection.executeUnprepared("COMMIT", [], undefined)
      })).pipe(Effect.provide(layer()), Effect.forkScoped)
      yield* Deferred.await(locked)
      const start = performance.now()
      const contender = yield* Effect.scoped(Effect.gen(function* () {
        const client = yield* Client.SqlClient
        const connection = yield* client.reserve
        yield* connection.executeUnprepared("BEGIN IMMEDIATE", [], undefined)
        yield* connection.executeUnprepared("INSERT INTO worker_retry VALUES (2)", [], undefined)
        yield* connection.executeUnprepared("COMMIT", [], undefined)
      })).pipe(Effect.provide(layer()), Effect.forkScoped)
      yield* Effect.sleep(325)
      yield* Deferred.succeed(unlock, undefined)
      yield* Fiber.join(owner)
      yield* Fiber.join(contender).pipe(Effect.timeout(5_000))
      expect(performance.now() - start).toBeGreaterThan(300)
      const rows = yield* Effect.gen(function* () {
        const client = yield* Client.SqlClient
        return yield* client`SELECT id FROM worker_retry ORDER BY id`
      }).pipe(Effect.provide(layer()))
      expect(rows).toEqual([{ id: 1 }, { id: 2 }])
    })))
  }), 20_000)

test("Bun worker never retries a busy autocommit write with ambiguous outcome", async () =>
  fixture("worker-no-write-retry", async (_filename, layer) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const client = yield* Client.SqlClient
        yield* client`CREATE TABLE no_write_retry (id INTEGER PRIMARY KEY)`
      }).pipe(Effect.provide(layer()))
      const locked = yield* Deferred.make<void>()
      const unlock = yield* Deferred.make<void>()
      const owner = yield* Effect.scoped(Effect.gen(function* () {
        const client = yield* Client.SqlClient
        const connection = yield* client.reserve
        yield* connection.executeUnprepared("BEGIN IMMEDIATE", [], undefined)
        yield* connection.executeUnprepared("INSERT INTO no_write_retry VALUES (1)", [], undefined)
        yield* Deferred.succeed(locked, undefined)
        yield* Deferred.await(unlock)
        yield* connection.executeUnprepared("COMMIT", [], undefined)
      })).pipe(Effect.provide(layer()), Effect.forkScoped)
      yield* Deferred.await(locked)
      const outcome = yield* Effect.gen(function* () {
        const client = yield* Client.SqlClient
        // A busy write MUST fail without being replayed by the driver.
        return yield* client`INSERT INTO no_write_retry VALUES (2)`
      }).pipe(Effect.provide(layer()), Effect.timeout(1_000), Effect.exit)
      yield* Deferred.succeed(unlock, undefined)
      yield* Fiber.join(owner)
      expect(Exit.isFailure(outcome)).toBe(true)
      const rows = yield* Effect.gen(function* () {
        const client = yield* Client.SqlClient
        return yield* client`SELECT id FROM no_write_retry ORDER BY id`
      }).pipe(Effect.provide(layer()))
      expect(rows).toEqual([{ id: 1 }])
    })))
  }), 20_000)
