import { Worker } from "node:worker_threads"

const form = "href"
const worker = new Worker(new URL("./docs-worker.ts", import.meta.url).href)

const timer = setTimeout(() => {
  console.log(JSON.stringify({ form, ok: false, error: "timeout" }))
  process.exit(3)
}, 15_000)

worker.on("message", (message: { pong?: boolean }) => {
  clearTimeout(timer)
  console.log(JSON.stringify({ form, ok: message?.pong === true, importMetaUrl: import.meta.url }))
  void worker.terminate()
})

worker.on("error", (error: Error) => {
  clearTimeout(timer)
  console.log(
    JSON.stringify({
      form,
      ok: false,
      message: error.message,
      cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
    }),
  )
  process.exit(2)
})
