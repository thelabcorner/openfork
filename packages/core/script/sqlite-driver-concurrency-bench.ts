/**
 * Parent event-loop vs database-lane concurrency, using disposable SQL files.
 * Run from packages/core: bun script/sqlite-driver-concurrency-bench.ts
 * No live Session, production database, network or application restart.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import * as Client from "effect/unstable/sql/SqlClient"
import { synchronousLayer } from "../src/database/sqlite.bun"
import { layer as workerLayer } from "../src/database/sqlite.bun-worker"

const folder = mkdtempSync(join(tmpdir(), "openfork-driver-concurrency-"))
const median = (values: number[]) => {
  const ordered = values.toSorted((a, b) => a - b)
  return +((ordered[(ordered.length - 1) >> 1]! + ordered[ordered.length >> 1]!) / 2).toFixed(3)
}
const width = [1, 6, 25]
const rounds = 4
const records: Array<{mode:"sync"|"worker"; queries:number; milliseconds:number; timerTicks:number; eventLoopMissed:boolean}> = []
let index = 0
try {
  for (const n of width) {
    for (let round = 0; round < rounds; round++) {
      for (const mode of round % 2 ? ["worker", "sync"] as const : ["sync", "worker"] as const) {
        const filename = join(folder, `bench-${index++}.db`)
        const layer = mode === "sync"
          ? synchronousLayer({ filename, checkpointOnClose: false })
          : workerLayer({ filename, checkpointOnClose: false })
        const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          const sql = yield* Client.SqlClient
          // Warm statement compilation and connection setup outside timings.
          yield* sql`SELECT 1 AS ready`
          const query = sql`WITH RECURSIVE n(x) AS
            (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 140000)
            SELECT sum(x) AS total FROM n`
          let ticks = 0
          const timer = setInterval(() => ticks++, 2)
          const started = performance.now()
          try {
            const results = yield* Effect.forEach(Array.from({ length: n }), () => query, { concurrency: n })
            if (results.length !== n || results.some((result) => Number(result[0]?.total) !== 9_800_070_000)) {
              throw new Error("SQLite worker/foreground query parity mismatch")
            }
            return { milliseconds: performance.now() - started, timerTicks: ticks }
          } finally {
            clearInterval(timer)
          }
        }).pipe(Effect.provide(layer))))
        records.push({mode,queries:n,...result,eventLoopMissed:result.timerTicks===0})
      }
    }
  }
  const report = width.map((n) => {
    const sync = records.filter((record) => record.queries === n && record.mode === "sync")
    const worker = records.filter((record) => record.queries === n && record.mode === "worker")
    return {
      concurrency: n,
      syncMs: median(sync.map((r) => r.milliseconds)),
      workerMs: median(worker.map((r) => r.milliseconds)),
      syncParentTicks: median(sync.map((r) => r.timerTicks)),
      workerParentTicks: median(worker.map((r) => r.timerTicks)),
    }
  })
  console.log(JSON.stringify({ benchmark:"sqlite-db-lane-parent-progress",rounds,report },null,2))
} finally {
  rmSync(folder,{recursive:true,force:true})
}