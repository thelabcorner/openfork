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
 * round-trip. `persisted()` (packages/app/src/utils/persist.ts) is called fresh every time a
 * session-scoped provider (terminal list, comments, prompt drafts, file view cache, ...)
 * mounts, and those providers are torn down and rebuilt on every tab switch (session routes
 * don't share a provider tree with Home/draft) -- without this cache, every switch back into
 * a session pays one IPC round-trip PER persisted key, every time.
 *
 * This does NOT by itself avoid the first-mount "pop in after load" for the tab strip --
 * that's fixed separately by gating the tab strip's render on tabs.ready() (see
 * packages/app/src/context/tabs.tsx) rather than trying to make reads any faster.
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

    // Eagerly bulk-fetch all keys for this store on creation. On session mount
    // multiple persisted() calls hit the same store file; without this, each
    // fires a separate IPC round-trip. The fetch is non-blocking — getItem
    // falls back to individual fetch for keys absent from the bulk result.
    const bulkReady = api
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

    const store: AsyncStorage = {
      getItem: (key: string) => {
        const cached = valueCache.get(key)
        if (cached) return cached
        // First access: wait for bulk fetch, then check bulk result, then
        // fall back to individual IPC fetch if the key was absent.
        const promise = bulkReady
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
