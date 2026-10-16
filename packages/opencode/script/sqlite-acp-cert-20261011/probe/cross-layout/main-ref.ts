import { Worker } from "node:worker_threads"

const tag = "main-ref"
const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { tag } })

const timer = setTimeout(() => {
  console.log(JSON.stringify({ case: tag, ok: false, error: "timeout" }))
  process.exit(3)
}, 15_000)

worker.on("message", (message: { pong?: boolean }) => {
  clearTimeout(timer)
  console.log(JSON.stringify({ case: tag, ok: message?.pong === true, importMetaUrl: import.meta.url }))
  void worker.terminate()
})

worker.on("error", (error: Error) => {
  clearTimeout(timer)
  console.log(
    JSON.stringify({
      case: tag,
      ok: false,
      message: error.message,
      cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
    }),
  )
  process.exit(2)
})
