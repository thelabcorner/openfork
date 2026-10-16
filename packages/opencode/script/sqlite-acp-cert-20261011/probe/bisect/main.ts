// Bisection probe main: identical logic to probe/worker-probe.ts but importing
// the verbatim lane copy of the production client/worker pair.

import { SqliteBunWorkerClient } from "./sqlite-bun-worker-client"

const dbPath = process.argv[2]
if (!dbPath) process.exit(64)

console.log(JSON.stringify({ probe: "bisect", importMetaUrl: import.meta.url, execPath: process.execPath }))

function describe(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return { message: "<truncated>" }
  if (error instanceof Error) {
    const record: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stackTop: error.stack?.split("\n").slice(0, 3).join(" | "),
    }
    if (error.cause !== undefined && error.cause !== error) record.cause = describe(error.cause, depth + 1)
    return record
  }
  return { value: String(error) }
}

const client = new SqliteBunWorkerClient({ filename: dbPath, disableWAL: true, checkpointOnClose: false })
try {
  await client.ready
  await client.request({
    kind: "query",
    query: "CREATE TABLE IF NOT EXISTS probe(id INTEGER)",
    params: [],
    arrays: false,
    safeIntegers: false,
  })
  const rows = await client.request<Array<{ id: number }>>({
    kind: "query",
    query: "SELECT 7 AS id",
    params: [],
    arrays: false,
    safeIntegers: false,
  })
  console.log(JSON.stringify({ probe: "bisect", ok: true, rows }))
} catch (error) {
  console.log(JSON.stringify({ probe: "bisect", ok: false, error: describe(error) }))
  process.exitCode = 2
} finally {
  await client.close().catch(() => {})
}
