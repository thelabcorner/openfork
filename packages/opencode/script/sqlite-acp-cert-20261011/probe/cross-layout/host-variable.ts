import { Worker } from "node:worker_threads"

// Production client shape: the URL is materialized at module scope into a const,
// then consumed by the Worker constructor. The call site is this imported
// module, not the main entry.
const workerUrl = new URL("./worker.ts", import.meta.url)

export function startWorker(tag: string) {
  return new Worker(workerUrl, { workerData: { tag } })
}
