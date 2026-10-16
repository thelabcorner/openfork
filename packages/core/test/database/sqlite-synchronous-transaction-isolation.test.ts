import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import * as Client from "effect/unstable/sql/SqlClient"
import { synchronousLayer } from "../../src/database/sqlite.bun"

test("ordinary concurrent statements cannot enter another Session's active Bun SQL transaction", async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* Client.SqlClient
      yield* sql`CREATE TABLE tx_isolation(id INTEGER PRIMARY KEY)`
      const entered = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const transaction = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO tx_isolation(id) VALUES(1)`
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(finish)
          return yield* Effect.fail("roll back own transaction")
        }),
      ).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)

      let returned = false
      const independent = yield* sql`INSERT INTO tx_isolation(id) VALUES(2)`.pipe(
        Effect.tap(() => Effect.sync(() => { returned = true })),
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.sleep(20)
      expect(returned).toBe(false)
      yield* Deferred.succeed(finish, undefined)
      expect(Exit.isFailure(yield* Fiber.join(transaction))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.join(independent))).toBe(true)
      // With an early-released permit, statement 2 incorrectly executes in
      // statement 1's transaction and is lost in the rollback.
      expect(yield* sql`SELECT id FROM tx_isolation ORDER BY id`).toEqual([{ id: 2 }])
    }).pipe(Effect.provide(synchronousLayer({
      filename: ":memory:", disableWAL: true, checkpointOnClose: false,
    }))),
  ))
}, 15_000)

test("nested same-fiber reserve fails immediately and releases the outer SQL connection", async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* Client.SqlClient
      yield* sql`CREATE TABLE reentrant_probe(id INTEGER PRIMARY KEY)`
      const started = performance.now()
      const nested = yield* Effect.scoped(Effect.gen(function* () {
        yield* sql.reserve
        return yield* sql.reserve.pipe(Effect.exit)
      }))
      expect(Exit.isFailure(nested)).toBe(true)
      expect(performance.now() - started).toBeLessThan(300)
      if (Exit.isFailure(nested)) {
        const description = JSON.stringify(nested.cause)
        expect(description).toContain("already owned by current fiber")
        expect(description).toContain("ownerFiber=")
      }
      yield* sql`INSERT INTO reentrant_probe VALUES(1)`
      expect(yield* sql`SELECT id FROM reentrant_probe`).toEqual([{ id: 1 }])
    }).pipe(Effect.provide(synchronousLayer({
      filename: ":memory:", disableWAL: true, checkpointOnClose: false, acquireTimeoutMs: 5_000,
    }))),
  ))
}, 15_000)

test("SQLite semaphore wait is bounded and timed-out takers never release another Session's permit", async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* Client.SqlClient
      yield* sql`CREATE TABLE acquire_timeout_probe(id INTEGER PRIMARY KEY)`
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const transaction = yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO acquire_timeout_probe(id) VALUES(1)`
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return yield* Effect.fail("rollback")
      })).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      const began = performance.now()
      const timedOut = yield* Effect.exit(sql`INSERT INTO acquire_timeout_probe(id) VALUES(2)`)
      expect(Exit.isFailure(timedOut)).toBe(true)
      expect(performance.now() - began).toBeLessThan(750)
      // The blocked attempt is gone, but its timeout must not release the
      // active transaction's connection permit or sneak a write into it.
      let completed = false
      const next = yield* sql`INSERT INTO acquire_timeout_probe(id) VALUES(3)`.pipe(
        Effect.tap(() => Effect.sync(() => { completed = true })),
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.sleep(10)
      expect(completed).toBe(false)
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(transaction))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.join(next))).toBe(true)
      expect(yield* sql`SELECT id FROM acquire_timeout_probe ORDER BY id`).toEqual([{ id: 3 }])
    }).pipe(Effect.provide(synchronousLayer({
      filename: ":memory:", disableWAL: true, checkpointOnClose: false, acquireTimeoutMs: 90,
    }))),
  ))
}, 15_000)

test("50 concurrent writers remain outside a peer's rolled-back transaction", async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* Client.SqlClient
      yield* sql`CREATE TABLE many_writers(id INTEGER PRIMARY KEY)`
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const owner = yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO many_writers VALUES(-1)`
        yield* Deferred.succeed(ready, undefined)
        yield* Deferred.await(release)
        return yield* Effect.fail("rollback owner only")
      })).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(ready)
      let completed = 0
      const competing = yield* Effect.forEach(
        Array.from({ length: 50 }, (_, index) => index),
        (index) => sql`INSERT INTO many_writers VALUES(${index + 1})`.pipe(
          Effect.tap(() => Effect.sync(() => { completed++ })),
        ),
        { concurrency: 50, discard: true },
      ).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Effect.sleep(25)
      expect(completed).toBe(0)
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(owner))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.join(competing))).toBe(true)
      const rows = yield* sql`SELECT count(*) AS count, min(id) AS minID, max(id) AS maxID FROM many_writers`
      expect(rows).toEqual([{ count: 50, minID: 1, maxID: 50 }])
    }).pipe(Effect.provide(synchronousLayer({
      filename: ":memory:", disableWAL: true, checkpointOnClose: false,
    }))),
  ))
}, 15_000)

test("interrupting a blocked statement detaches its waiter without leaking an acquired SQL permit", async () => {
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* Client.SqlClient
      yield* sql`CREATE TABLE cancelled_waiter(id INTEGER PRIMARY KEY)`
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const transaction = yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO cancelled_waiter VALUES(1)`
        yield* Deferred.succeed(ready, undefined)
        yield* Deferred.await(release)
        return yield* Effect.fail("rollback")
      })).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(ready)
      const interrupted = yield* sql`INSERT INTO cancelled_waiter VALUES(2)`.pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.sleep(5)
      yield* Fiber.interrupt(interrupted)
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(transaction))).toBe(true)
      yield* sql`INSERT INTO cancelled_waiter VALUES(3)`
      expect(yield* sql`SELECT id FROM cancelled_waiter ORDER BY id`).toEqual([{ id: 3 }])
    }).pipe(Effect.provide(synchronousLayer({
      filename: ":memory:", disableWAL: true, checkpointOnClose: false,
    }))),
  ))
}, 15_000)