// Shared worker-thread protocol for the Node SQLite sidecar. The client owns
// admission lifecycle and liveness; this module owns the message schema and
// the self-contained worker source so both sides stay in lockstep.

export type Request =
  | { kind: "query"; query: string; params: ReadonlyArray<unknown>; arrays: boolean; safeIntegers: boolean }
  | { kind: "extension"; path: string }
  | { kind: "close" }

export type Response =
  | { ready: boolean; error?: Record<string, unknown> }
  | { id: number; value?: unknown; error?: Record<string, unknown> }

const error = (cause: unknown) => ({
  name: (cause as { name?: string })?.name,
  message: (cause as { message?: string })?.message,
  code: (cause as { code?: string })?.code,
  errno: (cause as { errno?: number })?.errno,
  errcode: (cause as { errcode?: number })?.errcode,
})

export function restoreError(value: Record<string, unknown>): Error {
  return Object.assign(new Error(typeof value.message === "string" ? value.message : "SQLite worker failed"), value)
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

export { source as sqliteWorkerSource, error as workerError }
