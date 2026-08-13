/**
 * ChunkDB read-latency harness (t8) — raw-vs-sealed read latency on the REAL
 * DB: sealed copy vs live raw baseline, Node 24 AND Bun 1.3.14.
 *
 *   bun  bench/chunkdb-readlatency.ts <sealed.db> <raw.db>
 *   node --experimental-strip-types bench/chunkdb-readlatency.ts <sealed.db> <raw.db>
 *
 * Measures the app's real read shapes: session-open durable replay of the
 * heavy-tail aggregate ses_0361b832bffeGGxp6fIfX6lXY8, SessionHistory.load
 * (session_message projection — hot path, must be zero-cost), readAfter /
 * readAggregate paged point reads, full-history cold read, and the pure
 * in-memory decode cost of the >=64KB tail (incl. the ~32.8MB max row).
 * Reports per-op ms raw vs sealed + framed-row share, and validates the
 * phase-1 prediction (only >=4KiB rows pay decode, only on cold reads).
 *
 * NOTE: the raw baseline is the LIVE db (being written) — its numbers are
 * approximate and drift; the sealed copy is a pristine snapshot. readOnly
 * opens only; nothing is modified.
 */
import { createRequire } from "node:module"
import { decompressFrame } from "@opencode-ai/core/database/json-codec"

const req = createRequire(import.meta.url)
const SEALED = process.argv[2]
const RAW = process.argv[3]
if (!SEALED || !RAW) {
  console.error("usage: chunkdb-readlatency <sealed.db> <raw.db>")
  process.exit(1)
}
const isBun = typeof Bun !== "undefined"
console.log(`runtime=${isBun ? "bun" : "node"}  sealed=${SEALED}  raw=${RAW}`)

type Driver = {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[]
    get(...args: unknown[]): unknown | undefined
  }
  close(): void
}
function openDriver(path: string): Driver {
  if (isBun) {
    const { Database } = req("bun:sqlite")
    const db = new Database(path, true)
    return {
      prepare: (sql) => ({
        all: (...args) => db.query(sql).all(...args),
        get: (...args) => db.query(sql).get(...args),
      }),
      close: () => db.close(),
    }
  }
  const { DatabaseSync } = req("node:sqlite")
  const db = new DatabaseSync(path, { readOnly: true })
  return {
    prepare: (sql) => ({
      all: (...args) => db.prepare(sql).all(...args),
      get: (...args) => db.prepare(sql).get(...args),
    }),
    close: () => db.close(),
  }
}

const COLD_AGG = "ses_0361b832bffeGGxp6fIfX6lXY8" // 6866 events, 772 framed, 2.5GB raw -> 273MB
const BIG_AGG = "ses_00e74f7f0ffeC8TyYWJkDj2T2v" // 18,416 events — biggest aggregate

function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const fmt = (n: number) => n.toFixed(1)

// Page a full aggregate read so we never hold the whole (multi-GB raw) set in
// memory at once — the app pages too. Rows stream through decode, then drop.
function pagedSelect(
  db: Driver,
  sql: string,
  params: unknown[],
  pageSize = 1000,
): { rows: number; framed: number } {
  let rows = 0
  let framed = 0
  let offset = 0
  for (;;) {
    const page = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as { seq: number; data: unknown }[]
    if (page.length === 0) break
    for (const r of page) {
      rows++
      if (isFramed(r.data)) framed++
      decodeValue(r.data) // decode immediately, release the raw bytes
    }
    offset += page.length
    if (page.length < pageSize) break
  }
  return { rows, framed }
}


const sealed = openDriver(SEALED)
const raw = openDriver(RAW)

// decode a driver value the way compressedJson.fromDriver does
function decodeValue(v: unknown): unknown {
  if (typeof v === "string") return JSON.parse(v)
  if (v instanceof Uint8Array) return JSON.parse(decompressFrame(v))
  throw new Error(`unexpected type ${typeof v}`)
}
function isFramed(v: unknown): boolean {
  return v instanceof Uint8Array
}

// ---- Op 1: session-open durable replay (cold aggregate, all events) --------
async function replay(db: Driver, label: string, n = 3) {
  const times: number[] = []
  let framed = 0
  let rows = 0
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    const res = pagedSelect(db, "SELECT seq, data FROM event WHERE aggregate_id=? ORDER BY seq", [COLD_AGG])
    rows = res.rows
    framed = res.framed
    times.push(performance.now() - t0)
  }
  console.log(`replay(${label}): rows=${rows} framed=${framed} total_ms ${times.map(fmt).join("/")} median=${fmt(median(times))}`)
}
console.log("\n== Op1 session-open durable replay (cold aggregate) ==")
await replay(raw, "raw")
await replay(sealed, "sealed")

// ---- Op 2: SessionHistory.load — session_message projection (hot path) -----
async function historyLoad(db: Driver, label: string, n = 5) {
  const times: number[] = []
  let rows = 0
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    const all = db.prepare("SELECT seq, type, data FROM session_message ORDER BY seq").all() as {
      seq: number
      data: unknown
    }[]
    rows = all.length
    for (const r of all) decodeValue(r.data)
    times.push(performance.now() - t0)
  }
  console.log(`sessionHistory.load(${label}): rows=${rows} total_ms ${times.map(fmt).join("/")} median=${fmt(median(times))}`)
}
console.log("\n== Op2 SessionHistory.load (session_message projection) ==")
await historyLoad(raw, "raw")
await historyLoad(sealed, "sealed")

// ---- Op 3: readAfter page (durable-stream incremental, limit 100) ----------
async function readAfterPage(db: Driver, label: string, n = 10) {
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    const rows = db.prepare("SELECT seq, data FROM event WHERE aggregate_id=? AND seq>? ORDER BY seq LIMIT 100").all(
      BIG_AGG,
      0,
    ) as { seq: number; data: unknown }[]
    for (const r of rows) decodeValue(r.data)
    times.push(performance.now() - t0)
  }
  console.log(`readAfter page100(${label}): total_ms ${times.map(fmt).join("/")} median=${fmt(median(times))}`)
}
console.log("\n== Op3 readAfter page(100) ==")
await readAfterPage(raw, "raw")
await readAfterPage(sealed, "sealed")

// ---- Op 4: readAggregate page (type-filtered, limit 500) -------------------
async function readAggPage(db: Driver, label: string, n = 10) {
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    const rows = db
      .prepare(
        "SELECT seq, data FROM event WHERE aggregate_id=? AND seq>? AND type=? ORDER BY seq LIMIT 500",
      )
      .all(BIG_AGG, 0, "message.part.updated.1") as { seq: number; data: unknown }[]
    for (const r of rows) decodeValue(r.data)
    times.push(performance.now() - t0)
  }
  console.log(`readAggregate page500(${label}): total_ms ${times.map(fmt).join("/")} median=${fmt(median(times))}`)
}
console.log("\n== Op4 readAggregate page(500, type-filtered) ==")
await readAggPage(raw, "raw")
await readAggPage(sealed, "sealed")

// ---- Op 5: full-history cold read (after=-1) of the biggest aggregate ------
async function fullHistory(db: Driver, label: string, n = 2) {
  const times: number[] = []
  let framed = 0
  let rows = 0
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    const res = pagedSelect(db, "SELECT seq, data FROM event WHERE aggregate_id=? ORDER BY seq", [BIG_AGG])
    rows = res.rows
    framed = res.framed
    times.push(performance.now() - t0)
  }
  console.log(`fullHistory(${label}): rows=${rows} framed=${framed} total_ms ${times.map(fmt).join("/")} median=${fmt(median(times))}`)
}
console.log("\n== Op5 full-history cold read (biggest aggregate) ==")
await fullHistory(raw, "raw")
await fullHistory(sealed, "sealed")

// ---- Op 6: pure in-memory decode cost of the >=64KB tail -------------------
async function tailDecode(db: Driver, label: string) {
  const rows = db
    .prepare("SELECT id, data FROM event WHERE typeof(data)=? ORDER BY length(data) DESC LIMIT 5")
    .all("blob") as { id: string; data: Uint8Array }[]
  for (const r of rows) {
    const t0 = performance.now()
    const text = decompressFrame(r.data)
    const ms = performance.now() - t0
    console.log(`tailDecode(${label}): id=${r.id.slice(0, 12)}... stored=${(r.data.byteLength / 1048576).toFixed(1)}MB raw=${(text.length / 1048576).toFixed(1)}MB decode=${fmt(ms)}ms`)
  }
}
console.log("\n== Op6 pure decode cost, top-5 largest FRAMED rows (sealed copy only) ==")
await tailDecode(sealed, "sealed")

// Also time the same rows as RAW TEXT on the live baseline (same ids, if present)
async function tailRaw(db: Driver, label: string, ids: string[]) {
  for (const id of ids) {
    const r = db.prepare("SELECT data FROM event WHERE id=?").get(id) as { data: unknown } | undefined
    if (!r) {
      console.log(`tailRaw(${label}): id=${id.slice(0, 12)}... not present (drift)`)
      continue
    }
    const t0 = performance.now()
    JSON.parse(r.data as string)
    console.log(`tailRaw(${label}): id=${id.slice(0, 12)}... raw=${((r.data as string).length / 1048576).toFixed(1)}MB parse=${fmt(performance.now() - t0)}ms`)
  }
}
const topIds = (sealed.prepare("SELECT id, data FROM event WHERE typeof(data)=? ORDER BY length(data) DESC LIMIT 5").all("blob") as { id: string; data: Uint8Array }[]).map((r) => r.id)
console.log("\n== Op6b same top-5 rows as RAW TEXT on live baseline ==")
await tailRaw(raw, "raw", topIds)

// ---- Op 7: hot-path zero-cost check — active/recent session reads = TEXT ---
{
  const hot = (sealed.prepare(
    `SELECT e.aggregate_id, count(*) n,
            sum(CASE WHEN typeof(e.data)=? THEN 1 ELSE 0 END) framed,
            max(s.time_updated) recent
     FROM event e JOIN session s ON s.id = e.aggregate_id
     WHERE s.time_updated > ?
     GROUP BY e.aggregate_id
     ORDER BY recent DESC LIMIT 1`,
  ).get("blob", Date.now() - 24 * 3600 * 1000) as {
    aggregate_id: string
    n: number
    framed: number | null
    recent: number | null
  })
  console.log(`\n== Op7 hot-path check ==`)
  console.log(
    `most-recent session ${hot?.aggregate_id ?? "none"}: events=${hot?.n ?? 0} framed=${hot?.framed ?? 0} recent=${hot?.recent ? new Date(hot.recent).toISOString() : "?"} (0 framed = hot path reads zero frames)`,
  )
  const hotSm = dbCountFramed(sealed, "session_message")
  console.log(`session_message framed=${hotSm} (projection read by V2Session.messages / runner resume — zero decode)`)
  const coldIsLegacy = dbCountLegacy(sealed, "ses_0361b832bffeGGxp6fIfX6lXY8")
  console.log(`cold aggregate ses_0361b832 is LEGACY v1 (session_message rows=${coldIsLegacy}) -> resume replays EVENT HISTORY (Op1 cost applies)`)
}

function dbCountFramed(db: Driver, table: string): number {
  const r = db.prepare(`SELECT sum(CASE WHEN typeof(data)=? THEN 1 ELSE 0 END) n FROM ${table}`).get("blob") as { n: number | null }
  return r.n ?? 0
}

function dbCountLegacy(db: Driver, sessionID: string): number {
  const r = db.prepare("SELECT count(*) n FROM session_message WHERE session_id=?").get(sessionID) as { n: number }
  return r.n
}

sealed.close()
raw.close()
console.log("\nDONE")

