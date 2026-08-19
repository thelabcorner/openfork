import { describe, expect, test } from "bun:test"
import { createDesktopStorage, type StoreBridge } from "./storage"

function makeBridge() {
  const files = new Map<string, Map<string, string>>()
  const calls = { get: 0, getAll: 0, set: 0, delete: 0, clear: 0 }
  const fileOf = (name: string) => {
    const existing = files.get(name)
    if (existing) return existing
    const next = new Map<string, string>()
    files.set(name, next)
    return next
  }
  const bridge: StoreBridge = {
    storeGet: async (name, key) => {
      calls.get++
      return fileOf(name).get(key) ?? null
    },
    storeGetAll: async (name) => {
      calls.getAll++
      const file = fileOf(name)
      const entries: Record<string, string> = {}
      for (const [k, v] of file) entries[k] = v
      return entries
    },
    storeSet: async (name, key, value) => {
      calls.set++
      fileOf(name).set(key, value)
    },
    storeDelete: async (name, key) => {
      calls.delete++
      fileOf(name).delete(key)
    },
    storeClear: async (name) => {
      calls.clear++
      fileOf(name).clear()
    },
    storeKeys: async (name) => [...fileOf(name).keys()],
    storeLength: async (name) => fileOf(name).size,
  }
  return { bridge, calls, files }
}

function seed(bridge: StoreBridge, name: string, key: string, value: string) {
  void bridge.storeSet(name, key, value)
}

describe("createDesktopStorage", () => {
  test("getItem stays async (returns a Promise, never blocks synchronously)", () => {
    const { bridge } = makeBridge()
    const storage = createDesktopStorage(bridge)("opencode.workspace.dat")
    const result = storage.getItem("terminal")
    expect(result).toBeInstanceOf(Promise)
  })

  test("repeat getItem for the same key reuses the bulk-fetched value (zero individual storeGet calls)", async () => {
    const { bridge, calls } = makeBridge()
    seed(bridge, "opencode.workspace.dat", "terminal", '["t1"]')
    const storage = createDesktopStorage(bridge)("opencode.workspace.dat")

    const [a, b, c] = await Promise.all([
      storage.getItem("terminal"),
      storage.getItem("terminal"),
      storage.getItem("terminal"),
    ])
    expect([a, b, c]).toEqual(['["t1"]', '["t1"]', '["t1"]'])
    expect(calls.get).toBe(0)
    expect(calls.getAll).toBe(1)
  })

  test("a fresh createDesktopStorage() call (simulating provider remount) reuses the cache for the same store name", async () => {
    const { bridge, calls } = makeBridge()
    seed(bridge, "opencode.workspace.dat", "terminal", '["t1"]')
    const getStorage = createDesktopStorage(bridge)
    const first = getStorage("opencode.workspace.dat")
    expect(await first.getItem("terminal")).toBe('["t1"]')
    expect(calls.getAll).toBe(1)

    const second = getStorage("opencode.workspace.dat")
    expect(second).toBe(first)
    expect(await second.getItem("terminal")).toBe('["t1"]')
    expect(calls.getAll).toBe(1)
  })

  test("confirmed-absent keys are cached without re-querying", async () => {
    const { bridge, calls } = makeBridge()
    const storage = createDesktopStorage(bridge)("opencode.workspace.dat")

    expect(await storage.getItem("missing")).toBeNull()
    expect(await storage.getItem("missing")).toBeNull()
    expect(calls.get).toBe(1)
  })

  test("setItem updates the cache immediately (read-your-own-write) without a get call", async () => {
    const { bridge, calls } = makeBridge()
    const storage = createDesktopStorage(bridge)("opencode.workspace.dat")

    await storage.setItem("terminal", '["t2"]')
    expect(await storage.getItem("terminal")).toBe('["t2"]')
    expect(calls.get).toBe(0)
    expect(calls.set).toBe(1)
  })

  test("removeItem clears the cache entry so the next getItem re-queries", async () => {
    const { bridge, calls } = makeBridge()
    seed(bridge, "opencode.workspace.dat", "terminal", '["t1"]')
    const storage = createDesktopStorage(bridge)("opencode.workspace.dat")

    expect(await storage.getItem("terminal")).toBe('["t1"]')
    await storage.removeItem("terminal")
    expect(await storage.getItem("terminal")).toBeNull()
    expect(calls.get).toBe(1)
    expect(calls.delete).toBe(1)
  })

  test("a failed read is not cached -- the next getItem retries", async () => {
    let fail = true
    const bridge: StoreBridge = {
      storeGet: async () => {
        if (fail) {
          fail = false
          throw new Error("boom")
        }
        return "recovered"
      },
      storeGetAll: async () => ({}),
      storeSet: async () => {},
      storeDelete: async () => {},
      storeClear: async () => {},
      storeKeys: async () => [],
      storeLength: async () => 0,
    }
    const storage = createDesktopStorage(bridge)("opencode.workspace.dat")

    await expect(storage.getItem("k")).rejects.toThrow("boom")
    expect(await storage.getItem("k")).toBe("recovered")
  })

  test("clear() empties the cache for that store without touching another store's cache", async () => {
    const { bridge, calls } = makeBridge()
    seed(bridge, "a.dat", "k", "va")
    seed(bridge, "b.dat", "k", "vb")
    const getStorage = createDesktopStorage(bridge)
    const a = getStorage("a.dat")
    const b = getStorage("b.dat")

    expect(await a.getItem("k")).toBe("va")
    expect(await b.getItem("k")).toBe("vb")
    calls.get = 0

    await a.clear()
    expect(await a.getItem("k")).toBeNull() // cache cleared -> reads through to the (now-cleared) bridge file
    expect(await b.getItem("k")).toBe("vb") // untouched, still cached, no re-query
    expect(calls.get).toBe(1)
  })

  test("different store names get independent value caches", async () => {
    const { bridge, calls } = makeBridge()
    seed(bridge, "a.dat", "k", "va")
    seed(bridge, "b.dat", "k", "vb")
    const getStorage = createDesktopStorage(bridge)

    expect(await getStorage("a.dat").getItem("k")).toBe("va")
    expect(await getStorage("b.dat").getItem("k")).toBe("vb")
    expect(calls.getAll).toBe(2)
    expect(calls.get).toBe(0)
  })

  test("bulk fetch seeds all keys in one IPC call, eliminating per-key round-trips", async () => {
    const { bridge, calls } = makeBridge()
    seed(bridge, "window.dat", "tabs", "tabs-data")
    seed(bridge, "window.dat", "tabs.recent", "recent-data")
    seed(bridge, "window.dat", "tabs.info", "info-data")
    seed(bridge, "window.dat", "tabs.closed", "closed-data")
    const storage = createDesktopStorage(bridge)("window.dat")

    const [a, b, c, d] = await Promise.all([
      storage.getItem("tabs"),
      storage.getItem("tabs.recent"),
      storage.getItem("tabs.info"),
      storage.getItem("tabs.closed"),
    ])
    expect(a).toBe("tabs-data")
    expect(b).toBe("recent-data")
    expect(c).toBe("info-data")
    expect(d).toBe("closed-data")
    expect(calls.getAll).toBe(1)
    expect(calls.get).toBe(0)
  })

  test("key not in bulk result falls back to individual storeGet", async () => {
    const { bridge, calls } = makeBridge()
    seed(bridge, "workspace.dat", "terminal", "t-data")
    const storage = createDesktopStorage(bridge)("workspace.dat")

    expect(await storage.getItem("terminal")).toBe("t-data")
    expect(await storage.getItem("missing")).toBeNull()
    expect(calls.getAll).toBe(1)
    expect(calls.get).toBe(1)
  })

  test("removeItem prevents stale bulk re-seed on subsequent getItem", async () => {
    const { bridge, calls } = makeBridge()
    seed(bridge, "workspace.dat", "terminal", "t-data")
    const storage = createDesktopStorage(bridge)("workspace.dat")

    expect(await storage.getItem("terminal")).toBe("t-data")
    await storage.removeItem("terminal")
    expect(await storage.getItem("terminal")).toBeNull()
    expect(calls.getAll).toBe(1)
    expect(calls.get).toBe(1)
  })
})
