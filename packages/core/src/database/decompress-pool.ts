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
import { decodeValueBytesRaw } from "./json-codec"

declare const OPENCODE_CHUNKDB_DECOMPRESS_WORKER_PATH: string | undefined
const workerUrl = new URL(
  typeof OPENCODE_CHUNKDB_DECOMPRESS_WORKER_PATH === "string"
    ? OPENCODE_CHUNKDB_DECOMPRESS_WORKER_PATH
    : "./decompress-worker.ts",
  import.meta.url,
)
const decoder = new TextDecoder()

type Request = { id: number; bytes: Uint8Array }
type Response = { id: number; raw: Uint8Array }

interface Job {
  req: Request
  retainedBytes: number
  settled?: boolean
  resolve: (value: { value: unknown; raw: Uint8Array }) => void
  reject: (error: unknown) => void
}

interface ParseJob {
  readonly job: Job
  readonly raw: Uint8Array
}

const DEFAULT_MAX_RETAINED_BYTES = 64 * 1024 * 1024

export class DecompressPool {
  private readonly size: number
  private workers: Worker[] = []
  private idle: Worker[] = []
  private busy = new Map<Worker, Job>()
  private queue: Job[] = []
  private parseQueue: ParseJob[] = []
  private parseScheduled = false
  private nextId = 1
  private started = false
  private closed = false
  private retainedBytes = 0

  constructor(
    size?: number,
    private readonly createWorker: () => Worker = () => new Worker(workerUrl),
    private readonly maxRetainedBytes = DEFAULT_MAX_RETAINED_BYTES,
    // Bun can drain recursively-scheduled setImmediate callbacks in one check
    // phase before timers get a chance to run. A zero-delay timer gives each
    // jumbo parse a real event-loop boundary in both Bun and Node.
    private readonly scheduleParse: (task: () => void) => void = (task) => setTimeout(task, 0),
  ) {
    const cpus = Math.max(1, os.cpus().length)
    this.size = size ?? Math.min(4, Math.max(2, cpus - 1))
  }

  private settle(job: Job, callback: () => void) {
    if (job.settled) return
    job.settled = true
    this.retainedBytes = Math.max(0, this.retainedBytes - job.retainedBytes)
    callback()
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
    // Keep the raw completion byte-accounted until parse settlement. Several
    // workers can finish near-simultaneously, so counting only compressed input
    // would let queued 16-32 MiB completions hide behind a tiny retained budget.
    job.retainedBytes += res.raw.byteLength
    this.retainedBytes += res.raw.byteLength
    this.parseQueue.push({ job, raw: res.raw })
    this.scheduleNextParse()
    this.idle.push(worker)
    this.drain()
  }

  private scheduleNextParse() {
    if (this.closed || this.parseScheduled || this.parseQueue.length === 0) return
    this.parseScheduled = true
    this.scheduleParse(() => {
      this.parseScheduled = false
      if (this.closed) return
      const next = this.parseQueue.shift()
      if (!next) return
      this.settle(next.job, () => {
        try {
          // Keep parsing on the main thread to avoid structured-clone cost, but
          // parse at most ONE worker completion per event-loop turn. Previously
          // four workers completing together could run four large JSON.parse
          // calls back-to-back in message callbacks and stall every Session for
          // the sum of their costs. The scheduler provides an explicit fairness
          // boundary without changing the canonical parsed object shape.
          next.job.resolve({ value: JSON.parse(decoder.decode(next.raw)), raw: next.raw })
        } catch (error) {
          next.job.reject(error)
        }
      })
      this.scheduleNextParse()
    })
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
    if (job) this.settle(job, () => job.reject(err))
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
    const retainedBytes = bytes.byteLength
    if (retainedBytes > this.maxRetainedBytes || this.retainedBytes + retainedBytes > this.maxRetainedBytes) {
      return Promise.reject(new Error("Decompression pool byte budget is full"))
    }
    this.start()
    return new Promise<{ value: unknown; raw: Uint8Array }>((resolve, reject) => {
      this.retainedBytes += retainedBytes
      const job: Job = { req: { id: this.nextId++, bytes }, retainedBytes, resolve, reject }
      this.queue.push(job)
      this.drain()
    })
  }

  /** Tear down all workers (call on shutdown / test teardown). */
  async close(): Promise<void> {
    this.closed = true
    const workers = this.workers
    const error = new Error("Decompression pool is closed")
    for (const job of this.busy.values()) this.settle(job, () => job.reject(error))
    for (const job of this.queue) this.settle(job, () => job.reject(error))
    for (const item of this.parseQueue) this.settle(item.job, () => item.job.reject(error))
    this.workers = []
    this.idle = []
    this.busy.clear()
    this.queue = []
    this.parseQueue = []
    this.parseScheduled = false
    this.retainedBytes = 0
    this.started = false
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})))
  }
}

let pool: DecompressPool | undefined
let poolDisabled = false
let poolClosing: Promise<void> | undefined

function getPool(): DecompressPool {
  if (!pool) pool = new DecompressPool()
  return pool
}

function decodeSynchronously(bytes: Uint8Array) {
  const raw = decodeValueBytesRaw(bytes)
  return { value: JSON.parse(decoder.decode(raw)), raw }
}

function disablePool() {
  if (poolDisabled) return
  poolDisabled = true
  const closing = pool
  pool = undefined
  if (closing) poolClosing = closing.close().catch(() => {})
}

/**
 * Async, worker-pooled `decodeValueBytesObject`. Returns the same
 * `{ value, raw }` as the sync path. Used by the read path when
 * `OPENCODE_SEAL_WORKERS` is on and the payload is large enough that the
 * worker round-trip beats a main-thread decompress.
 */
export async function decompressValueAsync(bytes: Uint8Array): Promise<{ value: unknown; raw: Uint8Array }> {
  if (poolDisabled) return decodeSynchronously(bytes)
  try {
    return await getPool().submit(bytes)
  } catch {
    // Retrieval correctness cannot depend on worker packaging. If a production
    // worker fails, permanently retire the pool for this process and decode on
    // the caller rather than surfacing a false data-corruption error.
    disablePool()
    return decodeSynchronously(bytes)
  }
}

/** Close the worker pool (idempotent). Exposed for shutdown / test teardown. */
export async function decompressPoolClose(): Promise<void> {
  const closing = pool
  pool = undefined
  if (closing) await closing.close()
  if (poolClosing) await poolClosing
  poolClosing = undefined
  poolDisabled = false
}
