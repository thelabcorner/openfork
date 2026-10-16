import { describe, expect, test, vi } from "bun:test"
import { createStoreWriteQueue } from "./store-write-queue"

describe("desktop store write queue", () => {
  test("coalesces a burst of keys into one whole-file flush and makes values visible immediately", async () => {
    vi.useFakeTimers()
    try {
      const data = new Map<string, Map<string, string>>()
      const flushes: string[] = []
      const queue = createStoreWriteQueue({
        delayMs: 20,
        set: (name, key, value) => {
          let store = data.get(name)
          if (!store) data.set(name, (store = new Map()))
          store.set(key, value)
        },
        flush: (name) => flushes.push(name),
      })

      const writes = Array.from({ length: 100 }, (_, index) => queue.enqueue("global", `key-${index}`, `${index}`))
      expect(data.get("global")?.get("key-99")).toBe("99")
      expect(queue.pendingStores()).toBe(1)
      expect(flushes).toEqual([])

      vi.advanceTimersByTime(20)
      await Promise.all(writes)

      expect(flushes).toEqual(["global"])
      expect(queue.pendingStores()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test("flushes the latest value for a key and settles every writer", async () => {
    vi.useFakeTimers()
    try {
      const data = new Map<string, string>()
      let flushes = 0
      const queue = createStoreWriteQueue({
        delayMs: 20,
        set: (_name, key, value) => data.set(key, value),
        flush: () => flushes++,
      })

      const first = queue.enqueue("window", "scroll", "1")
      const second = queue.enqueue("window", "scroll", "2")
      vi.advanceTimersByTime(20)
      await Promise.all([first, second])

      expect(data.get("scroll")).toBe("2")
      expect(flushes).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("uses a bounded fixed window under continuous writes", async () => {
    vi.useFakeTimers()
    try {
      let flushes = 0
      const queue = createStoreWriteQueue({
        delayMs: 20,
        set: () => {},
        flush: () => flushes++,
      })
      const writes = [queue.enqueue("global", "a", "1")]
      vi.advanceTimersByTime(15)
      writes.push(queue.enqueue("global", "b", "2"))
      vi.advanceTimersByTime(5)
      await Promise.all(writes)

      expect(flushes).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("flushes pending data before a later delete or app shutdown", async () => {
    vi.useFakeTimers()
    try {
      const flushes: string[] = []
      const queue = createStoreWriteQueue({
        delayMs: 20,
        set: () => {},
        flush: (name) => flushes.push(name),
      })
      const writes = [queue.enqueue("global", "a", "1"), queue.enqueue("window", "b", "2")]
      queue.flush("global")
      queue.flushAll()
      await Promise.all(writes)

      expect(flushes).toEqual(["global", "window"])
      expect(queue.pendingStores()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test("falls back to immediate persistence when the bounded queue fills", async () => {
    const flushes: string[] = []
    const queue = createStoreWriteQueue({
      maxKeys: 2,
      set: () => {},
      flush: (name) => flushes.push(name),
    })

    await Promise.all([queue.enqueue("global", "a", "1"), queue.enqueue("global", "b", "2")])

    expect(flushes).toEqual(["global"])
    expect(queue.pendingStores()).toBe(0)
  })

  test("retains the latest in-memory snapshot and retries after a failed flush", async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      const queue = createStoreWriteQueue({
        delayMs: 20,
        set: () => {},
        flush: () => {
          attempts++
          if (attempts === 1) throw new Error("temporary write failure")
        },
      })
      const first = queue.enqueue("global", "key", "latest")
      vi.advanceTimersByTime(20)
      await expect(first).rejects.toThrow("temporary write failure")
      expect(queue.pendingStores()).toBe(1)

      vi.advanceTimersByTime(1000)
      expect(attempts).toBe(2)
      expect(queue.pendingStores()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
