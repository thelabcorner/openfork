import { describe, expect, test } from "bun:test"
import { createProjectExplorerMutationQueue } from "./project-explorer-mutation-queue"
import { dispatchProjectExplorerBulk } from "./project-explorer-bulk-dispatch"

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe("Project Explorer mutation settlement queue", () => {
  test("at most 2 concurrent requests, FIFO and success means settled backend operation", async () => {
    const completions = Array.from({ length: 4 }, () => deferred())
    const events: string[] = []
    const queue = createProjectExplorerMutationQueue({ concurrency: 2 })
    const receipts = completions.map((completion, index) => queue.enqueue(async () => {
      events.push(`start-${index}`)
      await completion.promise
      events.push(`end-${index}`)
    }))
    await flush()
    expect(events).toEqual(["start-0", "start-1"])
    expect(queue.active).toBe(2)
    expect(queue.queued).toBe(2)
    completions[1]!.resolve()
    expect(await receipts[1]).toBe(true)
    await flush()
    expect(events).toContain("start-2")
    expect(events).not.toContain("start-3")
    completions[0]!.resolve()
    expect(await receipts[0]).toBe(true)
    await flush()
    expect(events).toContain("start-3")
    completions[2]!.resolve()
    completions[3]!.resolve()
    expect(await Promise.all(receipts)).toEqual([true, true, true, true])
    await flush()
    expect(queue.active).toBe(0)
    expect(queue.queued).toBe(0)
  })

  test("rejected backend operations settle false and halt following bulk chunks", async () => {
    const errors: unknown[] = []
    const queue = createProjectExplorerMutationQueue({
      concurrency: 2, onError: (error) => { errors.push(error) },
    })
    const invoked: number[] = []
    const processed = await dispatchProjectExplorerBulk(
      Array.from({ length: 120 }, (_, i) => i),
      (index) => queue.enqueue(async () => {
        invoked.push(index)
        if (index === 4) throw new Error("backend rejected")
      }),
      { cancelled: () => queue.disposed, chunkSize: 8, yield: async () => {} },
    )
    expect(processed).toBe(8)
    expect(invoked).toEqual(Array.from({ length: 8 }, (_, i) => i))
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain("backend rejected")
    queue.dispose()
  })

  test("bounded admission rejects overflow once and recovers after queue drains", async () => {
    const pending = deferred()
    let notified = 0
    const queue = createProjectExplorerMutationQueue({
      concurrency: 1, maxQueued: 2, onOverflow: () => notified++,
    })
    const first = queue.enqueue(() => pending.promise)
    await flush()
    const second = queue.enqueue(async () => {})
    const third = queue.enqueue(async () => {})
    const fourth = queue.enqueue(async () => {})
    const fifth = queue.enqueue(async () => {})
    expect(await fourth).toBe(false)
    expect(await fifth).toBe(false)
    expect(notified).toBe(1)
    expect(queue.queued).toBe(2)
    pending.resolve()
    expect(await Promise.all([first, second, third])).toEqual([true, true, true])
    await flush()
    expect(queue.active).toBe(0)
    expect(queue.queued).toBe(0)
    expect(await queue.enqueue(async () => {})).toBe(true)
  })

  test("disposal rejects queued operations and late in-flight results without reporting errors", async () => {
    const pending = deferred()
    const errors: unknown[] = []
    const queue = createProjectExplorerMutationQueue({ concurrency: 1, onError: (error) => errors.push(error) })
    const first = queue.enqueue(async () => pending.promise)
    await flush()
    let startedQueued = false
    const second = queue.enqueue(async () => { startedQueued = true })
    const third = queue.enqueue(async () => {})
    queue.dispose()
    expect(await Promise.all([second, third])).toEqual([false, false])
    expect(queue.queued).toBe(0)
    pending.reject(new Error("late backend failure"))
    expect(await first).toBe(false)
    await flush()
    expect(errors).toEqual([])
    expect(startedQueued).toBe(false)
    expect(await queue.enqueue(async () => {})).toBe(false)
    queue.dispose()
  })

  test("disposal releases a producer awaiting a backend Promise that never settles", async () => {
    const never = new Promise<void>(() => {})
    const queue = createProjectExplorerMutationQueue({ concurrency: 1 })
    const underway = queue.enqueue(() => never)
    await flush()
    const following = queue.enqueue(async () => {})
    queue.dispose()
    // Teardown releases the UI even without a backend cancellation capability.
    expect(await underway).toBe(false)
    expect(await following).toBe(false)
    expect(queue.disposed).toBe(true)
    expect(queue.queued).toBe(0)
  })

  test("a throwing error reporter cannot poison the queue or leave pending receipts unresolved", async () => {
    const queue = createProjectExplorerMutationQueue({
      concurrency: 1,
      onError: () => { throw new Error("logger failed") },
    })
    expect(await queue.enqueue(async () => { throw new Error("filesystem failure") })).toBe(false)
    expect(await queue.enqueue(async () => {})).toBe(true)
  })
})
