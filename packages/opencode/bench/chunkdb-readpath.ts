/**
 * ChunkDB read-path verification harness (t7) — verify every app read path
 * that touches event.data decodes sealed frame-v2 rows correctly against the
 * sealed copy, and that untouched tables (message.data etc.) are byte-identical
 * TEXT with working json_extract.
 *
 * Runs on BOTH runtimes:
 *   bun  bench/chunkdb-readpath.ts <sealed.db>
 *   node --experimental-strip-types bench/chunkdb-readpath.ts <sealed.db>
 *
 * Mirrors the app's real query shapes (event.ts readAfter/readAggregate,
 * history.ts SessionHistory.load, message page/hydrate, usage.ts json_extract,
 * credentials.ts backfill) and maps every event.data value through the codec
 * exactly as Drizzle's compressedJson.fromDriver would (decompressFrame ->
 * JSON.parse). Fail-closed: corrupt-frame cases must throw OCDBFrameError and
 * must not affect healthy rows in the same batch.
 */
import { join } from "node:path"
import { createRequire } from "node:module"
import { decompressFrame, OCDBFrameError, compressText } from "@opencode-ai/core/database/json-codec"

const req = createRequire(import.meta.url)

const DB_PATH = process.argv[2]
if (!DB_PATH) {
  console.error("usage: chunkdb-readpath <sealed-db-path>")
  process.exit(1)
}

const isBun = typeof Bun !== "undefined"
console.log(`runtime=${isBun ? "bun" : "node"}  db=${DB_PATH}`)

// --- driver abstraction (node:sqlite | bun:sqlite) -------------------------
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

// Decode exactly as compressedJson.fromDriver would (string -> JSON.parse;
// Uint8Array frame -> decompressFrame -> JSON.parse).
function asDriverData(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value)
  if (value instanceof Uint8Array) return JSON.parse(decompressFrame(value))
  if (value instanceof ArrayBuffer) return JSON.parse(decompressFrame(new Uint8Array(value)))
  throw new OCDBFrameError(`unexpected driver value type ${typeof value}`)
}

const db = openDriver(DB_PATH)
const results: { path: string; result: string; notes: string }[] = []
let failures = 0
let checks = 0

function check(name: string, ok: boolean, notes: string) {
  checks++
  if (!ok) failures++
  results.push({ path: name, result: ok ? "PASS" : "FAIL", notes })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${notes}`)
}

// ---- Path 1: readAfter (event.ts:541) — durable replay tail read ----------
// SELECT * FROM event WHERE aggregate_id=? AND seq>? ORDER BY seq
{
  const coldAgg = "ses_0361b832bffeGGxp6fIfX6lXY8" // 2.5GB raw aggregate, 772 framed rows
  const rows = db
    .prepare("SELECT id, seq, type, data FROM event WHERE aggregate_id=? AND seq>? ORDER BY seq")
    .all(coldAgg, 0) as { id: string; seq: number; type: string; data: unknown }[]
  let decoded = 0
  let framed = 0
  let bad = 0
  for (const r of rows) {
    try {
      const obj = asDriverData(r.data) as Record<string, unknown>
      if (typeof obj !== "object" || obj === null) bad++
      decoded++
      if (r.data instanceof Uint8Array) framed++
    } catch (e) {
      bad++
      if (bad <= 3) console.log(`  decode err row ${r.id} seq=${r.seq}: ${e}`)
    }
  }
  check(
    "readAfter (cold aggregate ses_0361b832, seq>0)",
    decoded === rows.length && bad === 0,
    `rows=${rows.length} decoded=${decoded} framed=${framed} errors=${bad}`,
  )
}

// ---- Path 2: readAggregate (event.ts:63) — durable replay with type filter --
// SELECT * FROM event WHERE aggregate_id=? AND seq>? AND type IN (?) ORDER BY seq LIMIT ?
{
  const coldAgg = "ses_00e74f7f0ffeC8TyYWJkDj2T2v" // 18,416 rows, 379MB stored — biggest aggregate
  const rows = db
    .prepare("SELECT id, seq, type, data FROM event WHERE aggregate_id=? AND seq>? AND type=? ORDER BY seq LIMIT ?")
    .all(coldAgg, -1, "message.part.updated.1", 1000) as { id: string; seq: number; type: string; data: unknown }[]
  let bad = 0
  for (const r of rows) {
    try {
      asDriverData(r.data)
    } catch {
      bad++
    }
  }
  check(
    "readAggregate (biggest aggregate, type-filtered, LIMIT 1000)",
    bad === 0,
    `rows=${rows.length} errors=${bad} (includes framed: ${rows.filter((r) => r.data instanceof Uint8Array).length})`,
  )
}

// ---- Path 3: full-history read (after=-1) of the largest aggregate — all rows
{
  const coldAgg = "ses_00e74f7f0ffeC8TyYWJkDj2T2v"
  const rows = db
    .prepare("SELECT id, seq, type, data FROM event WHERE aggregate_id=? ORDER BY seq")
    .all(coldAgg) as { id: string; seq: number; type: string; data: unknown }[]
  let framed = 0
  let bad = 0
  let textOk = 0
  for (const r of rows) {
    try {
      asDriverData(r.data)
      if (r.data instanceof Uint8Array) framed++
      else textOk++
    } catch {
      bad++
    }
  }
  check(
    "full-history read (biggest aggregate, all rows)",
    bad === 0,
    `rows=${rows.length} framed=${framed} text=${textOk} errors=${bad}`,
  )
}

// ---- Path 4: SessionHistory.load (history.ts) — session_message projection --
// SELECT * FROM session_message WHERE session_id=? ... ORDER BY seq
// session_message.data stays TEXT (0 blobs) — must decode as plain JSON.
{
  const sm = db.prepare("SELECT id, session_id, seq, type, data FROM session_message ORDER BY seq LIMIT 209").all() as {
    id: string
    session_id: string
    seq: number
    type: string
    data: unknown
  }[]
  let bad = 0
  let blobs = 0
  for (const r of sm) {
    try {
      if (r.data instanceof Uint8Array) blobs++
      asDriverData(r.data)
    } catch {
      bad++
    }
  }
  check(
    "SessionHistory.load (session_message projection, all rows)",
    bad === 0 && blobs === 0,
    `rows=${sm.length} blobs=${blobs} errors=${bad}`,
  )
}

// ---- Path 5: message page + part hydrate (message-v2.ts) — TEXT tables ----
{
  const session = (db.prepare("SELECT id FROM session LIMIT 1").get() as { id: string } | undefined)?.id ?? "none"
  const messages = db
    .prepare("SELECT id, data FROM message WHERE session_id=? ORDER BY time_created, id LIMIT 50")
    .all(session) as { id: string; data: unknown }[]
  let bad = 0
  let blobs = 0
  for (const m of messages) {
    if (m.data instanceof Uint8Array) blobs++
    try {
      asDriverData(m.data)
    } catch {
      bad++
    }
  }
  const partRows = messages.length
    ? (db.prepare(`SELECT id, data FROM part WHERE message_id IN (${messages.map(() => "?").join(",")})`).all(
        ...messages.map((m) => m.id),
      ) as { id: string; data: unknown }[])
    : []
  let pBad = 0
  let pBlobs = 0
  for (const p of partRows) {
    if (p.data instanceof Uint8Array) pBlobs++
    try {
      asDriverData(p.data)
    } catch {
      pBad++
    }
  }
  check(
    "message page + part hydrate (first session, 50 messages + parts)",
    bad === 0 && blobs === 0 && pBad === 0 && pBlobs === 0,
    `messages=${messages.length} msgBlobs=${blobs} parts=${partRows.length} partBlobs=${pBlobs} errors=${bad + pBad}`,
  )
}

// ---- Path 6: usage.ts json_extract on message.data (must work — TEXT) ------
{
  const usage = db
    .prepare(
      `SELECT id, json_extract(data,'$.providerID') as providerID, json_extract(data,'$.role') as role,
              json_extract(data,'$.cost') as cost, json_extract(data,'$.time.created') as createdMs
       FROM message
       WHERE json_extract(data,'$.providerID') = 'opencode-go'
         AND json_extract(data,'$.role') = 'assistant'
         AND json_extract(data,'$.time.created') >= 0
       LIMIT 10`,
    )
    .all() as { id: string; providerID: string; role: string; cost: number | null; createdMs: number | null }[]
  check(
    "usage.ts json_extract on message.data (opencode-go assistant rows)",
    usage.length > 0 && usage.every((r) => r.role === "assistant"),
    `rows=${usage.length} providerID=${usage[0]?.providerID ?? "?"} role=${usage[0]?.role ?? "?"} cost=${usage[0]?.cost ?? "?"}`,
  )
}

// ---- Path 7: credentials.ts backfill json_extract (message.data TEXT) ------
{
  const backfill = db
    .prepare(
      `SELECT count(*) n, count(json_extract(message.data, '$.time.created')) withTime
       FROM message
       WHERE json_extract(message.data, '$.providerID') = 'opencode-go'
         AND json_extract(message.data, '$.role') = 'assistant'`,
    )
    .get() as { n: number; withTime: number }
  check(
    "credentials.ts backfill json_extract (message.data)",
    backfill.n > 0 && backfill.withTime === backfill.n,
    `rows=${backfill.n} withTime=${backfill.withTime}`,
  )
}

// ---- Path 8: message.data byte-identity — no blobs, all TEXT ---------------
{
  const msg = db.prepare("SELECT count(*) n, sum(CASE WHEN typeof(data)=? THEN 1 ELSE 0 END) blobs FROM message").get("blob") as {
    n: number
    blobs: number | null
  }
  check("message.data untouched (0 blobs, TEXT)", (msg.blobs ?? 0) === 0, `n=${msg.n} blobs=${msg.blobs ?? 0}`)
  const part = db.prepare("SELECT count(*) n, sum(CASE WHEN typeof(data)=? THEN 1 ELSE 0 END) blobs FROM part").get("blob") as {
    n: number
    blobs: number | null
  }
  check("part.data untouched (0 blobs, TEXT)", (part.blobs ?? 0) === 0, `n=${part.n} blobs=${part.blobs ?? 0}`)
}

// ---- Path 9: FULL frame audit — every framed row decodes, CRC verifies ------
{
  const framed = db
    .prepare("SELECT id, data FROM event WHERE typeof(data)=? ORDER BY aggregate_id, seq")
    .all("blob") as { id: string; data: Uint8Array }[]
  let bad = 0
  let firstErr: string | undefined
  let decodedJson = 0
  for (const r of framed) {
    try {
      const text = decompressFrame(r.data)
      const obj = JSON.parse(text)
      if (typeof obj !== "object" || obj === null) throw new Error("not an object")
      decodedJson++
    } catch (e) {
      bad++
      if (!firstErr) firstErr = `row ${r.id}: ${e}`
    }
  }
  check("full frame audit (all 126,715 framed rows CRC+JSON)", bad === 0 && decodedJson === framed.length, `framed=${framed.length} ok=${decodedJson} bad=${bad}${firstErr ? ` firstErr=${firstErr}` : ""}`)
}

// ---- Path 10: fail-closed — corrupt frames throw, healthy rows unaffected ---
{
  // Take one real frame, corrupt it 4 ways; each must throw OCDBFrameError.
  const sample = db.prepare("SELECT data FROM event WHERE typeof(data)=? LIMIT 1").get("blob") as { data: Uint8Array }
  const frame = sample.data
  const corrupt: [string, Uint8Array][] = []
  // bad magic
  const badMagic = Uint8Array.from(frame)
  badMagic[0] = 0x58
  corrupt.push(["bad magic", badMagic])
  // bad CRC (flip a payload byte AFTER header so decompress may still succeed)
  const badCrc = Uint8Array.from(frame)
  badCrc[badCrc.length - 1] ^= 0xff
  corrupt.push(["bad CRC (payload flip)", badCrc])
  // rawLen bomb (header rawLen > pre-cap) — must be rejected BEFORE decompress
  const bomb = Uint8Array.from(frame)
  new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength).setUint32(6, 512 * 1024 * 1024, true)
  corrupt.push(["rawLen bomb > pre-cap", bomb])
  // unsupported version
  const badVer = Uint8Array.from(frame)
  badVer[4] = 99
  corrupt.push(["unsupported version", badVer])

  for (const [name, c] of corrupt) {
    try {
      decompressFrame(c)
      check(`fail-closed: ${name}`, false, "did NOT throw — BAD")
    } catch (e) {
      check(
        `fail-closed: ${name}`,
        e instanceof OCDBFrameError,
        `threw ${e instanceof OCDBFrameError ? "OCDBFrameError" : (e as Error).constructor.name}${(e as Error).message ? `: ${(e as Error).message}` : ""}`,
      )
    }
  }
  // Healthy rows in the SAME batch still decode (codec is per-value).
  const rows = db.prepare("SELECT data FROM event WHERE typeof(data)=? LIMIT 5").all("blob") as { data: Uint8Array }[]
  let healthy = 0
  for (const r of rows) {
    try {
      JSON.parse(decompressFrame(r.data))
      healthy++
    } catch {
      /* noop */
    }
  }
  check("fail-closed: healthy rows unaffected after corruption", healthy === rows.length, `healthy=${healthy}/${rows.length}`)
}

// ---- Path 11: sync.ts:76 global history scan (decode a sealed window) ------
// SELECT * FROM event WHERE NOT (aggregate_id=? AND seq<=?) ... ORDER BY seq
// (history endpoint: excludes client-known seqs, scans the rest — can hit sealed rows)
{
  // Exclude everything for one aggregate, scan the rest of the tail window.
  const exclude = "ses_00e74f7f0ffeC8TyYWJkDj2T2v"
  const rows = db
    .prepare(
      `SELECT id, seq, type, data FROM event
       WHERE NOT (aggregate_id = ? AND seq <= ?)
       ORDER BY seq LIMIT 5000`,
    )
    .all(exclude, 1000000000) as { id: string; seq: number; type: string; data: unknown }[]
  let framed = 0
  let bad = 0
  for (const r of rows) {
    try {
      asDriverData(r.data)
      if (r.data instanceof Uint8Array) framed++
    } catch {
      bad++
    }
  }
  check("sync.ts:76 global history scan (LIMIT 5000, excludes one aggregate)", bad === 0, `rows=${rows.length} framed=${framed} errors=${bad}`)
}

// ---- Path 12: v1 frame decodability (phase-1 carry) -------------------------
{
  const sample = db.prepare("SELECT data FROM event WHERE typeof(data)=? LIMIT 1").get("blob") as { data: Uint8Array }
  const frame = sample.data
  // Hand-build a v1 frame (10-byte header, no CRC) from the same raw payload.
  const rawLen = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(6, true)
  const payload = frame.subarray(14)
  const v1 = new Uint8Array(10 + payload.byteLength)
  v1[0] = 0x4f
  v1[1] = 0x43
  v1[2] = 0x44
  v1[3] = 0x42
  v1[4] = 1
  v1[5] = frame[5]
  new DataView(v1.buffer).setUint32(6, rawLen, true)
  v1.set(payload, 10)
  try {
    const text = decompressFrame(v1)
    const obj = JSON.parse(text)
    check("v1 frame decodes (phase-1 carry)", typeof obj === "object", `rawLen=${rawLen}`)
  } catch (e) {
    check("v1 frame decodes (phase-1 carry)", false, `${e}`)
  }
}

db.close()
console.log(`\n=== READ-PATH VERIFICATION: ${checks - failures}/${checks} checks passed ===`)
process.exit(failures === 0 ? 0 : 1)
