// TUI-style worker launch under naming collapse: the TUI calls
// `new Worker(OPENCODE_WORKER_PATH)` with a runtime string. Verify that a
// define value of "./worker.js" (or "./worker.ts" via extension substitution)
// resolves the basename-collapsed entry emitted by `naming: entry`.

import { Worker } from "node:worker_threads"

const file = process.argv[2] ?? "./worker.js"
const worker = new Worker(file)

const timer = setTimeout(() => {
  console.log(JSON.stringify({ file, ok: false, error: "timeout" }))
  process.exit(3)
}, 15_000)

worker.on("message", (message: { pong?: boolean }) => {
  clearTimeout(timer)
  console.log(JSON.stringify({ file, ok: message?.pong === true, importMetaUrl: import.meta.url }))
  void worker.terminate()
})

worker.on("error", (error: Error) => {
  clearTimeout(timer)
  console.log(
    JSON.stringify({
      file,
      ok: false,
      message: error.message,
      cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
    }),
  )
  process.exit(2)
})
