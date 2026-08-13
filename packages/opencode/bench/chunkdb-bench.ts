/**
 * ChunkDB prototype benchmark — cold-only event.data sealer on a real DB copy.
 * Runs on BOTH runtimes: `bun bench/chunkdb-bench.ts <db>` and
 * `node --experimental-strip-types bench/chunkdb-bench.ts <db>`.
 *
 * Flow: baseline (size, EXPLAIN QUERY PLAN, hot read) -> codec microbench on
 * real sampled rows -> sealer pass (eligibility query, batch framing, ocdb_seal
 * journal) -> sealed size/coverage -> sealed cold-read timing.
 *
 * NOTE: this mutates the given DB file in place (seals eligible event rows).
 * Point it at a COPY. The D:\ backup is the sanctioned working copy.
 */
import { join } from "node:path"
import { compressText, decompressFrame, THRESHOLD, OCDBFrameError } from "@opencode-ai/core/database/json-codec"

const DB_PATH = process.argv[2]
if (!DB_PATH) {
  console.error("usage: chunkdb-bench <db-path>")
  process.exit(1)
}

// --- driver abstraction (node:sqlite | bun:sqlite) -------------------------
type Driver = {
  exec(sql: string): void
  prepare(sql: string): {
    all(...args: unknown[]): unknown[]
    get(...args: unknown[]): unknown | undefined
    run(...args: unknown[]): unknown
  }
  close(): void
  fileSizeBytes(): number
}
const isBun = typeof Bun !== "undefined"

function openDriver(path: string, readonly = false): Driver {
  if (isBun) {
    const { Database } = require("bun:sqlite")
    const db = readonly ? new Database(path, true) : new Database(path)
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => ({
        all: (...args) => db.query(sql).all(...args),
        get: (...args) => db.query(sql).get(...args),
        run: (...args) => db.query(sql).run(...args),
      }),
      close: () => db.close(),
      fileSizeBytes: () => {
        const { statSync } = require("node:fs")
        try { return statSync(path).size } catch { return 0 }
      },
    }
  }
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(path, { readOnly: readonly })
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => ({
      all: (...args) => db.prepare(sql).all(...args),
      get: (...args) => db.prepare(sql).get(...args),
      run: (...args) => db.prepare(sql).run(...args),
    }),
    close: () => db.close(),
    fileSizeBytes: () => {
      const { statSync } = require("node:fs")
      try { return statSync(path).size } catch { return 0 }
    },
  }
}

const MB = (n: number) => `${(n / 1048576).toFixed(1)}MB`

const SKIP_BASELINE = process.argv.includes("--skip-baseline")
const MAX_ROWS = (() => {
  const idx = process.argv.indexOf("--max-rows")
  if (idx === -1) return Infinity
  const n = Number(process.argv[idx + 1])
  return Number.isFinite(n) && n > 0 ? n : Infinity
})()

// --- baseline --------------------------------------------------------------
console.log(`runtime=${isBun ? "bun" : "node"}  db=${DB_PATH}`)
const db = openDriver(DB_PATH)
const fileSize = db.fileSizeBytes()
console.log(`file_size=${MB(fileSize)}`)

const eventRows = db.prepare("SELECT count(*) AS n, sum(length(data)) AS bytes, sum(CASE WHEN length(data)>=4096 THEN 1 ELSE 0 END) AS big FROM event").get() as { n: number; bytes: number; big: number }
if (!SKIP_BASELINE) console.log(`event rows=${eventRows.n} bytes=${MB(eventRows.bytes)} >=4096=${eventRows.big} (${((eventRows.big / eventRows.n) * 100).toFixed(1)}%)`)
else console.log(`event rows=${eventRows.n} bytes=${MB(eventRows.bytes)} (baseline skip: rows/plans/codec already captured)`)

// EXPLAIN QUERY PLAN identity (M1 gate) on the queries the app actually runs.
const plans: string[] = []
for (const [name, sql] of Object.entries({
  readAfter: "SELECT * FROM event WHERE aggregate_id=? AND seq>? ORDER BY seq",
  readAggregate: "SELECT * FROM event WHERE aggregate_id=? AND type IN (?) ORDER BY seq LIMIT ?",
  history: "SELECT id, time_created FROM message WHERE session_id=? ORDER BY time_created, id",
})) {
  try {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]
    plans.push(`${name}: ${rows.map((r) => r.detail).join(" | ")}`)
  } catch {
    plans.push(`${name}: (table missing — skipped)`)
  }
}
if (!SKIP_BASELINE) console.log(`query_plans:\n${plans.map((p) => "  " + p).join("\n")}`)

// Biggest aggregate + its event count (the cold-resume stress case).
const biggest = db.prepare("SELECT aggregate_id, count(*) AS n, sum(length(data)) AS bytes FROM event GROUP BY aggregate_id ORDER BY bytes DESC LIMIT 1").get() as { aggregate_id: string; n: number; bytes: number }
if (!SKIP_BASELINE) console.log(`biggest_aggregate=${biggest.aggregate_id} events=${biggest.n} bytes=${MB(biggest.bytes)}`)

// --- codec microbench on real sampled rows ---------------------------------
const samples: string[] = []
if (!SKIP_BASELINE) {
  for (const bucket of [4096, 16384, 65536, 262144, 1048576]) {
    const row = db
      .prepare("SELECT data FROM event WHERE length(data) BETWEEN ? AND ? ORDER BY random() LIMIT 1")
      .get(bucket, bucket * 4 - 1) as { data: string } | undefined
    if (row) samples.push(row.data)
  }
  console.log(`samples=${samples.length} sizes=${samples.map((s) => s.length).join(",")}`)

  function bench(name: string, fn: () => void, iterations = 200): { ms: number; perOpMs: number } {
    for (let i = 0; i < 20; i++) fn() // warmup
    const t0 = performance.now()
    for (let i = 0; i < iterations; i++) fn()
    const ms = performance.now() - t0
    return { ms, perOpMs: ms / iterations }
  }

  const encodeResults = samples.map((s) => {
    const { perOpMs } = bench(`compress_${s.length}`, () => compressText(s), 100)
    const frame = compressText(s)
    return { size: s.length, stored: frame instanceof Uint8Array ? frame.byteLength : s.length, perOpMs }
  })
  console.log(`codec_encode: ${encodeResults.map((r) => `${r.size}B->${r.stored}B ${r.perOpMs.toFixed(3)}ms/op`).join(", ")}`)

  const decodeTargets = samples.map((s) => compressText(s)).filter((x): x is Uint8Array => x instanceof Uint8Array)
  const decodeResults = decodeTargets.map((f) => {
    const { perOpMs } = bench(`decompress_${f.byteLength}`, () => decompressFrame(f), 100)
    return { stored: f.byteLength, perOpMs }
  })
  console.log(`codec_decode: ${decodeResults.map((r) => `${r.stored}B ${r.perOpMs.toFixed(3)}ms/op`).join(", ")}`)
}

// --- sealer pass -----------------------------------------------------------
console.log(`sealer: threshold=${THRESHOLD} (code units)`)
const COOLING_MS = 48 * 60 * 60 * 1000
const BATCH = 128
const cutoff = Date.now() - COOLING_MS

db.exec(`CREATE TABLE IF NOT EXISTS ocdb_seal (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  time_sealed INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id)
)`)

// Partial expression index on the sealer's candidate filter — eligibility
// batch went 8.9s -> 0.13s (68x). Same fork-adjacent pattern as
// idx_message_provider_id in core/src/session/usage.ts (no schema change).
db.exec(`CREATE INDEX IF NOT EXISTS idx_event_seal_candidates
  ON event (aggregate_id, seq)
  WHERE typeof(data) = 'text' AND length(data) >= 4096`)

const eligibility = db.prepare(`
  SELECT e.id, e.data
  FROM event e
  JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
  LEFT JOIN session se ON se.id = e.aggregate_id
  WHERE e.seq <= es.seq
    AND es.owner_id IS NULL
    AND (se.time_updated IS NULL OR se.time_updated <= ?)
    AND typeof(e.data) = 'text'
    AND length(e.data) >= 4096
  ORDER BY e.aggregate_id, e.seq
  LIMIT ?`)

const updateStmt = db.prepare("UPDATE event SET data = ? WHERE id = ?")
const journalStmt = db.prepare(
  "INSERT INTO ocdb_seal (table_name, row_id, raw_bytes, stored_bytes, time_sealed) VALUES ('event', ?, ?, ?, ?) ON CONFLICT (table_name, row_id) DO UPDATE SET raw_bytes=excluded.raw_bytes, stored_bytes=excluded.stored_bytes, time_sealed=excluded.time_sealed",
)

const sealStart = performance.now()
let sealed = 0
let sealedRawBytes = 0
let sealedStoredBytes = 0
let eligibleTotal = 0
let passes = 0

// Progress bar helpers (single-line \r so it works in pwsh/cmd/bun/node).
const bar = (done: number, total: number, label: string) => {
  if (total <= 0) return
  const pct = Math.min(100, (done / total) * 100)
  const width = 30
  const filled = Math.round((pct / 100) * width)
  const elapsedS = (performance.now() - sealStart) / 1000
  const rate = elapsedS > 0 ? done / elapsedS : 0
  const etaS = rate > 0 ? (total - done) / rate : 0
  process.stdout.write(
    `\r${label} [${"#".repeat(filled)}${"-".repeat(width - filled)}] ${pct.toFixed(1)}%  ${done}/${total} rows  ${rate.toFixed(0)} r/s  ETA ${etaS.toFixed(0)}s   `,
  )
}

// Count total eligible first so the bar has a denominator (and re-runs skip framed).
const totalEligible = Math.min(
  (db.prepare(`
  SELECT count(*) AS n
  FROM event e
  JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
  LEFT JOIN session se ON se.id = e.aggregate_id
  WHERE e.seq <= es.seq
    AND es.owner_id IS NULL
    AND (se.time_updated IS NULL OR se.time_updated <= ?)
    AND typeof(e.data) = 'text'
    AND length(e.data) >= 4096
`).get(cutoff) as { n: number }).n,
  MAX_ROWS,
)
const barTotal = Number.isFinite(MAX_ROWS) ? Math.min(totalEligible, MAX_ROWS) : totalEligible
console.log(`sealer: eligible=${totalEligible} rows (will seal >=4KiB, in ${Math.ceil(totalEligible / BATCH)} batches)${Number.isFinite(MAX_ROWS) ? ` capped at ${MAX_ROWS}` : ""}`)
bar(0, barTotal, "sealing")

for (;;) {
  const candidates = eligibility.all(cutoff, Math.min(BATCH, MAX_ROWS)) as { id: string; data: string }[]
  if (candidates.length === 0) break
  eligibleTotal += candidates.length
  // One transaction per batch: UPDATE + journal UPSERT pairs commit
  // atomically (SQLite all-or-nothing), so the journal can never drift from
  // actually-sealed rows — same crash-consistency as per-row tx, ~100x fewer
  // HDD fsyncs. This is a benchmark relaxation; the production sealer can use
  // the same batching and keep the guarantee.
  db.exec("BEGIN IMMEDIATE")
  let batchCommitted = false
  try {
    for (const row of candidates) {
      const frame = compressText(row.data)
      if (typeof frame === "string") continue
      updateStmt.run(frame, row.id)
      journalStmt.run(row.id, row.data.length, frame.byteLength, Date.now())
      sealed++
      sealedRawBytes += row.data.length
      sealedStoredBytes += frame.byteLength
    }
    db.exec("COMMIT")
    batchCommitted = true
  } finally {
    if (!batchCommitted) db.exec("ROLLBACK")
  }
  passes++
  bar(sealed, totalEligible, "sealing")
  if (sealed >= MAX_ROWS) break
  if (passes % 10 === 0) await new Promise((r) => setTimeout(r, 0))
}
process.stdout.write("\n")
const sealMs = performance.now() - sealStart
db.close()

// --- sealed state ----------------------------------------------------------
const sealedDb = openDriver(DB_PATH)
const afterSize = sealedDb.fileSizeBytes()
const sealedRows = sealedDb.prepare("SELECT count(*) AS n, sum(stored_bytes) AS stored FROM ocdb_seal").get() as { n: number; stored: number }
const remainingBig = sealedDb.prepare("SELECT count(*) AS n, sum(length(data)) AS bytes FROM event WHERE typeof(data)='text' AND length(data)>=4096").get() as { n: number; bytes: number }
const framed = sealedDb.prepare("SELECT count(*) AS n, sum(length(data)) AS bytes FROM event WHERE typeof(data)='blob'").get() as { n: number; bytes: number }

console.log(`\n=== SEALER RESULT ===`)
console.log(`passes=${passes} candidates=${eligibleTotal} sealed=${sealed} skipped_text=${eligibleTotal - sealed}`)
console.log(`seal_time=${(sealMs / 1000).toFixed(1)}s  raw_saved=${MB(sealedRawBytes)} -> stored=${MB(sealedStoredBytes)} (${(sealedStoredBytes / sealedRawBytes).toFixed(3)}x)`)

// Cold resume read: biggest aggregate, before/after framing.
const coldStart = performance.now()
const coldRows = sealedDb.prepare("SELECT data FROM event WHERE aggregate_id=? ORDER BY seq").all(biggest.aggregate_id) as { data: unknown }[]
let decodedCount = 0
for (const r of coldRows) {
  if (typeof r.data === "string") continue
  decompressFrame(r.data as Uint8Array)
  decodedCount++
}
const coldMs = performance.now() - coldStart
console.log(`cold_read: aggregate=${biggest.aggregate_id} rows=${coldRows.length} framed=${decodedCount} total=${coldMs.toFixed(1)}ms`)

console.log(`\nfile_size_after=${MB(afterSize)} (was ${MB(fileSize)})`)
console.log(`ocdb_seal rows=${sealedRows.n} stored=${MB(sealedRows.stored ?? 0)}`)
console.log(`remaining_text_big rows=${remainingBig.n} bytes=${MB(remainingBig.bytes ?? 0)}`)
console.log(`framed rows=${framed.n} bytes=${MB(framed.bytes ?? 0)}`)
console.log(`coverage_pct=${((sealedRawBytes / Math.max(1, eventRows.bytes)) * 100).toFixed(1)}% of total event bytes`)
sealedDb.close()
console.log(`\nDONE`)
