import { Worker } from "node:worker_threads"

export function startWorker(tag: string) {
  return new Worker(new URL("./worker.ts", import.meta.url), { workerData: { tag } })
}
