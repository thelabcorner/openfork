type Waiter = { resolve: () => void; reject: (error: unknown) => void }

type Pending = {
  timer?: ReturnType<typeof setTimeout>
  sizes: Map<string, number>
  bytes: number
  waiters: Waiter[]
}

const MAX_KEYS = 512
const MAX_BYTES = 8 * 1024 * 1024

/**
 * Coalesces renderer persistence IPC by Electron-store file. Values are made
 * visible to reads immediately; only the whole-file disk write is deferred.
 */
export function createStoreWriteQueue(input: {
  set(name: string, key: string, value: string): void
  flush(name: string): void
  delayMs?: number
  maxKeys?: number
  maxBytes?: number
}) {
  const pending = new Map<string, Pending>()

  function settle(item: Pending, error?: unknown) {
    for (const waiter of item.waiters.splice(0)) {
      if (error === undefined) waiter.resolve()
      else waiter.reject(error)
    }
  }

  function flush(name: string) {
    const item = pending.get(name)
    if (!item) return
    if (item.timer !== undefined) clearTimeout(item.timer)
    item.timer = undefined
    try {
      input.flush(name)
      pending.delete(name)
      settle(item)
    } catch (error) {
      // Keep the latest values in the store's in-memory snapshot and retry a
      // failed write. The caller still learns about this failed flush.
      settle(item, error)
      item.sizes.clear()
      item.bytes = 0
      item.timer = setTimeout(() => flush(name), 1000)
    }
  }

  function schedule(name: string, item: Pending) {
    // Use a fixed window from the first write, not a sliding debounce. A
    // continuous stream of renderer updates must not postpone disk durability
    // forever.
    if (item.timer !== undefined) return
    item.timer = setTimeout(() => flush(name), input.delayMs ?? 32)
  }

  return {
    enqueue(name: string, key: string, value: string) {
      input.set(name, key, value)
      let item = pending.get(name)
      if (!item) {
        item = { sizes: new Map(), bytes: 0, waiters: [] }
        pending.set(name, item)
      }
      const bytes = (key.length + value.length) * 2
      item.bytes += bytes - (item.sizes.get(key) ?? 0)
      item.sizes.set(key, bytes)
      const promise = new Promise<void>((resolve, reject) => item!.waiters.push({ resolve, reject }))
      if (item.sizes.size >= (input.maxKeys ?? MAX_KEYS) || item.bytes >= (input.maxBytes ?? MAX_BYTES)) {
        flush(name)
      } else {
        schedule(name, item)
      }
      return promise
    },
    flush,
    flushAll() {
      for (const name of [...pending.keys()]) flush(name)
    },
    pendingStores() {
      return pending.size
    },
  }
}
