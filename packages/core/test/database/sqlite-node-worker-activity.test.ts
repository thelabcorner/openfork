import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import * as Client from "effect/unstable/sql/SqlClient"
import { SqliteWorkerClient } from "../../src/database/sqlite-worker-client"
import { layer as nodeLayer } from "../../src/database/sqlite.node"

test("native SQLite worker reports its executing statement through shared memory without requiring worker replies", async () => {
  const worker = new SqliteWorkerClient({
    filename: ":memory:",
    disableWAL: true,
    checkpointOnClose: false,
  })
  try {
    await worker.ready
    expect(worker.activitySnapshot()).toContain("workerStage=idle")
    const running = worker.request({
      kind: "query",
      query: "WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n < ?) SELECT max(n) AS max FROM nums",
      params: [4_000_000],
      arrays: false,
      safeIntegers: false,
    })
    const queued = worker.request({
      kind: "query", query: "SELECT 42 AS answer", params: [], arrays: false, safeIntegers: false,
    })
    let observed = ""
    const started = performance.now()
    while (performance.now() - started < 3_000) {
      observed = worker.activitySnapshot()
      if (observed.includes("workerStage=executing") && observed.includes("workerSql=WITH")) break
      await Bun.sleep(1)
    }
    expect(observed).toContain("workerStage=executing")
    expect(observed).toContain("workerSql=WITH")
    expect(observed).toContain("workerPending=2")
    expect(await running).toEqual([{ max: 4_000_000 }])
    expect(await queued).toEqual([{ answer: 42 }])
    expect(worker.activitySnapshot()).toContain("workerStage=idle")
    expect(worker.activitySnapshot()).toContain("workerPending=0")
  } finally {
    await worker.close()
  }
}, 15_000)

test("Node SQL permit timeout identifies the native worker's executing query, not a queued waiter", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sql = yield* Client.SqlClient
    const entered = yield* Deferred.make<void>()
    const running = yield* Effect.scoped(Effect.gen(function* () {
      const connection = yield* sql.reserve
      yield* Deferred.succeed(entered, undefined)
      return yield* connection.executeUnprepared(
        "WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n < ?) SELECT max(n) AS max FROM nums",
        [4_000_000],
        undefined,
      )
    })).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* Effect.sleep("15 millis")
    const timeout = yield* Effect.exit(sql`SELECT 42 AS queued`)
    expect(Exit.isFailure(timeout)).toBe(true)
    if (Exit.isFailure(timeout)) {
      const detail = JSON.stringify(timeout.cause)
      expect(detail).toContain("workerStage=executing")
      expect(detail).toContain("workerSql=WITH")
      expect(detail).toContain("sql=WITH")
      expect(detail).toContain("sqlInFlight=1")
      expect(detail).toMatch(/sqlHash=[a-f0-9]{8}/)
    }
    expect(yield* Fiber.join(running)).toEqual([{ max: 4_000_000 }])
    expect(yield* sql`SELECT 42 AS recovered`).toEqual([{ recovered: 42 }])
  }).pipe(Effect.provide(nodeLayer({
    filename: ":memory:", disableWAL: true, checkpointOnClose: false,
    acquireTimeoutMs: 80, permitLane: "primary",
  })))))
}, 15_000)