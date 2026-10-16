/**
 * Read-only forensic tool. Extract fingerprints of SQL already present in
 * developer logs; never print SQL, parameter values, or source spans.
 */
import { readFileSync } from "node:fs"
import { sqliteQueryShape } from "@opencode-ai/core/database/sqlite-query-shape"
const filename = process.argv[2]
if (!filename) throw new Error("Usage: bun run script/inspect-sql-logs.ts <logfile>")
const lines = readFileSync(filename, "utf8").split(/\r?\n/)
const stats = new Map<string, { hash: string; len: number; shape: string; count: number }>()
let count = 0
const hash = (query: string) => {
  let value = 2166136261
  const sample = (index: number) => {
    value ^= query.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  const limit = Math.min(query.length, 2048)
  for (let i = 0; i < limit; i++) sample(i)
  if (query.length > limit) {
    for (let i = query.length - Math.min(512, query.length - limit); i < query.length; i++) sample(i)
  }
  value ^= query.length
  return (value >>> 0).toString(16).padStart(8, "0")
}
for (const line of lines) {
  let position = 0
  while ((position = line.indexOf("Failed query: ", position)) >= 0) {
    const start = position + "Failed query: ".length
    const end = line.indexOf("\\nparams:", start)
    if (end < 0) break
    const raw = line.slice(start, end)
    let sql: string
    try { sql = JSON.parse('"' + raw + '"') }
    catch { position = end + 1; continue }
    const fingerprint = hash(sql)
    const len = sql.length
    const key = fingerprint + ":" + len
    const stat = stats.get(key)
    if (stat) stat.count++
    else stats.set(key, { hash: fingerprint, len, shape: sqliteQueryShape(sql), count: 1 })
    count++
    position = end + 1
  }
}
const suspect = new Set(["c2b111a6", "0bbba6a9"])
const sorted = [...stats.values()].sort((a,b) => {
  const distance = (x: typeof a) => Math.min(Math.abs(x.len - 1065), Math.abs(x.len - 1001))
  return distance(a) - distance(b) || b.count - a.count
})
console.log(JSON.stringify({
  scanned: count, distinct: stats.size,
  exactFingerprint: sorted.filter(x => suspect.has(x.hash)),
  nearestLength: sorted.slice(0, 30),
}, null, 2))
