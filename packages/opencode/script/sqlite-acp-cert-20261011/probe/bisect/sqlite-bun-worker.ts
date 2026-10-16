/**
 * Native SQLite executor for Bun. The primary runtime must never synchronously
 * wait on a WAL writer lock owned by another Effect fiber or process.
 *
 * One Worker owns exactly one native connection and its transaction state.
 * All requests are processed in FIFO order. Admission/transaction lifetimes
 * belong to the parent Effect SQL adapter, not to this executor.
 */
import { parentPort, workerData } from "node:worker_threads"
import { Database } from "bun:sqlite"
import type { SqliteWorkerOptions } from "./sqlite-worker-client"
import { summarizeSqlitePlan, unavailableSqlitePlan } from "./sqlite-query-forensics"

type Query = {
  kind: "query"
  id: number
  query: string
  params: readonly unknown[]
  arrays: boolean
  safeIntegers: boolean
  diagnosePlan?: string
}
type Request =
  | Query
  | { kind: "extension"; id: number; path: string }
  | { kind: "serialize"; id: number }
  | { kind: "close"; id: number }

const port = parentPort
if (!port) throw new Error("sqlite-bun-worker must execute inside a Worker")
const options = workerData as SqliteWorkerOptions
let database: Database | undefined
const cache = new Map<string, ReturnType<Database["query"]>>()
const diagnosed = new Set<string>()
const error = (cause: unknown) => {
  const native = cause as { name?: string; message?: string; code?: string; errno?: number; errcode?: number }
  return {
    name: native?.name,
    message: native?.message,
    code: native?.code,
    errno: native?.errno,
    errcode: native?.errcode,
  }
}

try {
  const db = new Database(options.filename, {
    readonly: options.readonly,
    readwrite: options.readwrite ?? true,
    create: options.create ?? true,
  })
  database = db
  if (options.createTimePragmas) {
    for (const [key, value] of Object.entries(options.createTimePragmas)) {
      try {
        db.run(`PRAGMA ${key} = ${value}`)
      } catch (cause) {
        const native = cause as { code?: string; errno?: number }
        if (native?.code !== "SQLITE_BUSY" && native?.errno !== 5) throw cause
      }
    }
  }
  if (options.disableWAL !== true && options.readonly !== true) db.run("PRAGMA journal_mode = WAL")
  port.postMessage({ ready: true })
} catch (cause) {
  port.postMessage({ ready: false, error: error(cause) })
  try { database?.close() } catch {}
  port.close()
}

if (database) {
  const db = database
  port.on("message", (request: Request) => {
    try {
      if (request.kind === "close") {
        cache.clear()
        if (options.checkpointOnClose !== false) {
          try { db.run("PRAGMA wal_checkpoint(TRUNCATE)") } catch {}
        }
        db.close()
        port.postMessage({ id: request.id })
        port.close()
        return
      }
      if (request.kind === "extension") {
        db.loadExtension(request.path)
        port.postMessage({ id: request.id })
        return
      }
      if (request.kind === "serialize") {
        port.postMessage({ id: request.id, value: db.serialize() })
        return
      }
      if (request.diagnosePlan && !diagnosed.has(request.diagnosePlan)) {
        const hash = request.diagnosePlan
        diagnosed.add(hash)
        let result
        try {
          const rows = db.query("EXPLAIN QUERY PLAN " + request.query).all(...request.params as any[]) as Array<{ detail?: unknown }>
          result = summarizeSqlitePlan(hash, rows)
        } catch {
          result = unavailableSqlitePlan(hash)
        }
        port.postMessage({ planDiagnostic: result })
      }
      const key = (request.arrays ? "a:" : "o:") + request.query
      let statement = cache.get(key)
      if (statement) {
        cache.delete(key)
        cache.set(key, statement)
      } else {
        statement = db.query(request.query)
        if (request.query.length <= 16 * 1024) {
          cache.set(key, statement)
          if (cache.size > 128) cache.delete(cache.keys().next().value!)
        }
      }
      // @ts-ignore Bun exposes this at runtime; its Statement type omits it.
      statement.safeIntegers(request.safeIntegers)
      const params = request.params as any[]
      const value = request.arrays ? statement.values(...params) : statement.all(...params)
      port.postMessage({ id: request.id, value })
    } catch (cause) {
      port.postMessage({ id: request.id, error: error(cause) })
    }
  })
}
