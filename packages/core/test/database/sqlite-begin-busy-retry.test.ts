import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { Database as NativeSQLite } from "bun:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "../../src/database/database"
import * as Client from "effect/unstable/sql/SqlClient"
import { layer as nodeLayer } from "../../src/database/sqlite.node"
import { layer as bunWorkerLayer } from "../../src/database/sqlite.bun-worker"
import { sqliteBeginRetryElapsedMs, sqliteRetryableBegin } from "../../src/database/sqlite-busy"

test("BEGIN retry gate never admits writes, COMMIT, ROLLBACK, or nested savepoints", () => {
  for (const query of ["BEGIN", "BEGIN IMMEDIATE", "begin exclusive;", " BEGIN DEFERRED TRANSACTION "]) {
    expect(sqliteRetryableBegin(query)).toBe(true)
  }
  for (const query of ["UPDATE t SET x=1", "INSERT INTO t VALUES (1)", "COMMIT", "ROLLBACK", "SAVEPOINT sp", "RELEASE sp", "BEGIN IMMEDIATE; DELETE FROM t", "SELECT 1"]) {
    expect(sqliteRetryableBegin(query)).toBe(false)
  }
})

test("SQLite BEGIN retry budgets prioritize control and foreground over maintenance", () => {
  expect(sqliteBeginRetryElapsedMs("maintenance")).toBe(350)
  expect(sqliteBeginRetryElapsedMs("control")).toBe(3_000)
  expect(sqliteBeginRetryElapsedMs("primary")).toBe(15_000)
  expect(sqliteBeginRetryElapsedMs(undefined)).toBe(15_000)
})

test("contending background WAL writer fails closed quickly and succeeds on its next explicit pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-maintenance-begin-"))
  const filename = join(directory, "work.sqlite")
  const writer = new NativeSQLite(filename)
  let held = false
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE probe(id INTEGER PRIMARY KEY)")
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sql = yield* Client.SqlClient
      const conn = yield* sql.reserve
      writer.exec("BEGIN IMMEDIATE")
      held = true
      const started = performance.now()
      const blocked = yield* Effect.exit(conn.executeUnprepared("BEGIN IMMEDIATE", [], undefined))
      const elapsed = performance.now() - started
      expect(Exit.isFailure(blocked)).toBe(true)
      expect(elapsed).toBeLessThan(1_500)
      expect(writer.query("SELECT COUNT(*) AS n FROM probe").get()).toEqual({ n: 0 })
      writer.exec("ROLLBACK")
      held = false
      yield* conn.executeUnprepared("BEGIN IMMEDIATE", [], undefined)
      yield* conn.executeUnprepared("INSERT INTO probe VALUES (1)", [], undefined)
      yield* conn.executeUnprepared("COMMIT", [], undefined)
      expect(writer.query("SELECT COUNT(*) AS n FROM probe").get()).toEqual({ n: 1 })
    }).pipe(Effect.provide(bunWorkerLayer({
      filename, permitLane: "maintenance", disableWAL: true,
      checkpointOnClose: false, timeout: 0,
    })))))
  } finally {
    if (held) try { writer.exec("ROLLBACK") } catch {}
    writer.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })
  }
}, 15_000)

test("primary BEGIN IMMEDIATE retries while another WAL connection holds writer lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-begin-busy-"))
  const filename = join(directory, "test.sqlite")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { db, controlDb } = yield* Database.Service
      const other = yield* controlDb!()
      yield* db.run("CREATE TABLE begin_retry_probe (id INTEGER PRIMARY KEY)")
      const locked = yield* Deferred.make<void>()
      const unlock = yield* Deferred.make<void>()
      const writer = yield* other.transaction((tx) => Effect.gen(function* () {
        yield* tx.run("INSERT INTO begin_retry_probe VALUES (1)")
        yield* Deferred.succeed(locked, undefined)
        yield* Deferred.await(unlock)
      }), { behavior: "immediate" }).pipe(Effect.forkScoped)
      yield* Deferred.await(locked)
      const started = performance.now()
      const competing = yield* db.transaction((tx) =>
        tx.run("INSERT INTO begin_retry_probe VALUES (2)"),
        { behavior: "immediate" },
      ).pipe(Effect.forkScoped)
      yield* Effect.sleep(300)
      yield* Deferred.succeed(unlock, undefined)
      yield* Fiber.join(writer)
      yield* Fiber.join(competing).pipe(Effect.timeout(5_000))
      expect(performance.now() - started).toBeGreaterThan(280)
      const rows = yield* db.all<{ id: number }>("SELECT id FROM begin_retry_probe ORDER BY id")
      expect(rows).toEqual([{ id: 1 }, { id: 2 }])
    }).pipe(Effect.provide(Database.layerFromPath(filename)))))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}, 20_000)

test("Node native worker BEGIN retry preserves both commits under overlapping WAL transactions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-node-begin-busy-"))
  const filename = join(directory, "test.sqlite")
  const layer = () => nodeLayer({ filename, checkpointOnClose: false, timeout: 75 })
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const sql = yield* Client.SqlClient
        yield* sql`CREATE TABLE node_begin_retry (id INTEGER PRIMARY KEY)`
      }).pipe(Effect.provide(layer()))
      const locked = yield* Deferred.make<void>()
      const unlock = yield* Deferred.make<void>()
      const writer = yield* Effect.scoped(Effect.gen(function* () {
        const sql = yield* Client.SqlClient
        const connection = yield* sql.reserve
        yield* connection.executeUnprepared("BEGIN IMMEDIATE", [], undefined)
        yield* connection.executeUnprepared("INSERT INTO node_begin_retry VALUES (1)", [], undefined)
        yield* Deferred.succeed(locked, undefined)
        yield* Deferred.await(unlock)
        yield* connection.executeUnprepared("COMMIT", [], undefined)
      })).pipe(Effect.provide(layer()), Effect.forkScoped)
      yield* Deferred.await(locked)
      const competing = yield* Effect.scoped(Effect.gen(function* () {
        const sql = yield* Client.SqlClient
        const connection = yield* sql.reserve
        yield* connection.executeUnprepared("BEGIN IMMEDIATE", [], undefined)
        yield* connection.executeUnprepared("INSERT INTO node_begin_retry VALUES (2)", [], undefined)
        yield* connection.executeUnprepared("COMMIT", [], undefined)
      })).pipe(Effect.provide(layer()), Effect.forkScoped)
      yield* Effect.sleep(350)
      yield* Deferred.succeed(unlock, undefined)
      yield* Fiber.join(writer)
      yield* Fiber.join(competing).pipe(Effect.timeout(5_000))
      const rows = yield* Effect.gen(function* () {
        const sql = yield* Client.SqlClient
        return yield* sql`SELECT id FROM node_begin_retry ORDER BY id`
      }).pipe(Effect.provide(layer()))
      expect(rows).toEqual([{ id: 1 }, { id: 2 }])
    })))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}, 20_000)

