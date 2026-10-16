/** Synthetic SQLite-only batch attribution benchmark; excludes Effect, HTTP, UI and rendering. */
import { Database } from "bun:sqlite"
import { performance } from "node:perf_hooks"

const db = new Database(":memory:")
const activities = 512
const rowsPerActivity = 120
db.exec(`
  CREATE TABLE oxp_invocation (
    id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, tool TEXT NOT NULL,
    status TEXT NOT NULL, time_started INTEGER NOT NULL, time_completed INTEGER,
    context_request_chars INTEGER, context_result_chars INTEGER
  );
  CREATE INDEX oxp_invocation_activity_started_idx ON oxp_invocation(activity_id,time_started,id);
`)
const insert = db.prepare("INSERT INTO oxp_invocation VALUES (?,?,?,?,?,?,?,?)")
db.transaction(() => {
  for (let activity = 0; activity < activities; activity++) {
    const id = `activity-${String(activity).padStart(4, "0")}`
    for (let row = 0; row < rowsPerActivity; row++)
      insert.run(`${id}-${row}`, id, "read", "success", row * 1000, row * 1000 + 50, 100 + row, 200 + row)
  }
})()

const fields = "id,activity_id,tool,status,time_started,time_completed,context_request_chars,context_result_chars"
const sequential = db.prepare(`SELECT ${fields} FROM oxp_invocation WHERE activity_id = ? ORDER BY activity_id,time_started,id`)
const median = (values: number[]) => [...values].sort((a,b) => a - b)[Math.floor(values.length / 2)]!
const results = []
for (const changed of [1, 8, 64, 256]) {
  const ids = Array.from({ length: changed }, (_, i) => `activity-${String(i).padStart(4, "0")}`)
  const placeholders = ids.map(() => "?").join(",")
  const sql = `SELECT ${fields} FROM oxp_invocation WHERE activity_id IN (${placeholders}) ORDER BY activity_id,time_started,id`
  const batched = db.prepare(sql)
  const before: number[] = []
  const after: number[] = []
  let expected = 0
  let actual = 0
  for (let round = 0; round < 19; round++) {
    let start = performance.now()
    const original = ids.flatMap((id) => sequential.all(id) as { id: string }[])
    const oldMs = performance.now() - start
    start = performance.now()
    const replacement = batched.all(...ids) as { id: string }[]
    const newMs = performance.now() - start
    if (original.length !== replacement.length || original.some((row, i) => row.id !== replacement[i]?.id))
      throw new Error(`Batched result mismatch for ${changed} activities`)
    expected = original.length
    actual = replacement.length
    if (round >= 2) {
      before.push(oldMs)
      after.push(newMs)
    }
  }
  const old = median(before)
  const next = median(after)
  results.push({
    changedActivities: changed, expectedRows: expected, actualRows: actual,
    separateQueriesMedianMs: old, batchQueryMedianMs: next, speedup: old / next,
    plan: changed === 256 ? db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...ids) : undefined,
  })
}
console.log(JSON.stringify({ kind: "synthetic-sqlite-batch", rows: activities * rowsPerActivity, rowsPerActivity, results }, null, 2))
db.close()
