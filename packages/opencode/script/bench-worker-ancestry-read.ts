/**
 * Query-shape benchmark, NOT an end-to-end worker execution benchmark.
 * Bounded, disposable SQLite fixture only. Never opens OpenFork's user DB.
 * Run: bun script/bench-worker-ancestry-read.ts
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const directory = mkdtempSync(join(tmpdir(), "openfork-ancestor-bench-"))
const db = new Database(join(directory, "fixture.db"), { create: true })
const parents = new Map<string, string | undefined>()
const rounds = 8
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2
}
try {
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, summary_diffs TEXT)")
  const insert = db.query("INSERT INTO session(id, parent_id, summary_diffs) VALUES(?, ?, ?)")
  const largeField = "irrelevant summary data ".repeat(128)
  for (let i = 0; i < 12; i++) {
    const id = `ancestor_${i}`
    insert.run(id, i ? `ancestor_${i - 1}` : null, largeField)
    parents.set(id, i ? `ancestor_${i - 1}` : undefined)
  }
  for (let i = 0; i < 1000; i++) {
    const id = `leaf_${i}`
    insert.run(id, "ancestor_11", largeField)
    parents.set(id, "ancestor_11")
  }
  const one = db.query("SELECT * FROM session WHERE id = ?")
  // Experimental single-query shape: bounded to the same 64-level traversal,
  // deduplicating at output. Do not deploy without cycle/depth and tail-latency gates.
  const recursive = db.query(`
    WITH RECURSIVE walk(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM session WHERE id IN (SELECT value FROM json_each(?))
      UNION ALL
      SELECT parent.id, parent.parent_id, walk.depth + 1
      FROM session parent JOIN walk ON parent.id = walk.parent_id
      WHERE walk.depth < 63
    )
    SELECT DISTINCT id, parent_id FROM walk
  `)
  // Probe deduplicating shared ancestors *inside* SQLite. This variant has
  // no 64-level bound, so it is comparison-only and must NOT replace production
  // traversal without a rigorously bounded, cycle/depth-equivalent design.
  const recursiveDedup = db.query(`
    WITH RECURSIVE walk(id, parent_id) AS (
      SELECT id, parent_id FROM session WHERE id IN (SELECT value FROM json_each(?))
      UNION
      SELECT parent.id, parent.parent_id
      FROM session parent JOIN walk ON parent.id = walk.parent_id
    )
    SELECT id, parent_id FROM walk
  `)
  // Degenerate graph safety: the bounded query must terminate cycles and
  // must NEVER fetch the 65th distinct node of a 70-deep chain.
  for (let index = 0; index < 70; index++) {
    insert.run(`deep_${index}`, index ? `deep_${index - 1}` : null, largeField)
  }
  insert.run("cycle_a", "cycle_b", largeField)
  insert.run("cycle_b", "cycle_a", largeField)
  const deepRows = recursive.all(JSON.stringify(["deep_69"])) as { id: string }[]
  if (deepRows.length !== 64 || deepRows.some((row) => row.id === "deep_5")) {
    throw new Error("Recursive ancestry escaped the 64-level bound")
  }
  const cycleRows = recursive.all(JSON.stringify(["cycle_a"])) as { id: string }[]
  if (cycleRows.length !== 2 || recursiveDedup.all(JSON.stringify(["cycle_a"])).length !== 2) {
    throw new Error("Recursive ancestry failed cycle termination or deduplication")
  }
  const measure = (ids: string[], batched: "legacy" | "batched" | "recursive" | "recursiveDedup") => {
    const resolved = new Map<string, string | undefined>()
    let queries = 0
    if (batched === "recursive" || batched === "recursiveDedup") {
      const rows = (batched === "recursive" ? recursive : recursiveDedup).all(JSON.stringify(ids)) as { id: string; parent_id: string | null }[]
      queries++
      for (const row of rows) resolved.set(row.id, row.parent_id ?? undefined)
    } else if (batched === "batched") {
      let frontier = new Set(ids)
      for (let depth = 0; depth < 64 && frontier.size > 0; depth++) {
        const missing = [...frontier].filter((id) => !resolved.has(id))
        for (let offset = 0; offset < missing.length; offset += 400) {
          const page = missing.slice(offset, offset + 400)
          const params = page.map(() => "?").join(",")
          const rows = db.query(`SELECT id, parent_id FROM session WHERE id IN (${params})`).all(...page) as { id: string; parent_id: string | null }[]
          queries++
          for (const row of rows) resolved.set(row.id, row.parent_id ?? undefined)
          for (const id of page) if (!resolved.has(id)) resolved.set(id, undefined)
        }
        const next = new Set<string>()
        for (const id of frontier) {
          const parent = resolved.get(id)
          if (parent && !resolved.has(parent)) next.add(parent)
        }
        frontier = next
      }
    } else {
      for (const start of ids) {
        let current: string | undefined = start
        const seen = new Set<string>()
        for (let depth = 0; current && depth < 64 && !seen.has(current); depth++) {
          seen.add(current)
          if (!resolved.has(current)) {
            const row = one.get(current) as { parent_id: string | null } | null
            queries++
            resolved.set(current, row?.parent_id ?? undefined)
          }
          current = resolved.get(current)
        }
      }
    }
    if (resolved.size !== ids.length + 12) throw new Error(`Unexpected ancestry cardinality ${resolved.size}`)
    for (const [id, parent] of resolved) if (parents.get(id) !== parent) throw new Error(`Parent projection mismatch: ${id}`)
    return queries
  }
  const report = []
  for (const size of [1, 10, 25, 50, 100, 400, 1000]) {
    const ids = Array.from({ length: size }, (_, i) => `leaf_${i}`)
    const times = {
      legacy: [] as number[],
      batched: [] as number[],
      recursive: [] as number[],
      recursiveDedup: [] as number[],
    }
    const queryCounts = { legacy: 0, batched: 0, recursive: 0, recursiveDedup: 0 }
    for (let run = 0; run < rounds; run++) {
      const sequence: readonly (keyof typeof times)[] = run % 2
        ? ["recursiveDedup", "recursive", "batched", "legacy"]
        : ["legacy", "batched", "recursive", "recursiveDedup"]
      for (const strategy of sequence) {
        const start = performance.now()
        const count = measure(ids, strategy)
        times[strategy].push(performance.now() - start)
        queryCounts[strategy] = count
      }
    }
    const a = median(times.legacy), b = median(times.batched), c = median(times.recursive)
    const d = median(times.recursiveDedup)
    report.push({ leaves: size, originalQueries: queryCounts.legacy, batchQueries: queryCounts.batched,
      recursiveQueries: queryCounts.recursive, originalMs: +a.toFixed(3), batchMs: +b.toFixed(3),
      recursiveMs: +c.toFixed(3), recursiveDedupMs: +d.toFixed(3),
      ratio: +(a / b).toFixed(2), recursiveRatio: +(b / c).toFixed(2), recursiveDedupRatio: +(b / d).toFixed(2) })
  }
  console.log(JSON.stringify({ benchmark: "nested-worker-ancestry-sql-shape", rounds, report }, null, 2))
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}