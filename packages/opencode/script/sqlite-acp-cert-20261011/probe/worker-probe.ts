// Minimal compiled-worker probe. Instantiates the REAL production
// SqliteBunWorkerClient against a disposable database and prints the full
// cause chain so the harness can distinguish:
//   - worker module embedding / URL resolution failure (cause: module not found)
//   - native SQLite open failure inside the worker (cause: sqlite error)
//   - a working worker (GREEN)
//
// Run standalone (source mode) or as a Bun --compile executable produced by
// probe/compile-probe.ts. The database path is argv[2].

import { SqliteBunWorkerClient } from "../../../../core/src/database/sqlite-bun-worker-client"

const dbPath = process.argv[2]
if (!dbPath) {
  console.error("usage: worker-probe <database-path>")
  process.exit(64)
}

const banner = {
  probe: "worker-embed",
  importMetaUrl: import.meta.url,
  execPath: process.execPath,
  bunVersion: process.versions.bun,
  platform: process.platform,
  arch: process.arch,
}
console.log(JSON.stringify(banner))

function describe(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return { message: "<cause chain truncated>" }
  if (error instanceof Error) {
    const record: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stackTop: error.stack?.split("\n").slice(0, 4).join(" | "),
    }
    if (error.cause !== undefined && error.cause !== error) record.cause = describe(error.cause, depth + 1)
    return record
  }
  return { value: String(error) }
}

const client = new SqliteBunWorkerClient({ filename: dbPath, disableWAL: true, checkpointOnClose: false })
try {
  await client.ready
  console.log(JSON.stringify({ stage: "ready", ok: true }))
  await client.request({
    kind: "query",
    query: "CREATE TABLE IF NOT EXISTS probe(id INTEGER)",
    params: [],
    arrays: false,
    safeIntegers: false,
  })
  await client.request({
    kind: "query",
    query: "INSERT INTO probe VALUES(7)",
    params: [],
    arrays: false,
    safeIntegers: false,
  })
  const rows = await client.request<Array<{ id: number }>>({
    kind: "query",
    query: "SELECT id FROM probe",
    params: [],
    arrays: false,
    safeIntegers: false,
  })
  if (rows.length !== 1 || rows[0]?.id !== 7) throw new Error("SQL round-trip mismatch")
  console.log(JSON.stringify({ stage: "query", ok: true, rows }))
} catch (error) {
  console.log(JSON.stringify({ stage: "failed", ok: false, error: describe(error) }))
  process.exitCode = 2
} finally {
  await client.close().catch(() => {})
}
