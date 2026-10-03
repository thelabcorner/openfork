import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Client from "effect/unstable/sql/SqlClient"
import { layer } from "../../src/database/sqlite.node"
import { SqliteWorkerClient } from "../../src/database/sqlite-worker-client"

const directory = mkdtempSync(join(tmpdir(), `openfork-sqlite-worker-${process.pid}-`))
const filename = join(directory, "worker.db")
process.once("exit", () => rmSync(directory, { recursive: true, force: true }))

// This query performs enough native SQLite work to overlap a parent-thread
// heartbeat. The assertion is progress-based rather than a machine-time limit.
const worker = new SqliteWorkerClient({ filename, disableWAL: true })
await worker.ready
let heartbeats = 0
const heartbeat = setInterval(() => heartbeats++, 0)
try {
  const result = (await worker.request({
    kind: "query",
    query:
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 2000000) SELECT sum(x) AS total FROM n",
    params: [],
    arrays: false,
    safeIntegers: false,
  })) as Array<{ total: number }>
  assert.equal(result[0]?.total, 2_000_001_000_000)
} finally {
  clearInterval(heartbeat)
  await worker.close()
}
assert.ok(heartbeats > 0, "the Node parent event loop should progress while SQLite runs in its worker")

// Structured-clone boundary must preserve exact integer and byte values, and
// array mode must remain independent from object-row statement cache state.
const valuesWorker = new SqliteWorkerClient({ filename, disableWAL: true })
try {
  const blob = new Uint8Array([0, 17, 128, 255])
  const rows = (await valuesWorker.request({
    kind: "query",
    query: "SELECT 9007199254740993 AS exact, ? AS bytes",
    params: [blob],
    arrays: true,
    safeIntegers: true,
  })) as Array<[bigint, Uint8Array]>
  assert.equal(rows[0]?.[0], 9007199254740993n)
  assert.deepEqual(Array.from(rows[0]?.[1] ?? []), Array.from(blob))
} finally {
  let secondCloseSettled = false
  const firstClose = valuesWorker.close()
  const secondClose = valuesWorker.close().then(() => {
    secondCloseSettled = true
  })
  await Promise.resolve()
  assert.equal(secondCloseSettled, false, "every concurrent close caller should await worker shutdown")
  await Promise.all([firstClose, secondClose])
}

const layerProgram = Effect.scoped(
  Effect.gen(function* () {
    const sql = yield* Client.SqlClient
    yield* sql`CREATE TABLE work (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`

    let transactionStarted!: () => void
    const transactionReady = new Promise<void>((resolve) => (transactionStarted = resolve))
    let allowRollback!: () => void
    const rollbackGate = new Promise<void>((resolve) => (allowRollback = resolve))
    let competingStatementStarted!: () => void
    const competingReady = new Promise<void>((resolve) => (competingStatementStarted = resolve))

    const transaction = sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO work VALUES (1, 'transaction')`
        yield* Effect.promise(() => {
          transactionStarted()
          return rollbackGate
        })
        return yield* Effect.fail("rollback")
      }),
    )
    const txFiber = yield* Effect.exit(transaction).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.promise(() => transactionReady)

    const competing = Effect.gen(function* () {
      yield* Effect.promise(() => {
        competingStatementStarted()
        return Promise.resolve()
      })
      yield* sql`INSERT INTO work VALUES (2, 'outside')`
    })
    const outsideFiber = yield* Effect.exit(competing).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.promise(() => competingReady)
    yield* Effect.yieldNow
    allowRollback()

    const txExit = yield* Fiber.join(txFiber)
    const outsideExit = yield* Fiber.join(outsideFiber)
    assert.ok(Exit.isFailure(txExit), "transaction should roll back on failure")
    assert.ok(Exit.isSuccess(outsideExit), `the competing statement should run after rollback: ${JSON.stringify(outsideExit)}`)
    const rows = (yield* sql`SELECT id, value FROM work ORDER BY id`) as Array<{ id: number; value: string }>
    assert.deepEqual(rows, [{ id: 2, value: "outside" }])

  }).pipe(Effect.provide(layer({ filename, disableWAL: true }))),
)

await Effect.runPromise(layerProgram)

// Abort from the JS runtime after the recursive SQL request has been posted.
// The SQL Effect is uninterruptible until the worker acknowledges it, so the
// transaction scope must then roll back before runPromise rejects.
let queryAboutToStart!: () => void
const queryStarted = new Promise<void>((resolve) => (queryAboutToStart = resolve))
const abortController = new AbortController()
const interruptedProgram = Effect.scoped(
  Effect.gen(function* () {
    const sql = yield* Client.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO work VALUES (9, 'must-rollback')`
        yield* Effect.promise(() => {
          queryAboutToStart()
          return Promise.resolve()
        })
        yield* sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 10000000) SELECT sum(x) FROM n`
        return yield* Effect.never
      }),
    )
  }).pipe(Effect.provide(layer({ filename, disableWAL: true }))),
)
const interruptedRun = Effect.runPromise(interruptedProgram, { signal: abortController.signal })
await queryStarted
setImmediate(() => abortController.abort())
await assert.rejects(interruptedRun)

const verifyRollback = new SqliteWorkerClient({ filename, disableWAL: true })
try {
  const rows = (await verifyRollback.request({
    kind: "query",
    query: "SELECT id FROM work WHERE id = 9",
    params: [],
    arrays: false,
    safeIntegers: false,
  })) as Array<{ id: number }>
  assert.deepEqual(rows, [], "interrupted transaction must roll back after native SQL settles")
} finally {
  await verifyRollback.close()
}
console.log("sqlite worker RPC fixture passed")
