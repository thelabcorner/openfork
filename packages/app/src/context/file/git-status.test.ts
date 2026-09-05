import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createGitStatusStore } from "./git-status"

type Status = { path: string; status: "added" | "deleted" | "modified" }

function makeStore(opts?: { fetch?: () => Promise<Status[]> }) {
  return createRoot(() => {
    const [scope, setScope] = createSignal("/repo")
    const store = createGitStatusStore({
      scope,
      normalize: (input: string) => input.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""),
      fetchStatus: () => opts?.fetch?.() ?? Promise.resolve([]),
      onError: () => {},
      refreshDelayMs: 0,
    })
    return { store, setScope }
  })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createGitStatusStore", () => {
  test("fetches full status on first ensure and exposes it", async () => {
    const { store } = makeStore({
      fetch: () => Promise.resolve([{ path: "src/a.ts", status: "added" }]),
    })
    store.ensure()
    await flush()
    expect(store.status()).toEqual(new Map([["src/a.ts", "add"]]))
  })

  test("reuses the cached map on scope switch back (no rescan)", async () => {
    let fetches = 0
    const { store, setScope } = makeStore({
      fetch: () => {
        fetches++
        return Promise.resolve([{ path: "a.ts", status: "modified" }])
      },
    })
    store.ensure()
    await flush()
    expect(fetches).toBe(1)

    // Switch away — new scope, one fetch.
    setScope("/other")
    store.ensure()
    await flush()
    expect(fetches).toBe(2)

    // Switch back — cache hit, no new fetch.
    setScope("/repo")
    store.ensure()
    await flush()
    expect(fetches).toBe(2)
    expect(store.status()).toEqual(new Map([["a.ts", "mix"]]))
  })

  test("debounces watcher invalidations into a single refresh", async () => {
    let fetches = 0
    const { store } = makeStore({
      fetch: () => {
        fetches++
        return Promise.resolve([{ path: "a.ts", status: "modified" }])
      },
    })
    store.ensure()
    await flush()
    expect(fetches).toBe(1)

    store.invalidate("a.ts")
    store.invalidate("b.ts")
    store.invalidate("c.ts")
    await flush()
    // Debounced: the burst coalesces into one refresh.
    expect(fetches).toBe(2)
  })

  test("can record hidden invalidations without scheduling until visible", async () => {
    let fetches = 0
    const { store } = makeStore({
      fetch: () => {
        fetches++
        return Promise.resolve([{ path: "a.ts", status: "modified" }])
      },
    })
    store.ensure()
    await flush()
    expect(fetches).toBe(1)

    store.invalidate("a.ts", { schedule: false })
    await flush()
    expect(fetches).toBe(1)

    store.ensure()
    await flush()
    expect(fetches).toBe(2)
  })

  test("drops a dirty path that is no longer dirty after refresh", async () => {
    let dirty = true
    const { store } = makeStore({
      fetch: () =>
        Promise.resolve(dirty ? [{ path: "a.ts", status: "added" }] : []),
    })
    store.ensure()
    await flush()
    expect(store.status()?.get("a.ts")).toBe("add")

    dirty = false
    store.invalidate("a.ts")
    await flush()
    expect(store.status()?.has("a.ts")).toBe(false)
  })

  test("normalizes keys to the tree convention", async () => {
    const { store } = makeStore({
      fetch: () => Promise.resolve([{ path: "src\\a.ts", status: "deleted" }]),
    })
    store.ensure()
    await flush()
    expect(store.status()).toEqual(new Map([["src/a.ts", "del"]]))
  })
})
