import { describe, expect, test } from "bun:test"
import { createHostOperationQueue } from "@/oxp/host-operation-queue"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("OXP host state operation epochs", () => {
  test("shares only overlapping reads, never a settled snapshot", async () => {
    const queue = createHostOperationQueue<number>()
    const pending = deferred<number>()
    let calls = 0
    const first = queue.read(() => {
      calls++
      return pending.promise
    })
    const shared = queue.read(() => {
      calls++
      return Promise.resolve(999)
    })
    expect(first).toBe(shared)
    await Promise.resolve()
    expect(calls).toBe(1)
    pending.resolve(4)
    expect(await first).toBe(4)
    await Promise.resolve()
    expect(await queue.read(async () => ++calls)).toBe(2)
  })

  test("a queued mutation prevents a later read from seeing the earlier snapshot", async () => {
    const queue = createHostOperationQueue<number>()
    const readStarted = deferred<void>()
    const releaseRead = deferred<void>()
    let version = 0
    const early = queue.read(async () => {
      const captured = version
      readStarted.resolve()
      await releaseRead.promise
      return captured
    })
    await readStarted.promise
    const write = queue.enqueue(async () => { version++; return version })
    const later = queue.read(async () => version)
    releaseRead.resolve()
    expect(await early).toBe(0)
    expect(await write).toBe(1)
    expect(await later).toBe(1)
  })

  test("failed reads do not poison future projections or the mutation queue", async () => {
    const queue = createHostOperationQueue<number>()
    const failure = queue.read(async () => { throw new Error("unavailable") })
    expect(queue.read(async () => 5)).toBe(failure)
    await expect(failure).rejects.toThrow("unavailable")
    expect(await queue.enqueue(async () => 6)).toBe(6)
    expect(await queue.read(async () => 7)).toBe(7)
  })
})