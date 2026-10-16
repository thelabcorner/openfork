import { Worker } from "node:worker_threads"
import * as Effect from "effect/Effect"
import type { SqliteWorkerOptions } from "./sqlite-worker-client"
import type { SqlitePlanDiagnostic } from "./sqlite-query-forensics"

// This exact source-relative URL is also the embedded worker entrypoint in
// Bun's standalone compiler. Avoid a runtime-computed path: the compiler
// requires an explicitly included worker file and a stable reference.
const workerUrl = new URL("./sqlite-bun-worker.ts", import.meta.url)

type Request =
  | { kind: "query"; query: string; params: ReadonlyArray<unknown>; arrays: boolean; safeIntegers: boolean; diagnosePlan?: string }
  | { kind: "extension"; path: string }
  | { kind: "serialize" }
  | { kind: "close" }

const restoreError = (value: Record<string, unknown>): Error =>
  Object.assign(new Error(typeof value.message === "string" ? value.message : "SQLite worker failure"), value)

export class SqliteBunWorkerClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>()
  private nextID = 0
  private failed: Error | undefined
  private closing = false
  private closePromise: Promise<void> | undefined
  readonly ready: Promise<void>

  constructor(options: SqliteWorkerOptions, private readonly onPlanDiagnostic?: (entry: SqlitePlanDiagnostic) => void) {
    this.worker = new Worker(workerUrl, { workerData: options })
    this.ready = new Promise((resolve, reject) => {
      this.worker.on("message", (message) => {
        if ("ready" in message) {
          if (message.ready) resolve()
          else {
            const error = restoreError(message.error)
            reject(error)
            this.fail(error)
          }
          return
        }
        if ("planDiagnostic" in message) {
          const entry = message.planDiagnostic as SqlitePlanDiagnostic
          if (this.onPlanDiagnostic) this.onPlanDiagnostic(entry)
          else void Effect.runFork(Effect.logWarning("SQLite runaway query plan", entry))
          return
        }
        const job = this.pending.get(message.id)
        if (!job) return
        this.pending.delete(message.id)
        if (message.error) job.reject(restoreError(message.error))
        else job.resolve(message.value)
      })
      this.worker.on("error", (error) => {
        reject(error)
        this.fail(error)
      })
      this.worker.on("exit", (code) => {
        if (this.closing && code === 0 && this.pending.size === 0) return
        const error = new Error(`SQLite Bun worker exited (${code})`)
        reject(error)
        this.fail(error)
      })
    })
  }

  private fail(error: Error) {
    this.failed ??= error
    for (const job of this.pending.values()) job.reject(error)
    this.pending.clear()
  }

  async request<T = unknown>(request: Request): Promise<T> {
    await this.ready
    if (this.failed) throw this.failed
    if (this.closing && request.kind !== "close") throw new Error("SQLite connection is closing")
    if (request.kind !== "close" && this.pending.size >= 64) throw new Error("SQLite worker admission capacity exceeded")
    const id = ++this.nextID
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.worker.postMessage({ ...request, id }) }
      catch (cause) { this.pending.delete(id); reject(cause) }
    })
  }

  close(): Promise<void> {
    return this.closePromise ??= this.closeOnce()
  }

  private async closeOnce() {
    this.closing = true
    try { await this.request({ kind: "close" }) }
    finally { await this.worker.terminate() }
  }
}
