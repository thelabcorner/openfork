import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import {
  DECOMPRESS_POOL_MIN_BYTES,
  DecompressPool,
  DecompressPoolCapacityError,
  shouldUseDecompressPool,
} from "../../src/database/decompress-pool"

class FakeWorker extends EventEmitter {
  request?: { id: number; bytes: Uint8Array }
  postMessage(request: { id: number; bytes: Uint8Array }) { this.request = request }
  async terminate() { this.emit("exit", 0); return 0 }
  reply(raw = '{"ok":true}', id = this.request!.id) {
    this.emit("message", { id, raw: new TextEncoder().encode(raw) })
  }
}

function fixture() {
  const workers: FakeWorker[] = []
  const pool = new DecompressPool(1, () => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
  return { pool, workers }
}

describe("decompression pool settlement", () => {
  test("owns one 64 KiB worker admission boundary for every caller", () => {
    expect(DECOMPRESS_POOL_MIN_BYTES).toBe(64 * 1024)
    expect(shouldUseDecompressPool(DECOMPRESS_POOL_MIN_BYTES - 1)).toBe(false)
    expect(shouldUseDecompressPool(DECOMPRESS_POOL_MIN_BYTES)).toBe(true)
  })

  test("parses at most one completed worker result per scheduler turn", async () => {
    const workers: FakeWorker[] = []
    const scheduled: Array<() => void> = []
    const pool = new DecompressPool(
      2,
      () => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker as unknown as Worker
      },
      1024,
      (task) => scheduled.push(task),
    )
    let firstSettled = false
    let secondSettled = false
    const first = pool.submit(new Uint8Array([1])).finally(() => (firstSettled = true))
    const second = pool.submit(new Uint8Array([2])).finally(() => (secondSettled = true))

    workers[0]!.reply('{"job":1}')
    workers[1]!.reply('{"job":2}')
    expect(scheduled).toHaveLength(1)
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)

    scheduled.shift()!()
    await Promise.resolve()
    expect(Number(firstSettled) + Number(secondSettled)).toBe(1)
    expect(scheduled).toHaveLength(1)

    scheduled.shift()!()
    const results = await Promise.all([first, second])
    expect(results.map((result) => (result.value as { job: number }).job).sort()).toEqual([1, 2])
    expect(results.every((result) => result.raw instanceof Uint8Array)).toBe(true)
    await pool.close()
  })

  test("rejects an ID mismatch and continues queued work on a replacement", async () => {
    const { pool, workers } = fixture()
    const first = pool.submit(new Uint8Array([1])).catch((error: Error) => error.message)
    const second = pool.submit(new Uint8Array([2]))
    workers[0]!.reply("{}", 99)
    expect(await first).toContain("ID mismatch")
    expect(workers).toHaveLength(2)
    workers[1]!.reply()
    expect((await second).value).toEqual({ ok: true })
    await pool.close()
    expect(workers).toHaveLength(2)
  })

  test("rejects malformed JSON without stranding the next job", async () => {
    const { pool, workers } = fixture()
    const first = pool.submit(new Uint8Array()).catch((error) => error)
    const second = pool.submit(new Uint8Array())
    workers[0]!.reply("invalid")
    expect(await first).toBeInstanceOf(SyntaxError)
    workers[0]!.reply()
    expect((await second).value).toEqual({ ok: true })
    await pool.close()
  })

  test("close settles active and queued callers and never respawns", async () => {
    const { pool, workers } = fixture()
    const jobs = Array.from({ length: 8 }, () => pool.submit(new Uint8Array()).catch((error: Error) => error.message))
    await pool.close()
    expect(await Promise.all(jobs)).toEqual(Array(8).fill("Decompression pool is closed"))
    expect(workers).toHaveLength(1)
    await expect(pool.submit(new Uint8Array())).rejects.toThrow("closed")
    await pool.close()
  })

  test("close settles completed results that are waiting for a cooperative parse turn", async () => {
    const worker = new FakeWorker()
    const scheduled: Array<() => void> = []
    const pool = new DecompressPool(1, () => worker as unknown as Worker, 1024, (task) => scheduled.push(task))
    const job = pool.submit(new Uint8Array([1])).catch((error: Error) => error.message)
    worker.reply('{"ok":true}')
    expect(scheduled).toHaveLength(1)
    await pool.close()
    expect(await job).toBe("Decompression pool is closed")
    // A stale scheduled callback must be harmless after close.
    scheduled.shift()!()
  })

  test("settles synchronous postMessage failures", async () => {
    const worker = new FakeWorker()
    worker.postMessage = () => { throw new Error("clone failed") }
    const replacement = new FakeWorker()
    let count = 0
    const pool = new DecompressPool(1, () => (++count === 1 ? worker : replacement) as unknown as Worker)
    await expect(pool.submit(new Uint8Array())).rejects.toThrow("clone failed")
    const next = pool.submit(new Uint8Array())
    replacement.reply()
    expect((await next).value).toEqual({ ok: true })
    await pool.close()
  })

  test("reserves decoded output before dispatch so concurrent completions cannot overshoot the pool budget", async () => {
    const { pool, workers } = (() => {
      const workers: FakeWorker[] = []
      const pool = new DecompressPool(1, () => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker as unknown as Worker
      }, 8)
      return { pool, workers }
    })()
    const first = pool.submit(new Uint8Array(3))
    // Raw BLOBs decode to themselves, so a 3-byte input reserves 3 input + 3
    // output bytes. A second 2-byte job would require 4 more bytes and must be
    // rejected before either worker completes.
    const second = pool.submit(new Uint8Array(2))
    await expect(second).rejects.toBeInstanceOf(DecompressPoolCapacityError)
    workers[0]!.reply()
    await first
    await pool.close()
  })
})
