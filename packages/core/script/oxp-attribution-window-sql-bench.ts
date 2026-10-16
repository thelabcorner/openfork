/** Reproducible synthetic SQLite-only attribution-window benchmark (no HTTP/UI). */
import { Database } from "bun:sqlite"
import { performance } from "node:perf_hooks"

const db = new Database(":memory:")
const count = 80_000
db.exec(`
  CREATE TABLE oxp_invocation (
    id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, tool TEXT NOT NULL,
    status TEXT NOT NULL, time_started INTEGER NOT NULL, time_completed INTEGER,
    context_request_chars INTEGER, context_request_source TEXT, context_request_schema TEXT,
    context_result_chars INTEGER, context_result_source TEXT, context_result_schema TEXT
  );
  CREATE INDEX oxp_invocation_started_idx ON oxp_invocation(time_started);
  CREATE INDEX oxp_invocation_activity_started_idx ON oxp_invocation(activity_id, time_started, id);
`)
const insert = db.prepare(`INSERT INTO oxp_invocation (id,activity_id,tool,status,time_started,time_completed,
  context_request_chars,context_result_chars) VALUES (?,?,?,?,?,?,?,?)`)
db.transaction(() => {
  for (let i = 0; i < count; i++) insert.run(
    `i${i}`, `activity${String(i % 600).padStart(4, "0")}`, "read", "success",
    i * 60_000, i * 60_000 + 200, 300 + (i % 11), 400 + (i % 23),
  )
})()

const columns = `id,activity_id,tool,status,time_started,time_completed,context_request_chars,
  context_request_source,context_request_schema,context_result_chars,context_result_source,context_result_schema`
const oldSQL = `SELECT ${columns} FROM oxp_invocation ORDER BY activity_id,time_started,id`
const newSQL = `SELECT ${columns} FROM oxp_invocation WHERE time_started >= ? AND time_started <= ? ORDER BY activity_id,time_started,id`
const full = db.prepare(oldSQL)
const bounded = db.prepare(newSQL)
const since = (count - 1440) * 60_000
const until = (count - 1) * 60_000
const oldSamples: number[] = []
const newSamples: number[] = []
let selectedRows = 0
for (let i = 0; i < 17; i++) {
  let start = performance.now()
  const all = full.all() as { time_started: number }[]
  const selected = all.filter((row) => row.time_started >= since && row.time_started <= until)
  oldSamples.push(performance.now() - start)
  start = performance.now()
  const ranged = bounded.all(since, until)
  newSamples.push(performance.now() - start)
  if (selected.length !== ranged.length) throw new Error("SQL range mismatch")
  selectedRows = selected.length
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const old = median(oldSamples)
const current = median(newSamples)
console.log(JSON.stringify({
  kind: "synthetic-sqlite-only", historicalRows: count, windowRows: selectedRows,
  fullScanAndFilterMedianMs: old, indexedWindowMedianMs: current,
  speedup: old / current,
  queryPlan: db.prepare(`EXPLAIN QUERY PLAN ${newSQL}`).all(since, until),
}, null, 2))
db.close()