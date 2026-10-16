import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SqliteBunWorkerClient } from "../../src/database/sqlite-bun-worker-client"

const folder = mkdtempSync(join(tmpdir(), "openfork-sqlite-standalone-"))
try {
  const worker = new SqliteBunWorkerClient({
    filename: join(folder, "probe.sqlite"),
    disableWAL: true,
    checkpointOnClose: false,
  })
  try {
    await worker.ready
    await worker.request({ kind: "query", query: "CREATE TABLE probe(id INTEGER)", params: [], arrays: false, safeIntegers: false })
    await worker.request({ kind: "query", query: "INSERT INTO probe VALUES(7)", params: [], arrays: false, safeIntegers: false })
    const rows = await worker.request<Array<{ id: number }>>({
      kind: "query", query: "SELECT id FROM probe", params: [], arrays: false, safeIntegers: false,
    })
    if (rows.length !== 1 || rows[0]?.id !== 7) throw new Error("standalone SQL round-trip failed")
    console.log("standalone Bun SQLite worker passed")
  } finally { await worker.close() }
} finally { rmSync(folder, { recursive: true, force: true }) }