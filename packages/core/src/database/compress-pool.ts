/**
 * Epoch-3 worker-thread pool for ChunkDB sealer compression.
 *
 * The sealer's hot cost is `compressText` (CPU-bound zstd/brotli). This pool
 * moves that work onto 2–4 worker threads (os.cpus()-1, capped) so the main
 * thread stays free for sha256 + SQL while workers compress in parallel. The
 * sync `compressText` path is preserved unchanged for tests and the
 * non-worker sealer path.
 *
 * Design:
 * - Lazily spawned singleton pool (sized once on first `compressTextAsync`).
 * - Least-busy dispatch: a job is posted to whichever worker is idle; if none
 *   are idle the job queues and is drained when a worker reports back.
 * - Results are matched by monotonic `id`; frame `Uint8Array` buffers are
 *   transferred (zero-copy) back to the main thread.
 * - Worker death (error) rejects the in-flight job and respawns a replacement
 *   so a single bad payload can't kill the whole pool.
 *
 * `compressTextAsync` mirrors `compressText`'s signature and return type
 * (`string | Uint8Array`) so the sealer can swap it in behind a flag.
 */
import { Worker } from "node:worker_threads"
import os from "node:os"
import { compressText } from "./json-codec"

const workerUrl = new URL("./compress-worker.ts", import.meta.url)

type Request = { id: number; json: string; codec?: 1 | 2 | 3; level?: number }
type Response =
  | { id: number; kind: "string"; value: string }
  | { id: number; kind: "bytes"; value: Uint8Array }

interface Job {
  req: Request
  resolve: (value: string | Uint8Array) => void
  reject: (error: unknown) => void
}

class CompressPool {
  private readonly size: number
  private workers: Worker[] = []
  private idle: Worker[] = []
  private busy = new Map<Worker, Job>()
  private queue: Job[] = []
  private nextId = 1
  private started = false

  constructor(size?: number) {
    const cpus = Math.max(1, os.cpus().length)
    this.size = size ?? Math.min(4, Math.max(2, cpus - 1))
  }

  private start() {
    if (this.started) return
    this.started = true
    for (let i = 0; i < this.size; i++) this.spawn()
  }

  private spawn() {
    const worker = new Worker(workerUrl)
    worker.on("message", (res: Response) => this.onMessage(worker, res))
    worker.on("error", (err) => this.onError(worker, err))
    worker.on("exit", (code) => {
      if (code !== 0) this.onError(worker, new Error(`compress-worker exited with code ${code}`))
    })
    this.workers.push(worker)
    this.idle.push(worker)
  }

  private onMessage(worker: Worker, res: Response) {
    const job = this.busy.get(worker)
    this.busy.delete(worker)
    if (job && job.req.id === res.id) {
      job.resolve(res.kind === "string" ? res.value : res.value)
    }
    this.idle.push(worker)
    this.drain()
  }

  private onError(worker: Worker, err: unknown) {
    const job = this.busy.get(worker)
    this.busy.delete(worker)
    // Remove the dead worker; respawn a replacement to keep pool full.
    const idx = this.workers.indexOf(worker)
    if (idx >= 0) this.workers.splice(idx, 1)
    const idleIdx = this.idle.indexOf(worker)
    if (idleIdx >= 0) this.idle.splice(idleIdx, 1)
    worker.terminate().catch(() => {})
    if (this.workers.length < this.size) this.spawn()
    if (job) job.reject(err)
    this.drain()
  }

  private drain() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!
      const job = this.queue.shift()!
      this.busy.set(worker, job)
      worker.postMessage(job.req)
    }
  }

  submit(json: string, options?: { codec?: 1 | 2 | 3; level?: number }): Promise<string | Uint8Array> {
    this.start()
    return new Promise<string | Uint8Array>((resolve, reject) => {
      const job: Job = { req: { id: this.nextId++, json, codec: options?.codec, level: options?.level }, resolve, reject }
      this.queue.push(job)
      this.drain()
    })
  }

  /** Tear down all workers (call on shutdown / test teardown). */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate().catch(() => {})))
    this.workers = []
    this.idle = []
    this.busy.clear()
    this.queue = []
    this.started = false
  }
}

let pool: CompressPool | undefined

function getPool(): CompressPool {
  if (!pool) pool = new CompressPool()
  return pool
}

/**
 * Async, worker-pooled `compressText`. Returns the same `string | Uint8Array`
 * as the sync path: a `string` means the value was kept as TEXT (under
 * threshold or compression gained nothing); a `Uint8Array` is an OCDB frame.
 */
export function compressTextAsync(
  json: string,
  options?: { codec?: 1 | 2 | 3; level?: number },
): Promise<string | Uint8Array> {
  return getPool().submit(json, options)
}

/** Close the worker pool (idempotent). Exposed for shutdown / test teardown. */
export async function compressPoolClose(): Promise<void> {
  if (pool) await pool.close()
  pool = undefined
}
