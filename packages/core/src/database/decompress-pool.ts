/**
 * Epoch-3 worker-thread pool for ChunkDB read-path decompression.
 *
 * The read path's hot cost for promoted (externalized) payloads is
 * `decodeValueBytesObject` (decompress + JSON.parse + sha256 source bytes). For
 * jumbo payloads (up to ~32MiB) a single synchronous decompress blocks the read
 * fiber for ~120ms; a wide batch of references serializes that cost. This pool
 * moves the work onto 2–4 worker threads so decompresses run IN PARALLEL and
 * the main thread stays free for other reads — preventing the clog that a single
 * large replay would otherwise cause.
 *
 * Design mirrors compress-pool.ts:
 * - Lazily spawned singleton pool (sized once on first `decompressValueAsync`).
 * - Least-busy dispatch; jobs queue and drain as workers report back.
 * - Results matched by monotonic `id`; the raw `Uint8Array` buffer is
 *   transferred (zero-copy) back to the main thread.
 * - Worker death rejects the in-flight job and respawns a replacement.
 *
 * `decompressValueAsync` returns the same `{ value, raw }` as the sync
 * `decodeValueBytesObject` so the read path can swap it in behind a flag.
 */
import { Worker } from "node:worker_threads"
import os from "node:os"

const workerUrl = new URL("./decompress-worker.ts", import.meta.url)
const decoder = new TextDecoder()

type Request = { id: number; bytes: Uint8Array }
type Response = { id: number; raw: Uint8Array }

interface Job {
  req: Request
  resolve: (value: { value: unknown; raw: Uint8Array }) => void
  reject: (error: unknown) => void
}

export class DecompressPool {
  private readonly size: number
  private workers: Worker[] = []
  private idle: Worker[] = []
  private busy = new Map<Worker, Job>()
  private queue: Job[] = []
  private nextId = 1
  private started = false
  private closed = false

  constructor(size?: number, private readonly createWorker: () => Worker = () => new Worker(workerUrl)) {
    const cpus = Math.max(1, os.cpus().length)
    this.size = size ?? Math.min(4, Math.max(2, cpus - 1))
  }

  private start() {
    if (this.started) return
    this.started = true
    for (let i = 0; i < this.size; i++) this.spawn()
  }

  private spawn() {
    if (this.closed) return
    const worker = this.createWorker()
    worker.on("message", (res: Response) => this.onMessage(worker, res))
    worker.on("error", (err) => this.onError(worker, err))
    worker.on("exit", (code) => {
      this.onError(worker, new Error(`decompress-worker exited with code ${code}`))
    })
    this.workers.push(worker)
    this.idle.push(worker)
  }

  private onMessage(worker: Worker, res: Response) {
    const job = this.busy.get(worker)
    if (!job) return
    if (job.req.id !== res.id) {
      this.onError(worker, new Error("decompress-worker response ID mismatch"))
      return
    }
    this.busy.delete(worker)
    try {
      // The worker sends ONLY the raw bytes (transferred zero-copy). Parsing
      // happens here on the main thread: structured-cloning the parsed object
      // from the worker would serialize a large object on the main thread and
      // negate the parallelism (epoch-3 bench: 16 jumbos 628ms vs 513ms sync).
      job.resolve({ value: JSON.parse(decoder.decode(res.raw)), raw: res.raw })
    } catch (error) {
      job.reject(error)
    }
    this.idle.push(worker)
    this.drain()
  }

  private onError(worker: Worker, err: unknown) {
    // error and exit can both fire for one worker. Retire it exactly once.
    if (!this.workers.includes(worker)) return
    const job = this.busy.get(worker)
    this.busy.delete(worker)
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
      // NOTE: no transfer list here — the input bytes are CLONED, never
      // transferred. Transferring would detach the caller's buffer (the same
      // frame can be decoded again after a cache eviction), and a Node Buffer
      // view into a shared pool cannot be transferred at all (DataCloneError).
      try {
        worker.postMessage(job.req)
      } catch (error) {
        this.onError(worker, error)
      }
    }
  }

  submit(bytes: Uint8Array): Promise<{ value: unknown; raw: Uint8Array }> {
    if (this.closed) return Promise.reject(new Error("Decompression pool is closed"))
    this.start()
    return new Promise<{ value: unknown; raw: Uint8Array }>((resolve, reject) => {
      const job: Job = { req: { id: this.nextId++, bytes }, resolve, reject }
      this.queue.push(job)
      this.drain()
    })
  }

  /** Tear down all workers (call on shutdown / test teardown). */
  async close(): Promise<void> {
    this.closed = true
    const workers = this.workers
    const error = new Error("Decompression pool is closed")
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

let pool: DecompressPool | undefined

function getPool(): DecompressPool {
  if (!pool) pool = new DecompressPool()
  return pool
}

/**
 * Async, worker-pooled `decodeValueBytesObject`. Returns the same
 * `{ value, raw }` as the sync path. Used by the read path when
 * `OPENCODE_SEAL_WORKERS` is on and the payload is large enough that the
 * worker round-trip beats a main-thread decompress.
 */
export function decompressValueAsync(bytes: Uint8Array): Promise<{ value: unknown; raw: Uint8Array }> {
  return getPool().submit(bytes)
}

/** Close the worker pool (idempotent). Exposed for shutdown / test teardown. */
export async function decompressPoolClose(): Promise<void> {
  const closing = pool
  pool = undefined
  if (closing) await closing.close()
}
