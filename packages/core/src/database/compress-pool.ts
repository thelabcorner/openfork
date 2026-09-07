/**
 * Epoch-3 worker-thread pool for ChunkDB sealer compression.
 *
 * The sealer's hot cost is `compressText` (CPU-bound zstd/brotli). This pool
 * moves that work onto a small worker pool so the main thread stays free for
 * sha256 + SQL while workers compress in parallel. Compression is intentionally
 * allowed to be slow; foreground CPU headroom is more important than drain rate.
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

// Source/tests can execute the TypeScript worker directly. The Node sidecar is
// a single-file bundle, however, so build-node.ts emits a sibling JS worker and
// substitutes this compile-time path. Keeping the fallback here means the core
// package remains independently runnable without coupling it to opencode's build.
declare const OPENCODE_CHUNKDB_COMPRESS_WORKER_PATH: string | undefined
const workerUrl = new URL(
  typeof OPENCODE_CHUNKDB_COMPRESS_WORKER_PATH === "string"
    ? OPENCODE_CHUNKDB_COMPRESS_WORKER_PATH
    : "./compress-worker.ts",
  import.meta.url,
)

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
  private closed = false

  constructor(size?: number) {
    const cpus = Math.max(1, os.cpus().length)
    // Ratio-first sealing burns substantially more CPU than the old level-1
    // policy. Keep at least two logical CPUs free where possible and cap at two
    // compression workers; decompression has its own wider latency-oriented pool.
    this.size = size ?? Math.min(2, Math.max(1, cpus - 2))
  }

  private start() {
    if (this.started) return
    this.started = true
    for (let i = 0; i < this.size; i++) this.spawn()
  }

  private spawn() {
    if (this.closed) return
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
    if (!job) return
    if (job.req.id !== res.id) {
      this.onError(worker, new Error("compress-worker response ID mismatch"))
      return
    }
    this.busy.delete(worker)
    job.resolve(res.value)
    this.idle.push(worker)
    this.drain()
  }

  private onError(worker: Worker, err: unknown) {
    // `error` and non-zero `exit` may both fire for one worker. Retire once.
    if (!this.workers.includes(worker)) return
    const job = this.busy.get(worker)
    this.busy.delete(worker)
    // Remove the dead worker; respawn a replacement to keep pool full.
    const idx = this.workers.indexOf(worker)
    if (idx >= 0) this.workers.splice(idx, 1)
    const idleIdx = this.idle.indexOf(worker)
    if (idleIdx >= 0) this.idle.splice(idleIdx, 1)
    worker.terminate().catch(() => {})
    if (!this.closed && this.workers.length < this.size) this.spawn()
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
    if (this.closed) return Promise.reject(new Error("Compression pool is closed"))
    this.start()
    return new Promise<string | Uint8Array>((resolve, reject) => {
      const job: Job = { req: { id: this.nextId++, json, codec: options?.codec, level: options?.level }, resolve, reject }
      this.queue.push(job)
      this.drain()
    })
  }

  /** Tear down all workers (call on shutdown / test teardown). */
  async close(): Promise<void> {
    this.closed = true
    const workers = this.workers
    const error = new Error("Compression pool is closed")
    for (const job of this.busy.values()) job.reject(error)
    for (const job of this.queue) job.reject(error)
    this.workers = []
    this.idle = []
    this.busy.clear()
    this.queue = []
    this.started = false
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})))
  }
}

let pool: CompressPool | undefined
let poolDisabled = false
let poolClosing: Promise<void> | undefined

function getPool(): CompressPool {
  if (!pool) pool = new CompressPool()
  return pool
}

function disablePool() {
  if (poolDisabled) return
  poolDisabled = true
  const closing = pool
  pool = undefined
  if (closing) poolClosing = closing.close().catch(() => {})
}

/**
 * Async, worker-pooled `compressText`. Returns the same `string | Uint8Array`
 * as the sync path: a `string` means the value was kept as TEXT (under
 * threshold or compression gained nothing); a `Uint8Array` is an OCDB frame.
 */
export async function compressTextAsync(
  json: string,
  options?: { codec?: 1 | 2 | 3; level?: number },
): Promise<string | Uint8Array> {
  if (poolDisabled) return compressText(json, options)
  try {
    return await getPool().submit(json, options)
  } catch {
    // Worker execution is an optimization, never a correctness dependency.
    // A missing/corrupt worker asset or runtime worker failure must not disable
    // ChunkDB for an entire process. Retire the pool once and fall back to the
    // proven synchronous codec for this process.
    disablePool()
    return compressText(json, options)
  }
}

/** Close the worker pool (idempotent). Exposed for shutdown / test teardown. */
export async function compressPoolClose(): Promise<void> {
  const closing = pool
  pool = undefined
  if (closing) await closing.close()
  if (poolClosing) await poolClosing
  poolClosing = undefined
  poolDisabled = false
}
