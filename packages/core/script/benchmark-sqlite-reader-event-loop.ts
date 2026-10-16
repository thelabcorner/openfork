/**
 * Reproducible microbenchmark: same CPU-intensive SELECT on Bun's main thread
 * and on OpenFork's worker-backed read lane.
 *
 * This demonstrates event-loop latency isolation, NOT SQL throughput speedup.
 * No live user DB is opened, changed, scanned, or copied.
 *
 * From packages/core: bun run script/benchmark-sqlite-reader-event-loop.ts
 */
import { Database } from "bun:sqlite"
import { SqliteBunWorkerClient } from "../src/database/sqlite-bun-worker-client"

const sql = `WITH RECURSIVE counting(n) AS (
  SELECT 0 UNION ALL SELECT n + 1 FROM counting WHERE n < 3500000
) SELECT sum(n) AS total FROM counting`
const runs = 3
const timerMs = 25
const EXPECTED = 6_125_001_750_000
const db = new Database(":memory:")
const worker = new SqliteBunWorkerClient({
  filename: ":memory:", disableWAL: true, checkpointOnClose: false,
})
await worker.ready
function median(values: number[]) {
  const sorted = [...values].sort((a,b) => a-b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
async function measure(workerBacked: boolean) {
  const queryMs: number[] = []
  const timerDelayMs: number[] = []
  for (let i = 0; i < runs; i++) {
    const began = performance.now()
    const timer = new Promise<number>((resolve) =>
      setTimeout(() => resolve(performance.now() - began), timerMs),
    )
    const result = workerBacked
      ? await worker.request<Array<{ total: number }>>({
          kind: "query", query: sql, params: [], arrays: false, safeIntegers: false,
        })
      : db.query<{total:number}, []>(sql).all()
    queryMs.push(performance.now() - began)
    if (result[0]?.total !== EXPECTED) throw Error("SQL result changed")
    timerDelayMs.push(await timer)
  }
  return {
    queryP50Ms: Math.round(median(queryMs)),
    queryMaxMs: Math.round(Math.max(...queryMs)),
    timerP50Ms: Math.round(median(timerDelayMs)),
    timerMaxMs: Math.round(Math.max(...timerDelayMs)),
    timerRequestedMs: timerMs,
  }
}
try {
  const synchronous = await measure(false)
  const asyncWorker = await measure(true)
  console.log(JSON.stringify({
    setup: "Bun Windows native :memory: SELECT, 3.5M recursive rows, 3 runs per mode",
    synchronous,
    asyncWorker,
    eventLoopTimerP50ReductionPercent: Number(
      (100 * (1 - asyncWorker.timerP50Ms / synchronous.timerP50Ms)).toFixed(1)
    ),
  }, null, 2))
} finally {
  await worker.close()
  db.close()
}
