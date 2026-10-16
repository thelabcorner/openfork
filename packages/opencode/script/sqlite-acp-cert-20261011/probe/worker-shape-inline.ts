// Call-shape probe A: inline `new Worker(new URL(...), ...)` constructor call.
// Same real worker module as production; only the call shape differs.

import { Worker } from "node:worker_threads"
import type { SqliteWorkerOptions } from "../../../../core/src/database/sqlite-worker-client"

const dbPath = process.argv[2]
if (!dbPath) process.exit(64)
const options: SqliteWorkerOptions = { filename: dbPath, disableWAL: true, checkpointOnClose: false }

console.log(JSON.stringify({ shape: "inline", importMetaUrl: import.meta.url }))

const worker = new Worker(new URL("../../../../core/src/database/sqlite-bun-worker.ts", import.meta.url), {
  workerData: options,
})

const timer = setTimeout(() => {
  console.log(JSON.stringify({ shape: "inline", ok: false, error: "timeout waiting for worker ready" }))
  process.exit(3)
}, 15_000)

worker.on("message", (message: { ready?: boolean; error?: unknown }) => {
  if (!("ready" in message)) return
  clearTimeout(timer)
  if (message.ready) {
    console.log(JSON.stringify({ shape: "inline", ok: true, ready: true }))
    void worker.terminate()
    return
  }
  console.log(JSON.stringify({ shape: "inline", ok: false, error: JSON.stringify(message.error) }))
  process.exit(2)
})

worker.on("error", (error: Error) => {
  clearTimeout(timer)
  console.log(
    JSON.stringify({
      shape: "inline",
      ok: false,
      name: error.name,
      message: error.message,
      cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
    }),
  )
  process.exit(2)
})
