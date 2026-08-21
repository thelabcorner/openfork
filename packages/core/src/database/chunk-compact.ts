/**
 * Epoch-3 (Phase-2, #9): opt-in, flag-gated shrink for EXISTING databases.
 *
 * Existing DBs created before epoch-3 open with `auto_vacuum = 0`, so
 * `reclaimSpace`'s `incremental_vacuum` is a no-op — promotion frees pages
 * internally but the file NEVER shrinks. This module closes that gap with a
 * one-shot, opt-in `VACUUM INTO` rebuild, now using raw SQLite connections
 * with deterministic close() so the file is never held open on Windows.
 */
import { Duration, Effect } from "effect"
import { renameSync, unlinkSync, existsSync, statSync, copyFileSync } from "node:fs"
import { createRequire } from "node:module"
import { decodeValueBytes } from "./json-codec"
import { Flag } from "../flag/flag"

const require = createRequire(import.meta.url)

export interface CompactResult {
  readonly sourceSize: number
  readonly compactedSize: number
  readonly bytesReclaimed: number
  readonly freelistBefore: number
  readonly rows: { event: number; event_value: number; ocdb_seal: number }
}

const VERIFY_SAMPLE = 1000

function escapePath(p: string): string {
  return p.replace(/'/g, "''")
}

type RawDb = {
  close: () => void
  run: (sql: string) => void
  exec: (sql: string) => void
  queryAll: (sql: string) => Array<Record<string, unknown>>
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
  // Try bun:sqlite first (desktop / bun runtime).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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
    }
  } catch {}
  // Fallback to node:sqlite (Node 22+).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

export function compactDatabase(filename: string): Effect.Effect<CompactResult, Error> {
  return Effect.gen(function* () {
    if (!Flag.OPENCODE_SEAL_ENABLED) {
      return yield* Effect.fail(new Error("OPENCODE_SEAL_COMPACT requires OPENCODE_SEAL_ENABLED"))
    }
    if (!existsSync(filename)) return yield* Effect.fail(new Error(`compact: database not found: ${filename}`))

    const tempFile = `${filename}.compact.tmp`
    if (existsSync(tempFile)) {
      try {
        unlinkSync(tempFile)
      } catch {}
    }

    // --- Phase A: checkpoint + VACUUM INTO temp + metrics (raw connection, deterministic close) ---
    const pre = yield* Effect.try({
      try: () =>
        withRawDb(filename, (db) => {
          db.run("PRAGMA wal_checkpoint(TRUNCATE)")
          const freelistRows = db.queryAll("PRAGMA freelist_count") as Array<{ freelist_count: number }>
          const rowRows = db.queryAll(
            "SELECT (SELECT COUNT(*) FROM event) AS event, (SELECT COUNT(*) FROM event_value) AS event_value, (SELECT COUNT(*) FROM ocdb_seal) AS ocdb_seal",
          ) as Array<{ event: number; event_value: number; ocdb_seal: number }>
          const escaped = escapePath(tempFile)
          db.run(`VACUUM INTO '${escaped}'`)
          return {
            freelist: freelistRows[0]?.freelist_count ?? 0,
            rows: rowRows[0] ?? { event: 0, event_value: 0, ocdb_seal: 0 },
            sourceSize: statSync(filename).size,
          }
        }),
      catch: (e) => new Error(`compact: phase A failed: ${e instanceof Error ? e.message : String(e)}`),
    })

    // --- Phase B: verify rebuilt file on a SEPARATE raw connection ---
    const ok = yield* Effect.try({
      try: () =>
        withRawDb(tempFile, (db) => {
          const ic = db.queryAll("PRAGMA integrity_check") as Array<{ integrity_check: string }>
          if (ic[0]?.integrity_check !== "ok") return false

          // Row-count parity vs source (no drizzle migrations — VACUUM INTO preserves schema + user_version)
          const counts = db.queryAll(
            "SELECT (SELECT COUNT(*) FROM event) AS event, (SELECT COUNT(*) FROM event_value) AS event_value, (SELECT COUNT(*) FROM ocdb_seal) AS ocdb_seal",
          ) as Array<{ event: number; event_value: number; ocdb_seal: number }>
          const c = counts[0]
          if (!c) return false
          if (c.event !== pre.rows.event || c.event_value !== pre.rows.event_value || c.ocdb_seal !== pre.rows.ocdb_seal) return false

          // Byte-exact rehydration sample
          const sample = db.queryAll(`SELECT bytes FROM event_value LIMIT ${VERIFY_SAMPLE}`) as Array<{
            bytes: Uint8Array | Buffer
          }>
          for (const row of sample) {
            const bytes = row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes as unknown as ArrayBuffer)
            try {
              JSON.parse(decodeValueBytes(bytes))
            } catch {
              return false
            }
          }
          return true
        }),
      catch: (e) => {
        throw new Error(`compact: phase B failed: ${e instanceof Error ? e.message : String(e)}`)
      },
    })

    if (!ok) {
      if (existsSync(tempFile)) {
        try {
          unlinkSync(tempFile)
        } catch {}
      }
      return yield* Effect.fail(new Error("compact: rebuilt file failed verification; original left untouched"))
    }

    const bakFile = `${filename}.bak`
    // Ensure any lingering drizzle handles from prior layers are GC'd before the swap.
    doGc()
    // Give Windows a tick to release handles after GC.
    yield* Effect.sleep(Duration.millis(30))
    let lastError: unknown = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // Windows: the main DB file may still be held by a lingering handle.
        // Use copy+unlink fallback if rename fails with EBUSY.
        try {
          renameSync(filename, bakFile)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EBUSY" && attempt < 3) {
            // Fallback: copy source to bak, then unlink source if copy succeeded.
            // This works even when the file is held open for reading on Windows
            // in some cases where rename doesn't.
            try {
              copyFileSync(filename, bakFile)
              unlinkSync(filename)
            } catch (copyErr) {
              throw e
            }
          } else {
            throw e
          }
        }
        try {
          renameSync(tempFile, filename)
        } catch (e) {
          // Try copy fallback for temp -> filename as well.
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
      return yield* Effect.fail(new Error(`compact: swap failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`))
    }

    return {
      sourceSize: pre.sourceSize,
      compactedSize: statSync(filename).size,
      bytesReclaimed: pre.sourceSize - statSync(filename).size,
      freelistBefore: pre.freelist,
      rows: pre.rows,
    }
  })
}
