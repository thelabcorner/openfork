import { expect, test } from "bun:test"
import { Database as NativeSQLite } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteBunWorkerClient } from "../../src/database/sqlite-bun-worker-client"
import { layer as sqliteLayer } from "../../src/database/sqlite.bun-worker"
import { Effect, Exit, Fiber } from "effect"
import * as Client from "effect/unstable/sql/SqlClient"

test("Bun SQLite worker preserves event-loop progress, integer precision, and transaction isolation", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-sqlite-bun-worker-"))
  const filename = join(folder, "probe.sqlite")
  const worker = new SqliteBunWorkerClient({ filename, disableWAL: true, checkpointOnClose: false })
  try {
    await worker.ready
    await worker.request({
      kind: "query", query: "CREATE TABLE probe (id INTEGER PRIMARY KEY, data BLOB)", params: [], arrays: false, safeIntegers: false,
    })
    const inserted = await worker.request<any[]>({
      kind: "query", query: "INSERT INTO probe(id, data) VALUES (?, ?)", params: [1, new Uint8Array([0, 128, 255])], arrays: false, safeIntegers: false,
    })
    expect(inserted).toEqual([])
    const rows = await worker.request<any[]>({
      kind: "query", query: "SELECT 9007199254740993 AS exact, data FROM probe WHERE id = ?", params: [1], arrays: true, safeIntegers: true,
    })
    expect(rows[0][0]).toBe(9007199254740993n)
    expect(Array.from(rows[0][1])).toEqual([0, 128, 255])
    let ticks = 0
    const interval = setInterval(() => ticks++, 0)
    try {
      const query = await worker.request<any[]>({
        kind: "query",
        query: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 1500000) SELECT sum(x) AS total FROM n",
        params: [], arrays: false, safeIntegers: false,
      })
      expect(query[0].total).toBe(1_125_000_750_000)
    } finally { clearInterval(interval) }
    expect(ticks).toBeGreaterThan(0)

    await worker.request({ kind: "query", query: "BEGIN IMMEDIATE", params: [], arrays: false, safeIntegers: false })
    await worker.request({ kind: "query", query: "INSERT INTO probe(id, data) VALUES(2, x'00')", params: [], arrays: false, safeIntegers: false })
    await worker.request({ kind: "query", query: "ROLLBACK", params: [], arrays: false, safeIntegers: false })
    const peer = new NativeSQLite(filename)
    try {
      expect(peer.query("SELECT count(*) AS n FROM probe").get()).toEqual({ n: 1 })
    } finally { peer.close() }
  } finally {
    await worker.close()
    await rm(folder, { recursive: true, force: true })
  }
}, 25_000)

test("a long native SQLite busy wait cannot starve its own lock-releasing parent event loop", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-sqlite-async-contention-"))
  const filename = join(folder, "writer.sqlite")
  const owner = new NativeSQLite(filename)
  let worker: SqliteBunWorkerClient | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    owner.run("PRAGMA journal_mode = WAL")
    owner.run("CREATE TABLE write_probe(id INTEGER PRIMARY KEY)")
    worker = new SqliteBunWorkerClient({ filename, disableWAL: true, checkpointOnClose: false })
    await worker.ready
    await worker.request({ kind: "query", query: "PRAGMA busy_timeout = 5000", params: [], arrays: false, safeIntegers: false })
    owner.run("BEGIN IMMEDIATE")
    let released = false
    timer = setTimeout(() => {
      owner.run("COMMIT")
      released = true
    }, 300)
    const started = performance.now()
    await worker.request({ kind: "query", query: "INSERT INTO write_probe VALUES (1)", params: [], arrays: false, safeIntegers: false })
    const elapsed = performance.now() - started
    expect(released).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(2400)
    expect(owner.query("SELECT count(*) AS n FROM write_probe").get()).toEqual({ n: 1 })
  } finally {
    if (timer) clearTimeout(timer)
    try { owner.run("ROLLBACK") } catch {}
    if (worker) await worker.close()
    owner.close()
    await rm(folder, { recursive: true, force: true })
  }
}, 15_000)

test("Bun worker Effect SQL holds the connection until rollback and releases after interruption", async () => {
  const folder = await mkdtemp(join(tmpdir(), "openfork-sqlite-bun-effect-"))
  const filename = join(folder, "effect.sqlite")
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* Client.SqlClient
          yield* sql`CREATE TABLE probe(id INTEGER PRIMARY KEY)`
          let release!: () => void
          const gate = new Promise<void>((resolve) => (release = resolve))
          let started!: () => void
          const ready = new Promise<void>((resolve) => (started = resolve))
          const transaction = yield* Effect.exit(sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO probe VALUES(1)`
              started()
              yield* Effect.promise(() => gate)
              return yield* Effect.fail("rollback")
            }),
          )).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.promise(() => ready)
          let completed = false
          const outside = yield* Effect.exit(
            sql`INSERT INTO probe VALUES(2)`.pipe(Effect.tap(() => Effect.sync(() => { completed = true }))),
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          expect(completed).toBe(false)
          release()
          expect(Exit.isFailure(yield* Fiber.join(transaction))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.join(outside))).toBe(true)
          expect(yield* sql`SELECT id FROM probe ORDER BY id`).toEqual([{ id: 2 }])
        }).pipe(Effect.provide(sqliteLayer({ filename, disableWAL: true, checkpointOnClose: false }))),
      ),
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}, 25_000)