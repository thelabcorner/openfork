import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import * as Client from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { layer as workerLayer } from "../../src/database/sqlite.bun-worker"

test("worker-backed SQLite bounds queued permits without leaking another transaction's lock", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-worker-permit-"))
  const filename = join(folder, "permit.db")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sql = yield* Client.SqlClient
      yield* sql`CREATE TABLE lease_probe(id INTEGER PRIMARY KEY)`
      const entered = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const transaction = yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO lease_probe(id) VALUES(1)`
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(finish)
        return yield* Effect.fail("rollback")
      })).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)

      const started = performance.now()
      const timedOut = yield* Effect.exit(sql`INSERT INTO lease_probe(id) VALUES(2)`)
      expect(Exit.isFailure(timedOut)).toBe(true)
      expect(performance.now() - started).toBeLessThan(1_000)

      let completed = false
      const follower = yield* sql`INSERT INTO lease_probe(id) VALUES(3)`.pipe(
        Effect.tap(() => Effect.sync(() => { completed = true })),
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.sleep(15)
      expect(completed).toBe(false)
      yield* Deferred.succeed(finish, undefined)
      expect(Exit.isFailure(yield* Fiber.join(transaction))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.join(follower))).toBe(true)
      expect(yield* sql`SELECT id FROM lease_probe ORDER BY id`).toEqual([{ id: 3 }])
    }).pipe(Effect.provide(workerLayer({
      filename, disableWAL: true, checkpointOnClose: false, acquireTimeoutMs: 120,
    })))))
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}, 25_000)

test("worker-backed cancellation detaches a blocked semaphore taker without waiting for its deadline", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-worker-cancel-"))
  const filename = join(folder, "permit.db")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sql = yield* Client.SqlClient
      yield* sql`CREATE TABLE cancel_probe(id INTEGER PRIMARY KEY)`
      const entered = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const transaction = yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO cancel_probe VALUES(1)`
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(finish)
        return yield* Effect.fail("rollback")
      })).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      const waiter = yield* sql`INSERT INTO cancel_probe VALUES(2)`.pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.sleep(10)
      const began = performance.now()
      yield* Fiber.interrupt(waiter)
      expect(performance.now() - began).toBeLessThan(750)
      yield* Deferred.succeed(finish, undefined)
      expect(Exit.isFailure(yield* Fiber.join(transaction))).toBe(true)
      yield* sql`INSERT INTO cancel_probe VALUES(3)`
      expect(yield* sql`SELECT id FROM cancel_probe ORDER BY id`).toEqual([{ id: 3 }])
    }).pipe(Effect.provide(workerLayer({
      filename, disableWAL: true, checkpointOnClose: false, acquireTimeoutMs: 5_000,
    })))))
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}, 15_000)

test("worker-backed SQLite rejects a nested same-fiber reserve without waiting for the deadline", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-worker-reentrant-"))
  const filename = join(folder, "permit.db")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sql = yield* Client.SqlClient
      yield* sql`CREATE TABLE recovery_probe(id INTEGER PRIMARY KEY)`
      const began = performance.now()
      const nested = yield* Effect.scoped(Effect.gen(function* () {
        yield* sql.reserve
        return yield* Effect.exit(sql.reserve)
      }))
      expect(Exit.isFailure(nested)).toBe(true)
      expect(performance.now() - began).toBeLessThan(300)
      if (Exit.isFailure(nested)) expect(JSON.stringify(nested.cause)).toContain("already owned by current fiber")
      yield* sql`INSERT INTO recovery_probe VALUES(1)`
      expect(yield* sql`SELECT id FROM recovery_probe`).toEqual([{ id: 1 }])
    }).pipe(Effect.provide(workerLayer({
      filename, disableWAL: true, checkpointOnClose: false, acquireTimeoutMs: 5_000,
    })))))
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}, 15_000)