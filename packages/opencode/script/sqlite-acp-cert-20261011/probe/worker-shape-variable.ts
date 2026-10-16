// Call-shape probe B: production shape — the URL is materialized into a `const`
// first, then passed to `new Worker(workerUrl, ...)`. Same target module as
// probe/worker-shape-inline.ts; only the call shape differs.

import { Worker } from "node:worker_threads"
import type { SqliteWorkerOptions } from "../../../../core/src/database/sqlite-worker-client"

const dbPath = process.argv[2]
if (!dbPath) process.exit(64)
const options: SqliteWorkerOptions = { filename: dbPath, disableWAL: true, checkpointOnClose: false }

const workerUrl = new URL("../../../../core/src/database/sqlite-bun-worker.ts", import.meta.url)

console.log(JSON.stringify({ shape: "variable", importMetaUrl: import.meta.url }))

const worker = new Worker(workerUrl, { workerData: options })

const timer = setTimeout(() => {
  console.log(JSON.stringify({ shape: "variable", ok: false, error: "timeout waiting for worker ready" }))
  process.exit(3)
}, 15_000)

worker.on("message", (message: { ready?: boolean; error?: unknown }) => {
  if (!("ready" in message)) return
  clearTimeout(timer)
  if (message.ready) {
    console.log(JSON.stringify({ shape: "variable", ok: true, ready: true }))
    void worker.terminate()
    return
  }
  console.log(JSON.stringify({ shape: "variable", ok: false, error: JSON.stringify(message.error) }))
  process.exit(2)
})

worker.on("error", (error: Error) => {
  clearTimeout(timer)
  console.log(
    JSON.stringify({
      shape: "variable",
      ok: false,
      name: error.name,
      message: error.message,
      cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
    }),
  )
  process.exit(2)
})
