import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { DecompressPool } from "../../src/database/decompress-pool"

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
})
