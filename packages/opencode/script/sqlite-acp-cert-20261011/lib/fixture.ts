/// <reference types="bun" />
// Disposable fixture database + independent external-connection probes.
// Everything here operates on uniquely named OS-temp fixtures only. No user
// database path is ever opened, inspected, or mutated.

import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { workRoot } from "./work"

export type Fixture = {
  readonly root: string
  readonly db: string
  readonly workspace: string
  readonly home: string
  readonly label: string
  dispose: () => Promise<void>
}

export type SqlProbeResult = {
  ok: boolean
  elapsedMs: number
  error?: string
  sqliteCode?: string
}

export async function createFixture(label: string): Promise<Fixture> {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)
  const unique = randomBytes(5).toString("hex")
  const parent = join(workRoot(), "fixtures")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, `${label}-${stamp}-${unique}-`))
  const workspace = join(root, "workspace")
  const home = join(root, "home")
  await mkdir(workspace, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(join(root, "tmp"), { recursive: true })
  return {
    root,
    db: join(root, "cert.sqlite"),
    workspace,
    home,
    label,
    dispose: async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

function openReadonly(path: string): Database {
  return new Database(path, { readonly: true })
}

export function listTables(path: string): string[] {
  const db = openReadonly(path)
  try {
    const rows = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    return rows.map((row) => row.name)
  } finally {
    db.close()
  }
}

export function countRows(path: string, table: string): number | undefined {
  const db = openReadonly(path)
  try {
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`unsafe table name ${table}`)
    if (!listTables(path).includes(table)) return undefined
    const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM "${table}"`).get()
    return row?.count
  } finally {
    db.close()
  }
}

export type IntegrityResult = {
  ok: boolean
  integrity: string[]
  foreignKeyIssues: string[]
  error?: string
}

export function integrityCheck(path: string): IntegrityResult {
  try {
    const db = openReadonly(path)
    try {
      const integrity = db
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check)
      const foreignKeyIssues = db
        .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
        .all()
        .map((row) => JSON.stringify(row))
      return { ok: integrity.length === 1 && integrity[0] === "ok" && foreignKeyIssues.length === 0, integrity, foreignKeyIssues }
    } finally {
      db.close()
    }
  } catch (error) {
    return { ok: false, integrity: [], foreignKeyIssues: [], error: String(error) }
  }
}

// External independent connection probe: prove the host released the writer
// reservation by acquiring an immediate transaction and committing one row.
// This is the peer-writer scenario from the ACP concurrency contract.
export async function externalWriteProbe(
  path: string,
  options: { busyTimeoutMs: number; holdMs?: number; table?: string },
): Promise<SqlProbeResult> {
  const table = options.table ?? "cert_external_probe"
  const started = performance.now()
  const db = new Database(path)
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(options.busyTimeoutMs))}`)
    db.exec(`CREATE TABLE IF NOT EXISTS "${table}"(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL)`)
    db.exec("BEGIN IMMEDIATE")
    db.exec(`INSERT INTO "${table}"(at) VALUES (datetime('now'))`)
    if (options.holdMs && options.holdMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.holdMs))
    }
    db.exec("COMMIT")
    return { ok: true, elapsedMs: performance.now() - started }
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {}
    const sqlite = error as { code?: string }
    return {
      ok: false,
      elapsedMs: performance.now() - started,
      error: String(error),
      sqliteCode: sqlite?.code,
    }
  } finally {
    db.close()
  }
}

export type WriterLock = {
  release: () => Promise<void>
  acquiredMs: number
}

// Acquire and hold the SQLite writer reservation from an independent process
// connection. Used to force the host into the native-busy state while protocol
// probes measure whether its event loop stays responsive.
export async function acquireWriterLock(path: string, busyTimeoutMs: number): Promise<WriterLock> {
  const started = performance.now()
  const db = new Database(path)
  db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(busyTimeoutMs))}`)
  db.exec("CREATE TABLE IF NOT EXISTS cert_external_probe(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL)")
  db.exec("BEGIN IMMEDIATE")
  db.exec("INSERT INTO cert_external_probe(at) VALUES (datetime('now'))")
  let released = false
  return {
    acquiredMs: performance.now() - started,
    release: async () => {
      if (released) return
      released = true
      try {
        db.exec("COMMIT")
      } finally {
        db.close()
      }
    },
  }
}
