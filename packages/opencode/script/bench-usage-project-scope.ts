/** Synthetic SQLite planner benchmark. Does not touch OpenFork's databases. */
import { Database } from "bun:sqlite"

const db = new Database(":memory:")
db.exec(`
  CREATE TABLE maintenance_usage (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, time_completed INTEGER NOT NULL);
  CREATE INDEX maintenance_usage_completed_idx ON maintenance_usage(time_completed);
  CREATE INDEX maintenance_usage_project_completed_idx ON maintenance_usage(project_id,time_completed);
`)
const insert = db.prepare("INSERT INTO maintenance_usage (project_id,time_completed) VALUES (?, ?)")
const records = 120_000
db.transaction(() => {
  for (let i = 0; i < records; i++) insert.run(`prj-${i % 60}`, i)
})()
const oldSQL = "SELECT id FROM maintenance_usage WHERE time_completed >= ? AND time_completed < ? AND (? IS NULL OR project_id = ?) ORDER BY time_completed ASC"
const newSQL = "SELECT id FROM maintenance_usage WHERE time_completed >= ? AND time_completed < ? AND project_id = ? ORDER BY time_completed ASC"
const oldStatement = db.prepare(oldSQL)
const newStatement = db.prepare(newSQL)
const oldPlan = db.prepare("EXPLAIN QUERY PLAN " + oldSQL).all(0, records, "prj-7", "prj-7")
const newPlan = db.prepare("EXPLAIN QUERY PLAN " + newSQL).all(0, records, "prj-7")
console.log("Previous plan:", JSON.stringify(oldPlan))
console.log("Index-friendly plan:", JSON.stringify(newPlan))
for (const [label, from, to] of [["all", 0, records], ["recent", 90_000, records]] as const) {
  const oldRows = oldStatement.all(from, to, "prj-7", "prj-7")
  const newRows = newStatement.all(from, to, "prj-7")
  if (JSON.stringify(oldRows) !== JSON.stringify(newRows)) throw new Error("SQL result mismatch")
  const bench = (fn: () => unknown) => {
    for (let i = 0; i < 5; i++) fn()
    const start = performance.now()
    for (let i = 0; i < 40; i++) fn()
    return (performance.now() - start) / 40
  }
  const before = bench(() => oldStatement.all(from, to, "prj-7", "prj-7"))
  const after = bench(() => newStatement.all(from, to, "prj-7"))
  console.log(`${label}: ${oldRows.length} matching rows; previous ${before.toFixed(3)}ms, indexed ${after.toFixed(3)}ms, ${(before/after).toFixed(2)}x`)
}
db.close()
