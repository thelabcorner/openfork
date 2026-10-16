import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { Database } from "../../src/database/database"
import { RuntimeOwner } from "../../src/runtime-owner"
import { RuntimeOwnerTable } from "../../src/runtime-owner.sql"

test("RuntimeOwner heartbeat admission survives a pinned primary SELECT transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-control-lane-"))
  const filename = join(directory, "control.sqlite")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { db, readDb, controlDb } = yield* Database.Service
      expect(controlDb).toBeDefined()
      yield* db.run(sql`CREATE TABLE control_probe (id INTEGER PRIMARY KEY)`)
      yield* db.run(sql`INSERT INTO control_probe (id) VALUES (1)`)

      // A SELECT on the primary connection can retain its single permit
      // without reserving SQLite's WAL writer slot. Previously ensureRow
      // queued behind that SELECT and failed after the 30s permit deadline.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const pinned = yield* db.transaction((tx) =>
        Effect.gen(function* () {
          expect(yield* tx.get<{ id: number }>(sql`SELECT id FROM control_probe WHERE id = 1`)).toEqual({ id: 1 })
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }), { behavior: "deferred" },
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const ownerID = "runtime-owner:control-lane-test" as RuntimeOwner.ID
      const owner = yield* RuntimeOwner.make({ id: ownerID, heartbeatIntervalMs: 60_000 })
      const start = performance.now()
      const admitted = yield* owner.retain.pipe(Effect.timeout(2_000), Effect.exit)
      const duration = performance.now() - start

      // Always unpin the primary reader before asserting, including on error.
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(pinned)
      expect(Exit.isSuccess(admitted)).toBe(true)
      expect(duration).toBeLessThan(2_000)
      if (Exit.isSuccess(admitted)) yield* admitted.value.release
      const row = yield* readDb.select().from(RuntimeOwnerTable).where(eq(RuntimeOwnerTable.id, ownerID)).get()
      expect(row?.id).toBe(ownerID)

      const control = yield* controlDb!()
      expect(control).not.toBe(db)
      expect(control).not.toBe(readDb)
      expect(yield* controlDb!()).toBe(control)
      expect(yield* control.get<{ query_only: number }>("PRAGMA query_only")).toEqual({ query_only: 0 })
    }).pipe(Effect.provide(Database.layerFromPath(filename)))))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}, 30_000)

test("in-memory control lane aliases the primary database", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { db, controlDb } = yield* Database.Service
    expect(controlDb).toBeDefined()
    expect(yield* controlDb!()).toBe(db)
  }).pipe(Effect.provide(Database.layerFromPath(":memory:")))))
}, 15_000)

test("control-plane busy retries yield to an actual WAL writer instead of blocking the event loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-control-writer-"))
  const filename = join(directory, "control.sqlite")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { db, readDb, controlDb } = yield* Database.Service
      // Initializing the control lane before taking the writer lock ensures
      // this test exercises SQLite busy handling, not resource construction.
      yield* controlDb!()
      yield* db.run(sql`CREATE TABLE writer_guard (id INTEGER PRIMARY KEY)`)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const writer = yield* db.transaction((tx) => Effect.gen(function* () {
        yield* tx.run(sql`INSERT INTO writer_guard VALUES (1)`)
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }), { behavior: "immediate" }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const ownerID = "runtime-owner:busy-control-test" as RuntimeOwner.ID
      const owner = yield* RuntimeOwner.make({ id: ownerID, heartbeatIntervalMs: 60_000 })
      const retaining = yield* owner.retain.pipe(Effect.forkScoped)
      const tick = performance.now()
      yield* Effect.sleep(120)
      const elapsed = performance.now() - tick
      // In Bun, synchronous SQLite busy waiting on the app thread can starve
      // the fiber that is responsible for releasing the writer transaction.
      expect(elapsed).toBeLessThan(800)

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(writer)
      const retained = yield* Fiber.join(retaining).pipe(Effect.timeout(2_000))
      expect((yield* readDb.select().from(RuntimeOwnerTable).where(eq(RuntimeOwnerTable.id, ownerID)).get())?.id)
        .toBe(ownerID)
      yield* retained.release
    }).pipe(Effect.provide(Database.layerFromPath(filename)))))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}, 30_000)
