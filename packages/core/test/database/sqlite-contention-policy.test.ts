import { expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { Database as NativeSQLite } from "bun:sqlite"
import { existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { isSqliteBusy, retrySqliteBusyCause, sqliteBusyCode } from "../../src/database/sqlite-busy"

test("SQLite contention classifier recognizes native primary and snapshot codes", () => {
  expect(sqliteBusyCode({ code: "SQLITE_BUSY", errno: 5 })).toBe("SQLITE_BUSY")
  expect(sqliteBusyCode({ code: "SQLITE_BUSY_SNAPSHOT", errno: 517 })).toBe("SQLITE_BUSY_SNAPSHOT")
  expect(sqliteBusyCode({ reason: { cause: { errcode: 517 } } })).toBe("SQLITE_BUSY_SNAPSHOT")
  expect(isSqliteBusy(new Error("database is locked"))).toBe(true)
  expect(isSqliteBusy(new Error("database table is locked"))).toBe(true)
  expect(isSqliteBusy(new Error("User document discussed SQLITE_BUSY"))).toBe(false)
  expect(isSqliteBusy({ code: "SQLITE_CONSTRAINT", message: "constraint failed" })).toBe(false)
  const cycle: { cause?: unknown } = {}
  cycle.cause = cycle
  expect(sqliteBusyCode(cycle)).toBeUndefined()
  const hostile = Object.defineProperties({}, {
    code: { get() { throw new Error("code getter exploded") } },
    message: { get() { throw new Error("message getter exploded") } },
    cause: { value: { code: "SQLITE_BUSY_SNAPSHOT" } },
  })
  expect(sqliteBusyCode(hostile)).toBe("SQLITE_BUSY_SNAPSHOT")
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  expect(sqliteBusyCode(revoked.proxy)).toBeUndefined()
})

test("SQLite native lock errors classify via code without parsing arbitrary text", () => {
  const a = new NativeSQLite(":memory:")
  try {
    a.exec("CREATE TABLE probe(x INTEGER UNIQUE)")
    a.exec("INSERT INTO probe VALUES (1)")
    let cause: unknown
    try { a.exec("INSERT INTO probe VALUES (1)") } catch (error) { cause = error }
    expect(isSqliteBusy(cause)).toBe(false)
  } finally {
    a.close()
  }
})

test("real WAL writer contention retries and commits exactly once", async () => {
  const filename = join(tmpdir(), `openfork-busy-${randomUUID()}.db`)
  const owner = new NativeSQLite(filename)
  let contender: NativeSQLite | undefined
  let locked = false
  try {
    owner.exec("PRAGMA journal_mode=WAL")
    owner.exec("CREATE TABLE probe(value TEXT NOT NULL)")
    contender = new NativeSQLite(filename)
    contender.exec("PRAGMA busy_timeout=0")
    owner.exec("BEGIN IMMEDIATE")
    locked = true
    owner.exec("INSERT INTO probe VALUES ('owner')")
    let attempts = 0
    const second = contender
    const pending = Effect.runPromise(retrySqliteBusyCause(
      () => Effect.sync(() => {
        attempts++
        second.exec("INSERT INTO probe VALUES ('contender')")
        return attempts
      }),
      { maxElapsedMs: 2_000, delayMs: 10, maxDelayMs: 35 },
    ))
    await Bun.sleep(90)
    expect(attempts).toBeGreaterThan(1)
    owner.exec("COMMIT")
    locked = false
    await pending
    expect(owner.query("SELECT value FROM probe ORDER BY value").all()).toEqual([
      { value: "contender" },
      { value: "owner" },
    ])
  } finally {
    if (locked) owner.exec("ROLLBACK")
    contender?.close()
    owner.close()
    for (const path of [filename, filename + "-wal", filename + "-shm"]) {
      if (existsSync(path)) unlinkSync(path)
    }
  }
})

test("bounded retries replay only busy attempts, not unrelated errors or successful work", async () => {
  let attempts = 0
  const success = await Effect.runPromise(retrySqliteBusyCause(
    () => Effect.sync(() => {
      attempts++
      if (attempts <= 2) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      return attempts
    }),
    { maxElapsedMs: 1500, delayMs: 1, maxDelayMs: 2 },
  ))
  expect(success).toBe(3)
  expect(attempts).toBe(3)

  let rejectedAttempts = 0
  const exit = await Effect.runPromiseExit(retrySqliteBusyCause(
    () => Effect.sync(() => {
      rejectedAttempts++
      throw Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT" })
    }),
    { maxElapsedMs: 1000, delayMs: 1 },
  ))
  expect(exit._tag).toBe("Failure")
  expect(rejectedAttempts).toBe(1)
})

test("busy retry deadlines remain bounded under malformed delays and repeated contention", async () => {
  let attempts = 0
  const started = performance.now()
  const result = await Effect.runPromiseExit(retrySqliteBusyCause(
    () => Effect.sync(() => {
      attempts++
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
    }),
    { maxElapsedMs: 35, delayMs: Number.NaN, maxDelayMs: Number.POSITIVE_INFINITY },
  ))
  expect(Exit.isFailure(result)).toBe(true)
  expect(attempts).toBeGreaterThanOrEqual(1)
  expect(attempts).toBeLessThan(5)
  expect(performance.now() - started).toBeLessThan(1_000)
})

test("busy retry sleeps remain interruptible and do not monopolize the Effect scheduler", async () => {
  let attempts = 0
  const exited = await Effect.runPromise(Effect.gen(function* () {
    const worker = yield* Effect.forkChild(retrySqliteBusyCause(
      () => Effect.sync(() => {
        attempts++
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      }),
      { maxElapsedMs: 30_000, delayMs: 100, maxDelayMs: 100 },
    ))
    yield* Effect.sleep(15)
    yield* Fiber.interrupt(worker)
    return yield* Fiber.await(worker)
  }))
  expect(Exit.isFailure(exited)).toBe(true)
  expect(attempts).toBeLessThan(3)
})