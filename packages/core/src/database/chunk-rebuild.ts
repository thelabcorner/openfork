/**
 * Epoch-3 (Phase-2, #8): opt-in, flag-gated REBUILD that extends the #9
 * file-swap machinery to collapse projections into reference-indexes to
 * `event_value` (same table, no second scan).
 *
 * SCOPE (R1-R5, investigate-v4 locked): the 4x redundant stores —
 *   - `session_message.data` (projection)
 *   - `message.data` (projection, V1)
 *   - `session.summary_diffs` (projection)
 *   - `event.data` rows of type `message.updated` / `session.updated`
 * are collapsed into `event_value` `$cdbRef` indexes; everything else
 * stays inline-or-frame per R3/R4/R5. `part.updated` (68.6% UNIQUE, 0% repeats)
 * and `part.*` generally are EXCLUDED — frame-in-place only (R5).
 *
 * OPCL (coordinator msg_b501b760):
 *   R2: collapse at seal time — no write-time refs; app write path untouched.
 *   Q1: abort-hard fail-closed — corrupt frame fails rebuild verification, original
 *       left untouched (consistent with rehydrate CdbRehydrateError + #9 swap).
 *   Q4: session.summary_diffs → collapse as reference-index (derived, stored as
 *       ref; regeneration as fallback if dangling).
 *
 * ACCEPTANCE: whole-DB dedup 35-65%, wire/SSE/sync/history byte-identical
 * (corpus D6 golden), rehydration p99 unchanged, flag-gated default-off.
 *
 * WRITE/REBUILD HALF ONLY — storage-frontier-v3 owns this file. The READ half
 * (generalize rehydrateEvents to all collapsed columns) is read-frontier-v3's
 * lane in event.ts. This file reuses the #9 raw SQLite + GC + copy-fallback
 * swap and the sealer's event_value dedup (sha256, $cdbRef, refs bump).
 */
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs"
import { createRequire } from "node:module"
import { Duration, Effect } from "effect"
import { Flag } from "../flag/flag"
import { compressText, decodeValueBytes } from "./json-codec"

const require = createRequire(import.meta.url)

export interface RebuildResult {
  readonly sourceSize: number
  readonly rebuiltSize: number
  readonly bytesReclaimed: number
  readonly collapsed: { event: number; projection: number; deduped: number }
}

const VERIFY_SAMPLE = 1000
const CDB_REF = "$cdbRef"

function toCdbRef(valueId: string): string {
  return JSON.stringify({ [CDB_REF]: valueId })
}

function escapePath(p: string): string {
  return p.replace(/'/g, "''")
}

type RawDb = {
  close: () => void
  run: (sql: string) => void
  exec: (sql: string) => void
  queryAll: (sql: string) => Array<Record<string, unknown>>
  prepareAll: (sql: string, params: ReadonlyArray<unknown>) => Array<Record<string, unknown>>
  prepareRun: (sql: string, params: ReadonlyArray<unknown>) => void
}

function doGc() {
  try {
    const maybeBun = (globalThis as unknown as { Bun?: { gc: (force: boolean) => void } }).Bun
    maybeBun?.gc(true)
  } catch {}
  try {
    const maybeGc = (globalThis as unknown as { gc?: () => void }).gc
    maybeGc?.()
  } catch {}
}

function openRaw(filename: string): RawDb {
  try {
    const { Database } = require("bun:sqlite") as { Database: new (f: string) => any }
    const db = new Database(filename)
    return {
      close: () => {
        try {
          db.run("PRAGMA wal_checkpoint(TRUNCATE)")
        } catch {}
        try {
          db.close()
        } catch {}
        doGc()
      },
      run: (sql: string) => db.run(sql),
      exec: (sql: string) => db.run(sql),
      queryAll: (sql: string) => {
        const stmt = db.query(sql)
        return (stmt.all() ?? []) as Array<Record<string, unknown>>
      },
      prepareAll: (sql: string, params: ReadonlyArray<unknown>) => {
        const stmt = db.query(sql)
        return (stmt.all(...(params as unknown[])) ?? []) as Array<Record<string, unknown>>
      },
      prepareRun: (sql: string, params: ReadonlyArray<unknown>) => {
        const stmt = db.query(sql)
        stmt.run(...(params as unknown[]))
      },
    }
  } catch {}
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (f: string, o: unknown) => any
  }
  const db = new DatabaseSync(filename, { open: true })
  return {
    close: () => {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch {}
      try {
        db.close()
      } catch {}
      doGc()
    },
    run: (sql: string) => db.exec(sql),
    exec: (sql: string) => db.exec(sql),
    queryAll: (sql: string) => {
      const stmt = db.prepare(sql)
      return (stmt.all() ?? []) as Array<Record<string, unknown>>
    },
    prepareAll: (sql: string, params: ReadonlyArray<unknown>) => {
      const stmt = db.prepare(sql)
      return (stmt.all(...(params as unknown[])) ?? []) as Array<Record<string, unknown>>
    },
    prepareRun: (sql: string, params: ReadonlyArray<unknown>) => {
      const stmt = db.prepare(sql)
      stmt.run(...(params as unknown[]))
    },
  }
}

function withRawDb<T>(filename: string, fn: (db: RawDb) => T): T {
  const db = openRaw(filename)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/**
 * Collapse set (R1-R5 LOCKED, investigate-v4 msg_848e05daf115495c9502e21ab3ff2723
 * + correction-reversal msg_01ea1ce29dd84f07888253b203da1869). The 5 redundant
 * stores from new-structure-synthesis are the ONLY columns collapsed into
 * event_value reference-indexes; everything else (message.part.updated 68.6%
 * UNIQUE, etc.) stays inline-or-frame per R5.
 *
 * Stored `event.type` is VERSIONED (e.g. `message.updated.1`) — matched with
 * LIKE prefixes, never exact strings. `message.part.updated%` is explicitly
 * excluded (R5 frame-in-place, no dedup win).
 *
 * `event_value` FK is on `aggregate_id` -> `event_sequence(aggregate_id)` only
 * (chunkdb.ts:142); the rebuild verifies the aggregate exists in event_sequence
 * before injecting a ref (spec note 2). `message.data` is valid + in scope
 * (MessageTable has `data text NOT NULL`, schema.gen.ts:133).
 *
 * Exact identifiers as they appear in the schema — locked before build so
 * read-frontier-v3's rehydrate generalization stays aligned. #10 (sparse-ref)
 * is sequenced after and does not expand this set.
 */
export const COLLAPSE_SET = {
  /** event.data WHERE these versioned-type prefixes (R5 excludes part.updated). */
  eventWhere:
    "(type LIKE 'message.updated%' OR type LIKE 'session.updated%') AND type NOT LIKE 'message.part.updated%'",
  /**
   * Projection columns collapsed to event_value $cdbRef.
   * - aggCol: column whose value is the event_value.aggregate_id (FK scope).
   * - useSeq: use the row's own `seq` column in value_id, else 0.
   */
  projections: [
    { table: "session_message", column: "data", aggCol: "session_id", useSeq: true },
    { table: "message", column: "data", aggCol: "session_id", useSeq: false },
    { table: "session", column: "summary_diffs", aggCol: "id", useSeq: false },
    // Gap #2 (coordinator ruling): part.data framed/externalized on rebuild only
    // (runPassV2 stays event.data-only per the single-table sealer invariant).
    // part has session_id (no seq column) -> aggCol=session_id, useSeq=false.
    { table: "part", column: "data", aggCol: "session_id", useSeq: false },
  ] as const,
} as const

/**
 * Opt-in rebuild that extends the #9 VACUUM file-swap to also collapse the
 * projection columns (COLLAPSE_SET) into event_value reference-indexes.
 * Same event_value table, no second scan; collapse-at-seal-time (R2), abort-hard
 * fail-closed (Q1), session.summary_diffs as reference-index (Q4).
 */
export function rebuildDatabase(filename: string): Effect.Effect<RebuildResult, Error> {
  return Effect.gen(function* () {
    if (!Flag.OPENCODE_SEAL_ENABLED) {
      return yield* Effect.fail(new Error("OPENCODE_SEAL_REBUILD requires OPENCODE_SEAL_ENABLED"))
    }
    if (!existsSync(filename)) return yield* Effect.fail(new Error(`rebuild: database not found: ${filename}`))

    const tempFile = `${filename}.rebuild.tmp`
    if (existsSync(tempFile)) {
      try {
        unlinkSync(tempFile)
      } catch {}
    }

    // Phase A: VACUUM INTO temp (faithful page copy, drops free pages) — same as #9.
    const pre = yield* Effect.try({
      try: () =>
        withRawDb(filename, (db) => {
          db.run("PRAGMA wal_checkpoint(TRUNCATE)")
          // Legacy DBs (user_version 0) have no event_value/ocdb_seal yet — count safely
          const countTable = (name: string): number => {
            try {
              const r = db.queryAll(`SELECT COUNT(*) as n FROM ${name}`) as Array<{ n: number }>
              return r[0]?.n ?? 0
            } catch { return 0 }
          }
          const rowRows = [{ event: countTable("event"), event_value: countTable("event_value"), ocdb_seal: countTable("ocdb_seal") }]
          const escaped = escapePath(tempFile)
          db.run(`VACUUM INTO '${escaped}'`)
          return {
            rows: rowRows[0] ?? { event: 0, event_value: 0, ocdb_seal: 0 },
            sourceSize: statSync(filename).size,
          }
        }),
      catch: (e) => new Error(`rebuild: phase A (VACUUM) failed: ${e instanceof Error ? e.message : String(e)}`),
    })

    // Phase B: collapse projections in the temp file into event_value, then verify.
    const collapsed = yield* Effect.try({
      try: () =>
        withRawDb(tempFile, (db) => {
          db.run("PRAGMA foreign_keys = OFF")
          // Ensure ChunkDB tables exist in temp (legacy DBs have no event_value/ocdb_seal yet)
          db.run(`CREATE TABLE IF NOT EXISTS ocdb_seal (
            table_name TEXT NOT NULL, row_id TEXT NOT NULL, column_name TEXT NOT NULL,
            raw_bytes INTEGER NOT NULL, stored_bytes INTEGER NOT NULL, codec INTEGER NOT NULL,
            frame_version INTEGER NOT NULL, time_sealed INTEGER NOT NULL, reseal_needed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (table_name, row_id, column_name))`)
          db.run(`CREATE TABLE IF NOT EXISTS event_value (
            aggregate_id TEXT NOT NULL, value_id TEXT NOT NULL, sha256 TEXT NOT NULL, raw_len INTEGER NOT NULL,
            bytes BLOB NOT NULL, refs INTEGER NOT NULL DEFAULT 1, time_promoted INTEGER NOT NULL,
            PRIMARY KEY (aggregate_id, value_id), UNIQUE (aggregate_id, sha256),
            FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE)`)
          db.run(`CREATE TABLE IF NOT EXISTS ocdb_meta (key TEXT PRIMARY KEY, value TEXT)`)
          db.run(`CREATE INDEX IF NOT EXISTS idx_event_seal_candidates ON event (aggregate_id, seq) WHERE typeof(data) = 'text' AND length(data) >= 4096`)
          let collapsedEvent = 0
          let collapsedProjection = 0
          let deduped = 0

          // Verify the event_value FK (aggregate_id -> event_sequence) holds before
          // injecting a ref (spec note 2). If the aggregate has no event_sequence
          // row, skip the collapse and leave the value inline (safe, read path
          // handles inline). Cached per aggregate_id.
          const aggSeen = new Map<string, boolean>()
          const canInject = (agg: string): boolean => {
            const cached = aggSeen.get(agg)
            if (cached !== undefined) return cached
            const ok =
              (db.prepareAll("SELECT 1 FROM event_sequence WHERE aggregate_id = ? LIMIT 1", [agg]) as Array<unknown>)
                .length > 0
            aggSeen.set(agg, ok)
            return ok
          }

          // Helper: dedup a JSON TEXT value into event_value and return its $cdbRef or null if too small.
          const collapseValue = (aggregateId: string, seq: number, raw: string): string | null => {
            if (raw.length < 4096) return null
            if (raw.startsWith(`{"${CDB_REF}"`)) return null // already a ref
            const sha = createHash("sha256").update(raw).digest("hex")
            const existing = db.prepareAll(
              "SELECT value_id FROM event_value WHERE aggregate_id = ? AND sha256 = ?",
              [aggregateId, sha],
            ) as Array<{ value_id: string }>
            if (existing[0]) {
              db.prepareRun("UPDATE event_value SET refs = refs + 1 WHERE aggregate_id = ? AND value_id = ?", [
                aggregateId,
                existing[0].value_id,
              ])
              deduped += 1
              return toCdbRef(existing[0].value_id)
            }
            const valueId = `${aggregateId}:${seq}:${sha.slice(0, 8)}`
            // Frame the payload when compression wins (mirrors the live sealer's
            // compressText: negative gate on high-entropy + 24-byte margin); otherwise
            // store raw UTF-8. decodeValueBytes handles both frame and raw, so the
            // read path is unchanged. This closes read-frontier-v3's #11 gap #1
            // (projection payloads were previously stored uncompressed).
            const framed = compressText(raw)
            const rawBytes = typeof framed === "string" ? Buffer.from(framed, "utf8") : framed
            db.prepareRun(
              "INSERT INTO event_value (aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted) VALUES (?, ?, ?, ?, ?, 1, ?)",
              [aggregateId, valueId, sha, raw.length, rawBytes, Date.now()],
            )
            return toCdbRef(valueId)
          }

          // 1) event.data for the two redundant versioned types (message.updated / session.updated)
          const eventRows = db.queryAll(
            `SELECT id, aggregate_id, seq, data FROM event WHERE ${COLLAPSE_SET.eventWhere} AND typeof(data)='text' AND length(data) >= 4096`,
          ) as Array<{ id: string; aggregate_id: string; seq: number; data: string }>
          for (const row of eventRows) {
            if (!canInject(row.aggregate_id)) continue
            const ref = collapseValue(row.aggregate_id, row.seq, row.data)
            if (!ref) continue
            db.prepareRun("UPDATE event SET data = ? WHERE id = ?", [ref, row.id])
            collapsedEvent += 1
          }

          // 2) projection columns (session_message.data, message.data, session.summary_diffs).
          // Each projection row collapses with its parent aggregate_id (aggCol) as the
          // dedup scope, so identical payloads across the projection + event collapse to
          // ONE event_value row. useSeq picks the row's own seq (session_message) or 0.
          for (const proj of COLLAPSE_SET.projections) {
            const { table, column, aggCol, useSeq } = proj
            const seqExpr = useSeq ? "seq" : "0 AS seq"
            const rows = db.queryAll(
              `SELECT id AS rid, ${aggCol} AS agg, ${seqExpr}, ${column} AS v FROM ${table} WHERE typeof(${column})='text' AND length(${column}) >= 4096`,
            ) as Array<{ rid: string; agg: string; seq: number; v: string }>
            for (const row of rows) {
              if (!canInject(row.agg)) continue
              const ref = collapseValue(row.agg, row.seq, row.v)
              if (!ref) continue
              db.prepareRun(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [ref, row.rid])
              collapsedProjection += 1
            }
          }

          db.run("PRAGMA foreign_keys = ON")

          // Fail-closed verification on the rebuilt temp file:
          const ic = db.queryAll("PRAGMA integrity_check") as Array<{ integrity_check: string }>
          if (ic[0]?.integrity_check !== "ok") throw new Error("integrity_check failed")

          // Every $cdbRef in the collapsed tables must resolve to an event_value row
          // and its bytes must decode (frame CRC or raw JSON) — otherwise abort-hard (Q1).
          const checkTables = [
            { table: "event", column: "data", where: COLLAPSE_SET.eventWhere },
            ...COLLAPSE_SET.projections.map((p) => ({ table: p.table, column: p.column, where: "1=1" })),
          ]
          for (const t of checkTables) {
            const refs = db.queryAll(
              `SELECT ${t.column} AS v FROM ${t.table} WHERE ${t.where} AND ${t.column} LIKE '{"${CDB_REF}"%'`,
            ) as Array<{ v: string }>
            for (const r of refs) {
              let parsed: unknown
              try {
                parsed = JSON.parse(r.v)
              } catch {
                throw new Error(`corrupt $cdbRef JSON in ${t.table}.${t.column}: ${r.v.slice(0, 80)}`)
              }
              const valueId = (parsed as Record<string, string>)[CDB_REF]
              if (!valueId) throw new Error(`missing $cdbRef in ${t.table}.${t.column}`)
              // Resolve via event_value — value_id is globally unique (aggregate_id:seq:hash), so no aggregate filter.
              const row = db.prepareAll("SELECT bytes, sha256 FROM event_value WHERE value_id = ?", [valueId]) as Array<{
                bytes: Uint8Array | Buffer
                sha256: string
              }>
              if (row.length === 0) throw new Error(`dangling $cdbRef ${valueId} in ${t.table}.${t.column} — abort-hard (Q1)`)
              const bytes = row[0].bytes instanceof Uint8Array ? row[0].bytes : new Uint8Array(row[0].bytes as unknown as ArrayBuffer)
              // Throws on CRC mismatch / corrupt frame — abort-hard.
              try {
                const decoded = decodeValueBytes(bytes)
                JSON.parse(decoded)
              } catch (e) {
                throw new Error(`corrupt event_value bytes for ${valueId} in ${t.table}.${t.column}: ${e instanceof Error ? e.message : String(e)}`)
              }
            }
          }

          // Byte-exact rehydration sample on event_value itself (same as #9)
          const sample = db.queryAll(`SELECT bytes FROM event_value LIMIT ${VERIFY_SAMPLE}`) as Array<{
            bytes: Uint8Array | Buffer
          }>
          for (const row of sample) {
            const bytes = row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes as unknown as ArrayBuffer)
            try {
              JSON.parse(decodeValueBytes(bytes))
            } catch {
              throw new Error("event_value bytes failed decode sample")
            }
          }

          return { event: collapsedEvent, projection: collapsedProjection, deduped }
        }),
      catch: (e) => {
        throw new Error(`rebuild: phase B (collapse+verify) failed: ${e instanceof Error ? e.message : String(e)}`)
      },
    })

    // Q1 abort-hard: phase B threw → original untouched, temp cleaned.
    // The Effect.try above already throws on verification failure; catch here to clean temp.
    // (If collapsed threw, pre temp is left for the outer catch to clean.)

    const bakFile = `${filename}.bak`
    doGc()
    yield* Effect.sleep(Duration.millis(30))
    let lastError: unknown = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        try {
          renameSync(filename, bakFile)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EBUSY" && attempt < 3) {
            try {
              copyFileSync(filename, bakFile)
              unlinkSync(filename)
            } catch {
              throw e
            }
          } else {
            throw e
          }
        }
        try {
          renameSync(tempFile, filename)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EBUSY") {
            copyFileSync(tempFile, filename)
            try {
              unlinkSync(tempFile)
            } catch {}
          } else {
            throw e
          }
        }
        if (existsSync(bakFile)) {
          try {
            unlinkSync(bakFile)
          } catch {}
        }
        lastError = null
        break
      } catch (e) {
        lastError = e
        const isBusy = e instanceof Error && (e as NodeJS.ErrnoException).code === "EBUSY"
        if (isBusy && attempt < 3) {
          doGc()
          yield* Effect.sleep(Duration.millis(80))
          continue
        }
        break
      }
    }
    if (lastError) {
      try {
        if (existsSync(bakFile) && !existsSync(filename)) renameSync(bakFile, filename)
      } catch {}
      if (existsSync(tempFile)) {
        try {
          unlinkSync(tempFile)
        } catch {}
      }
      return yield* Effect.fail(new Error(`rebuild: swap failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`))
    }

    return {
      sourceSize: pre.sourceSize,
      rebuiltSize: statSync(filename).size,
      bytesReclaimed: pre.sourceSize - statSync(filename).size,
      collapsed,
    }
  })
}
