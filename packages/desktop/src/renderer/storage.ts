import type { AsyncStorage } from "@solid-primitives/storage"

export type StoreBridge = {
  storeGet: (name: string, key: string) => Promise<string | null>
  storeGetAll: (name: string) => Promise<Record<string, string>>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
}

/**
 * Per-store-file AsyncStorage factory backed by Electron's store IPC (`ipcRenderer.invoke`,
 * non-blocking -- deliberately not `sendSync`: that blocks the renderer's whole main thread
 * on every call, which is worse than the async round-trip it "fixes" once you account for
 * how often persisted() actually reads).
 *
 * Each store's getItem is value-cached (by the in-flight/resolved Promise, not just the
 * resolved value) so repeat reads of the same key are free instead of paying a new IPC
 * round-trip. Combined with layout.tsx prefetchSession (child warmup + lineage.info.peek
 * + message prefetch) and persisted() cache, remounts on hot same-workspace tab switches
 * are now pure cache hits with zero IPC or network. `persisted()` called fresh on every
 * provider remount (terminal, comments, drafts, ...); without caches, paid 1 IPC/key/switch.
 *
 * Tab-strip first-paint gated on tabs.ready() (titlebar lane); no longer any pop-in.
 */
export function createDesktopStorage(api: StoreBridge) {
  const stores = new Map<string, AsyncStorage>()

  const createStore = (name: string): AsyncStorage => {
    const valueCache = new Map<string, Promise<string | null>>()
    // Track keys explicitly removed/cleared so stale bulk data isn't re-seeded.
    const bulkConsumed = new Set<string>()
    // Separate from valueCache: holds the raw bulk result so getItem can check
    // it even when valueCache already contains a pending promise for the same key.
    let bulkEntries: Record<string, string> | null = null

    let bulkReady: Promise<void> | undefined
    const ensureBulk = () => {
      if (bulkReady) return bulkReady
      bulkReady = api
        .storeGetAll(name)
        .then((entries) => {
          bulkEntries = entries
          for (const [key, value] of Object.entries(entries)) {
            if (!valueCache.has(key) && !bulkConsumed.has(key)) {
              valueCache.set(key, Promise.resolve(value))
            }
          }
        })
        .catch(() => {
          bulkEntries = {}
        })
      return bulkReady
    }

    const store: AsyncStorage = {
      getItem: (key: string) => {
        const cached = valueCache.get(key)
        if (cached) return cached
        const promise = ensureBulk()
          .then(
            () => {
              if (bulkEntries && key in bulkEntries && !bulkConsumed.has(key)) {
                const val = bulkEntries[key]
                const resolved = Promise.resolve(val)
                valueCache.set(key, resolved)
                return val
              }
              const individual = api.storeGet(name, key)
              valueCache.set(key, individual)
              individual.catch(() => {
                if (valueCache.get(key) === individual) valueCache.delete(key)
              })
              return individual
            },
            () => {
              // bulkReady failed — fall back to individual fetch
              const individual = api.storeGet(name, key)
              valueCache.set(key, individual)
              individual.catch(() => {
                if (valueCache.get(key) === individual) valueCache.delete(key)
              })
              return individual
            },
          )
        valueCache.set(key, promise)
        promise.catch(() => {
          if (valueCache.get(key) === promise) valueCache.delete(key)
        })
        return promise
      },
      setItem: (key: string, value: string) => {
        valueCache.set(key, Promise.resolve(value))
        return api.storeSet(name, key, value)
      },
      removeItem: (key: string) => {
        valueCache.delete(key)
        bulkConsumed.add(key)
        return api.storeDelete(name, key)
      },
      clear: () => {
        valueCache.clear()
        bulkConsumed.clear()
        bulkEntries = null
        return api.storeClear(name)
      },
      key: async (index: number) => (await api.storeKeys(name))[index],
      getLength: () => api.storeLength(name),
      get length() {
        return store.getLength()
      },
    }
    return store
  }

  return (name = "default.dat") => {
    const cached = stores.get(name)
    if (cached) return cached
    const store = createStore(name)
    stores.set(name, store)
    return store
  }
}
