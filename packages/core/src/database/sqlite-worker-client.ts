import { Worker } from "node:worker_threads"

export interface SqliteWorkerOptions {
  readonly filename: string
  readonly readonly?: boolean
  readonly timeout?: number
  readonly allowExtension?: boolean
  readonly disableWAL?: boolean
  readonly checkpointOnClose?: boolean
  readonly createTimePragmas?: { readonly page_size: number; readonly auto_vacuum: number }
}

// A self-contained Node worker avoids depending on source-tree paths in the
// single-file sidecar/Electron bundles. Only native SQL runs here; domain state,
// leases, migration policy and transaction admission remain with their owners.
const source = String.raw`
const { parentPort, workerData: config } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
const statements = new Map();
const error = (cause) => ({
  name: cause?.name, message: cause?.message,
  code: cause?.code, errno: cause?.errno, errcode: cause?.errcode,
});
try {
  db = new DatabaseSync(config.filename, {
    readOnly: config.readonly, timeout: config.timeout,
    allowExtension: config.allowExtension,
    enableForeignKeyConstraints: true, open: true,
  });
  if (config.createTimePragmas) {
    for (const [key, value] of Object.entries(config.createTimePragmas)) {
      try { db.exec('PRAGMA ' + key + ' = ' + value); }
      catch (cause) {
        if (cause?.code !== 'SQLITE_BUSY' && cause?.errcode !== 5 && cause?.errno !== 5) throw cause;
      }
    }
  }
  if (config.disableWAL !== true && config.readonly !== true) db.exec('PRAGMA journal_mode = WAL;');
  parentPort.postMessage({ ready: true });
} catch (cause) {
  parentPort.postMessage({ ready: false, error: error(cause) });
  try { db?.close(); } catch {}
  parentPort.close();
}
parentPort.on('message', (request) => {
  try {
    let value;
    if (request.kind === 'close') {
      statements.clear();
      if (config.checkpointOnClose !== false) {
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
      }
      db.close();
    } else if (request.kind === 'extension') {
      db.loadExtension(request.path);
    } else {
      const key = (request.arrays ? 'a:' : 'o:') + request.query;
      let statement = statements.get(key);
      if (statement) { statements.delete(key); statements.set(key, statement); }
      else {
        statement = db.prepare(request.query);
        if (request.arrays) statement.setReturnArrays(true);
        if (request.query.length <= 16 * 1024) {
          statements.set(key, statement);
          if (statements.size > 128) statements.delete(statements.keys().next().value);
        }
      }
      statement.setReadBigInts(request.safeIntegers);
      value = statement.all(...request.params);
    }
    parentPort.postMessage({ id: request.id, value });
    if (request.kind === 'close') parentPort.close();
  } catch (cause) {
    parentPort.postMessage({ id: request.id, error: error(cause) });
  }
});
`

type Request =
  | { kind: "query"; query: string; params: ReadonlyArray<unknown>; arrays: boolean; safeIntegers: boolean }
  | { kind: "extension"; path: string }
  | { kind: "close" }

function restoreError(value: Record<string, unknown>) {
  return Object.assign(new Error(typeof value.message === "string" ? value.message : "SQLite worker failed"), value)
}

export class SqliteWorkerClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  private nextID = 0
  private failed: Error | undefined
  private closing = false
  private closePromise: Promise<void> | undefined
  readonly ready: Promise<void>

  constructor(options: SqliteWorkerOptions) {
    this.worker = new Worker(source, { eval: true, workerData: options })
    this.ready = new Promise((resolve, reject) => {
      this.worker.on("message", (message) => {
        if ("ready" in message) {
          if (message.ready) resolve()
          else { const error = restoreError(message.error); reject(error); this.fail(error) }
          return
        }
        const job = this.pending.get(message.id)
        if (!job) return
        this.pending.delete(message.id)
        if (message.error) job.reject(restoreError(message.error))
        else job.resolve(message.value)
      })
      this.worker.on("error", (error) => { reject(error); this.fail(error) })
      this.worker.on("exit", (code) => {
        if (this.closing && code === 0 && this.pending.size === 0) return
        const error = new Error(`SQLite worker exited (${code})`)
        reject(error)
        this.fail(error)
      })
    })
  }

  private fail(error: Error) {
    this.failed ??= error
    for (const job of this.pending.values()) job.reject(error)
    this.pending.clear()
  }

  async request(request: Request): Promise<unknown> {
    await this.ready
    if (this.failed) throw this.failed
    if (this.closing && request.kind !== "close") throw new Error("SQLite connection is closing")
    // Normal SQL admission holds one scoped connection permit. This final cap
    // also bounds parallel queries issued inside a transaction or raw callers.
    if (request.kind !== "close" && this.pending.size >= 64) throw new Error("SQLite worker admission capacity exceeded")
    const id = ++this.nextID
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.worker.postMessage({ ...request, id }) }
      catch (error) { this.pending.delete(id); reject(error) }
    })
  }

  close(): Promise<void> {
    return this.closePromise ??= this.closeOnce()
  }

  private async closeOnce() {
    this.closing = true
    try { await this.request({ kind: "close" }) }
    finally { await this.worker.terminate() }
  }
}
