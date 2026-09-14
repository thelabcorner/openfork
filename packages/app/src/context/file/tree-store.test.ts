import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createFileTreeStore, sharedListGateCount, type TreeSnapshot } from "./tree-store"

const fs: Record<string, { name: string; type: "file" | "directory" }[]> = {
  "": [
    { name: "src", type: "directory" },
    { name: "package.json", type: "file" },
  ],
  src: [
    { name: "index.ts", type: "file" },
    { name: "lib", type: "directory" },
  ],
  "src/lib": [{ name: "util.ts", type: "file" }],
}

// A wide tree: enough directories that a single expandAll level exceeds the
// scheduler queue cap while the first request is blocked.
const deep: Record<string, FileNode[]> = (() => {
  const out: Record<string, FileNode[]> = {}
  const root: FileNode[] = []
  for (let d = 0; d < 20; d++) {
    const dir = `branch${d}`
    root.push({ path: dir, name: dir, absolute: `/truncate/${dir}`, type: "directory", ignored: false })
    out[dir] = [{ path: `${dir}/leaf.ts`, name: "leaf.ts", absolute: `/truncate/${dir}/leaf.ts`, type: "file", ignored: false }]
  }
  out[""] = root
  return out
})()

function makeStore(opts?: { cache?: { maxScopes?: number; maxNodes?: number; maxLiveNodes?: number } }) {
  return createRoot(() => {
    const [scope, setScope] = createSignal("/repo")
    const store = createFileTreeStore({
      scope,
      normalizeDir: (input: string) => input,
      list: (dir: string) =>
        Promise.resolve(
          (fs[dir] ?? []).map(
            (entry): FileNode => ({
              path: dir ? `${dir}/${entry.name}` : entry.name,
              name: entry.name,
              absolute: `/repo/${dir ? `${dir}/${entry.name}` : entry.name}`,
              type: entry.type,
              ignored: false,
            }),
          ),
        ),
      onError: () => {},
      // Isolated per-test map: createFileTreeStore's default cache is a module-level
      // singleton (by design, so it survives a real FileProvider remount) -- without this
      // override every test in this file would share it and pollute each other via
      // reused scope names like "/repo"/"/other".
      cache: { ...opts?.cache, store: new Map<string, TreeSnapshot>() },
    })
    const switchTo = (next: string) => {
      setScope(next)
      store.switchScope()
    }
    return { store, switchTo }
  })
}

describe("file tree store search + expand/collapse helpers", () => {
  test("queue overflow preserves cached children instead of applying an empty response", async () => {
    let blocked = false
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const store = createRoot(() => createFileTreeStore({
      scope: () => "/overflow",
      schedulerKey: () => "overflow-regression",
      normalizeDir: (input) => input,
      list: async () => {
        if (blocked) await barrier
        return [{ path: "keep", name: "keep", absolute: "/overflow/keep", type: "file", ignored: false }]
      },
      onError: () => {},
      cache: { store: new Map() },
    }))
    await store.listDir("")
    blocked = true
    const pending = Array.from({ length: 1028 }, (_, index) => store.listDir(`queued-${index}`))
    await store.listDir("", { force: true })
    expect(store.children("").map((node) => node.path)).toEqual(["keep"])
    expect(store.dirState("")?.loading).toBe(false)
    store.dispose()
    release()
    await Promise.all(pending)
  })

  test("an invalidation during listing remains stale until a subsequent listing", async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const store = createRoot(() => createFileTreeStore({
      scope: () => "/stale-race", normalizeDir: (input) => input,
      list: async () => { await barrier; return [] },
      onError: () => {}, cache: { store: new Map() },
    }))
    const first = store.listDir("")
    store.markAllStale()
    release()
    await first
    expect(store.isLoaded("")).toBe(false)
    await store.listDir("")
    expect(store.isLoaded("")).toBe(true)
    store.dispose()
  })
  test("limits concurrent directory listings while preserving each caller", async () => {
    let active = 0
    let peak = 0
    const store = createRoot(() =>
      createFileTreeStore({
        scope: () => "/repo",
        normalizeDir: (input: string) => input,
        list: async (dir: string) => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 1))
          active -= 1
          return [
            {
              path: `${dir}/file.ts`,
              name: "file.ts",
              absolute: `/repo/${dir}/file.ts`,
              type: "file",
              ignored: false,
            },
          ]
        },
        onError: () => {},
        cache: { store: new Map<string, TreeSnapshot>() },
      }),
    )

    await Promise.all(Array.from({ length: 12 }, (_, index) => store.listDir(`dir-${index}`)))
    expect(peak).toBe(4)
    expect(store.dirState("dir-11")?.loaded).toBe(true)
  })

  test("preserves unchanged node identity across forced watcher refreshes", async () => {
    const { store } = makeStore()
    await store.listDir("")
    const before = store.node("src")
    await store.listDir("", { force: true })
    expect(store.node("src")).toBe(before)
  })

  test("identical forced refresh does not invalidate allNodes consumers", async () => {
    const store = createRoot(() =>
      createFileTreeStore({
        scope: () => "/node-version",
        schedulerKey: () => "node-version-regression",
        normalizeDir: (input) => input,
        list: async () => [
          { path: "same.ts", name: "same.ts", absolute: "/node-version/same.ts", type: "file", ignored: false },
        ],
        onError: () => {},
        cache: { store: new Map() },
      }),
    )

    expect(store.nodeRevision()).toBe(0)
    await store.listDir("")
    expect(store.allNodes().length).toBe(1)
    const revision = store.nodeRevision()
    expect(revision).toBeGreaterThan(0)

    await store.listDir("", { force: true })
    expect(store.allNodes().length).toBe(1)
    expect(store.nodeRevision()).toBe(revision)
    store.dispose()
  })

  test("bounds the live tree by dropping the coldest collapsed subtree", async () => {
    const { store } = makeStore({ cache: { maxLiveNodes: 2 } })
    await store.listDir("")
    await store.listDir("src")

    expect(store.allNodes().length).toBeLessThanOrEqual(2)
    expect(store.dirState("src")?.loaded).toBe(false)
  })

  test("disposes queued listings without starting stale work", async () => {
    let calls = 0
    const store = createRoot(() =>
      createFileTreeStore({
        scope: () => "/repo",
        normalizeDir: (input: string) => input,
        list: async () => {
          calls += 1
          await new Promise((resolve) => setTimeout(resolve, 1))
          return []
        },
        onError: () => {},
        cache: { store: new Map<string, TreeSnapshot>() },
      }),
    )

    const pending = Array.from({ length: 8 }, (_, index) => store.listDir(`stale-${index}`))
    store.dispose()
    await Promise.all(pending)
    expect(calls).toBe(0)
  })

  test("allNodes returns every loaded node", async () => {
    const { store } = makeStore()
    await store.listDir("")
    await store.listDir("src")
    await store.listDir("src/lib")
    expect(
      store
        .allNodes()
        .map((node) => node.path)
        .sort(),
    ).toEqual(["package.json", "src", "src/index.ts", "src/lib", "src/lib/util.ts"])
  })

  test("expandAll expands every loaded directory", async () => {
    const { store } = makeStore()
    await store.listDir("")
    await store.listDir("src")
    await store.listDir("src/lib")
    await store.expandAll()
    expect(store.dirState("")?.expanded).toBe(true)
    expect(store.dirState("src")?.expanded).toBe(true)
    expect(store.dirState("src/lib")?.expanded).toBe(true)
  })

  test("collapseAll collapses every loaded directory but keeps the root expanded", async () => {
    const { store } = makeStore()
    await store.listDir("")
    await store.listDir("src")
    await store.listDir("src/lib")
    store.collapseAll()
    expect(store.dirState("")?.expanded).toBe(true)
    expect(store.dirState("src")?.expanded).toBe(false)
    expect(store.dirState("src/lib")?.expanded).toBe(false)
  })

  test("expandAll recursively lists and expands directories that were never listed", async () => {
    const { store } = makeStore()
    await store.listDir("") // only the root is listed
    await store.expandAll()
    expect(store.dirState("src")?.expanded).toBe(true)
    expect(store.dirState("src")?.loaded).toBe(true)
    expect(store.dirState("src")?.children).toEqual(["src/index.ts", "src/lib"])
    expect(store.dirState("src/lib")?.expanded).toBe(true)
    expect(store.dirState("src/lib")?.loaded).toBe(true)
    expect(store.dirState("src/lib")?.children).toEqual(["src/lib/util.ts"])
    expect(store.dirState("")?.expanded).toBe(true)
  })

  test("collapseAll collapses every directory expanded by expandAll but keeps the root", async () => {
    const { store } = makeStore()
    await store.expandAll()
    store.collapseAll()
    expect(store.dirState("")?.expanded).toBe(true)
    expect(store.dirState("src")?.expanded).toBe(false)
    expect(store.dirState("src/lib")?.expanded).toBe(false)
  })

  test("expandAll keeps expanding sibling branches when one directory fails to list", async () => {
    const store = createRoot(() =>
      createFileTreeStore({
        scope: () => "/repo",
        normalizeDir: (input: string) => input,
        list: (dir: string) => {
          if (dir === "broken") return Promise.reject(new Error("boom"))
          const entries =
            dir === "" ? [...(fs[""] ?? []), { name: "broken", type: "directory" as const }] : (fs[dir] ?? [])
          return Promise.resolve(
            entries.map(
              (entry): FileNode => ({
                path: dir ? `${dir}/${entry.name}` : entry.name,
                name: entry.name,
                absolute: `/repo/${dir ? `${dir}/${entry.name}` : entry.name}`,
                type: entry.type,
                ignored: false,
              }),
            ),
          )
        },
        onError: () => {},
        cache: { store: new Map<string, TreeSnapshot>() },
      }),
    )
    await store.listDir("") // root lists "src", "package.json", "broken"
    await store.expandAll() // must not reject; "broken" stops its branch only
    expect(store.dirState("src")?.expanded).toBe(true)
    expect(store.dirState("src")?.loaded).toBe(true)
    expect(store.dirState("src/lib")?.expanded).toBe(true)
    expect(store.dirState("src/lib")?.loaded).toBe(true)
    expect(store.dirState("src/lib")?.children).toEqual(["src/lib/util.ts"])
    expect(store.dirState("broken")?.error).toBe("boom")
  })
})

describe("per-project LRU tree cache", () => {
  test("restores expanded/loaded subtree state on scope switch without refetch", async () => {
    const { store, switchTo } = makeStore()
    await store.listDir("")
    await store.listDir("src")
    store.expandDir("src")
    store.expandDir("src/lib")
    await store.listDir("src/lib")

    // Switch away, then back to the original scope.
    switchTo("/other")
    expect(store.dirState("")?.expanded).toBe(true)
    expect(store.dirState("src")).toBeUndefined()

    switchTo("/repo")
    // Cached state restored: src is loaded and src/lib is expanded, no refetch.
    expect(store.dirState("src")?.loaded).toBe(true)
    expect(store.dirState("src")?.expanded).toBe(true)
    expect(store.dirState("src/lib")?.expanded).toBe(true)
    expect(store.dirState("src/lib")?.loaded).toBe(true)
    expect(store.dirState("src")?.children).toEqual(["src/index.ts", "src/lib"])
  })

  test("scope switch to a cold project starts fresh", async () => {
    const { store, switchTo } = makeStore()
    await store.listDir("")
    await store.listDir("src")

    switchTo("/other")
    expect(store.dirState("")?.expanded).toBe(true)
    expect(store.dirState("src")).toBeUndefined()
    expect(store.allNodes()).toEqual([])
  })

  test("evicts the coldest scope when maxScopes is exceeded", async () => {
    const { store, switchTo } = makeStore({ cache: { maxScopes: 2 } })
    await store.listDir("")

    switchTo("/a")
    await store.listDir("")
    switchTo("/b")
    await store.listDir("")
    // Cache now holds {/repo, /a, /b} → /repo (coldest) is evicted.
    switchTo("/c")
    await store.listDir("")
    // /repo was evicted, so returning to it is a cold start.
    switchTo("/repo")
    expect(store.dirState("")?.expanded).toBe(true)
    expect(store.dirState("")?.loaded).toBeFalsy()
    expect(store.allNodes()).toEqual([])
  })

  test("evicts the coldest scope when maxNodes is exceeded", async () => {
    const { store, switchTo } = makeStore({ cache: { maxNodes: 3 } })
    await store.listDir("")
    await store.listDir("src")
    await store.listDir("src/lib")

    switchTo("/other")
    await store.listDir("")
    // /repo has 5 nodes (> maxNodes 3) and is the only other scope, so it is evicted.
    switchTo("/repo")
    expect(store.dirState("")?.loaded).toBeFalsy()
    expect(store.allNodes()).toEqual([])
  })

  test("explicit prewarm is root-only", async () => {
    const { store, switchTo } = makeStore()
    switchTo("/other")
    await store.prewarm()
    expect(store.dirState("")?.loaded).toBe(true)
    expect(store.dirState("src")?.loaded).toBeFalsy()
  })

  test("cold stores do not issue hidden prewarm requests", async () => {
    let calls = 0
    const store = createRoot(() =>
      createFileTreeStore({
        scope: () => "/idle",
        schedulerKey: () => "idle-no-prewarm",
        normalizeDir: (input) => input,
        list: async () => {
          calls++
          return []
        },
        onError: () => {},
        cache: { store: new Map() },
      }),
    )

    // Regression: cold FileProvider mounts used to schedule a 150ms root list
    // plus a fan-out over every top-level directory even when no tree UI was
    // mounted. FileProvider is also used for prompt mentions, so this made the
    // explorer do work while apparently closed.
    await Bun.sleep(220)
    expect(calls).toBe(0)
    store.dispose()
  })

  test("a scope switch-back after watcher invalidations does not re-list", async () => {
    // Regression: restore() used to re-derive the epoch as `snap.stale ? 1 : 0`,
    // but the restored directories carry loadedEpoch values from the PREVIOUS
    // store's counter. Freshness is (loaded && loadedEpoch === staleEpoch()), so
    // a snapshot taken at epoch 3 restored at epoch 0 and every directory looked
    // unloaded -- silently re-listing the whole tree and defeating the cache.
    const calls: string[] = []
    const spy = createRoot(() => {
      const [scope, setScope] = createSignal("/repo")
      const inner = createFileTreeStore({
        scope,
        normalizeDir: (input: string) => input,
        list: (dir: string) => {
          calls.push(dir)
          return Promise.resolve(
            (fs[dir] ?? []).map(
              (entry): FileNode => ({
                path: dir ? `${dir}/${entry.name}` : entry.name,
                name: entry.name,
                absolute: `/repo/${dir ? `${dir}/${entry.name}` : entry.name}`,
                type: entry.type,
                ignored: false,
              }),
            ),
          )
        },
        onError: () => {},
        cache: { store: new Map<string, TreeSnapshot>() },
      })
      return { inner, setScope }
    })

    await spy.inner.listDir("")
    await spy.inner.listDir("src")
    await spy.inner.listDir("src/lib")

    // Drive the epoch past 1, exactly as repeated watcher invalidations do, and
    // re-list so loadedEpoch tracks the current epoch.
    spy.inner.markAllStale()
    spy.inner.markAllStale()
    spy.inner.markAllStale()
    await spy.inner.listDir("")
    await spy.inner.listDir("src")
    await spy.inner.listDir("src/lib")
    expect(spy.inner.isLoaded("src")).toBe(true)

    spy.setScope("/other")
    spy.inner.switchScope()
    spy.setScope("/repo")
    spy.inner.switchScope()

    // The whole point: still loaded after the round trip.
    expect(spy.inner.isLoaded("src")).toBe(true)
    expect(spy.inner.isLoaded("src/lib")).toBe(true)

    calls.length = 0
    await spy.inner.listDir("src")
    await spy.inner.listDir("src/lib")
    expect(calls).toEqual([])

    spy.inner.dispose()
  })

  test("expandAll surfaces queue-overflow truncation instead of silently dropping branches", async () => {
    // Regression: at >= MAX_QUEUED_LIST_REQUESTS scheduleListRequest resolved
    // CANCELLED_LIST without taking a queue slot. expandAll then read
    // `tree.dir[dir]?.children`, which is undefined for a never-listed
    // directory, and returned [] -- so an overflowed expand-all silently
    // truncated its frontier with no error, no retry and no truncation state.
    const store = createRoot(() =>
      createFileTreeStore({
        scope: () => "/truncate",
        schedulerKey: () => "truncate-regression",
        normalizeDir: (input) => input,
        // Slow enough that queued requests actually accumulate: with 4 running at
    // once, a synchronous burst of 1100 leaves well past the 1024 cap waiting
    // when expandAll asks for its next directory.
    list: (dir: string) => new Promise<FileNode[]>((resolve) => setTimeout(() => resolve(deep[dir] ?? []), 0)),
        onError: () => {},
        cache: { store: new Map<string, TreeSnapshot>() },
      }),
    )

    // Load the root first so expandAll starts from a real frontier of branches
    // rather than having its own root request dropped.
    await store.listDir("")

    const pending: Promise<void>[] = []

    // Start expandAll and issue the burst with NO await in between: both are
    // queued before the microtask queue drains 4 active slots, so expandAll's
    // own requests land behind a saturated queue.
    // 1028 fillers: 4 go active, 1024 sit queued, and the cap is 1024 -- so the
    // next request is dropped. Kept just above the cap (not 1100) so the whole
    // test stays well inside the 5s per-test timeout.
    const promise = store.expandAll()
    const burst = Array.from({ length: 1028 }, (_, index) => store.listDir(`queued-${index}`))
    pending.push(...burst)
    const result = await promise

    // Truncation is reported, not swallowed.
    expect(result.truncated).toBe(true)
    expect(result.droppedDirectories.length).toBeGreaterThan(0)

    // The dropped directories are named, and each one is genuinely UNKNOWN --
    // no children committed and not marked loaded. That is the distinction the
    // old code lost: it could not tell a dropped request from an empty
    // directory, so it treated the branch as fully expanded and moved on.
    for (const dir of result.droppedDirectories) {
      expect(store.dirState(dir)?.children).toBeUndefined()
      expect(store.dirState(dir)?.loaded).toBeFalsy()
    }

    await Promise.all(pending)
    store.dispose()
  })

  test("a cancelled listing is never mistaken for an empty directory", async () => {
    // The scope-guard inside the scheduled task used to resolve a fresh `[]`,
    // which is indistinguishable from a genuine empty listing. CANCELLED_LIST is
    // the single chokepoint that means "no answer"; listDir must leave
    // loaded/children untouched when it sees it.
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    // Only the re-list under test waits on the barrier; the seed listings
    // below must resolve immediately or the test deadlocks on setup.
    let hold = false
    const store = createRoot(() =>
      createFileTreeStore({
        scope: () => "/sentinel",
        schedulerKey: () => "sentinel-regression",
        normalizeDir: (input) => input,
        list: async (dir: string) => {
          if (hold) await barrier
          return (fs[dir] ?? []).map(
            (entry): FileNode => ({
              path: dir ? `${dir}/${entry.name}` : entry.name,
              name: entry.name,
              absolute: `/sentinel/${dir ? `${dir}/${entry.name}` : entry.name}`,
              type: entry.type,
              ignored: false,
            }),
          )
        },
        onError: () => {},
        cache: { store: new Map<string, TreeSnapshot>() },
      }),
    )

    await store.listDir("")
    await store.listDir("src")
    const childrenBefore = store.dirState("src")?.children
    expect(childrenBefore).toEqual(["src/index.ts", "src/lib"])

    // Hold the re-list in flight, then dispose: the guard fires and yields the
    // sentinel instead of an authoritative empty array.
    hold = true
    const inFlight = store.listDir("src", { force: true })
    store.dispose()
    release()
    await inFlight

    expect(store.dirState("src")?.children).toEqual(childrenBefore)
  })

  test("trim drops the biggest subtree first instead of walking many small ones", async () => {
    // Only possible with incrementally tracked subtree sizes: the trim must
    // know each candidate's yield without walking it. The old LRU-only order
    // would drop the 25 cold one-file directories first (and then the big one
    // anyway); the size-first order drops the single 100-file directory and
    // stops, leaving the small ones loaded.
    const wide: Record<string, FileNode[]> = { "": [] }
    const rootKids: FileNode[] = []
    rootKids.push({ path: "big", name: "big", absolute: "/wide/big", type: "directory", ignored: false })
    const bigKids: FileNode[] = []
    for (let f = 0; f < 100; f++) {
      bigKids.push({ path: `big/f${f}`, name: `f${f}`, absolute: `/wide/big/f${f}`, type: "file", ignored: false })
    }
    wide["big"] = bigKids
    for (let d = 0; d < 25; d++) {
      const dir = `tiny${d}`
      rootKids.push({ path: dir, name: dir, absolute: `/wide/${dir}`, type: "directory", ignored: false })
      wide[dir] = [{ path: `${dir}/only.ts`, name: "only.ts", absolute: `/wide/${dir}/only.ts`, type: "file", ignored: false }]
    }
    wide[""] = [rootKids[0]!, ...rootKids.slice(1)]

    const store = createRoot(() =>
      createFileTreeStore({
        scope: () => "/wide",
        schedulerKey: () => "wide-regression",
        normalizeDir: (input: string) => input,
        list: (dir: string) => Promise.resolve(wide[dir] ?? []),
        onError: () => {},
        cache: { maxLiveNodes: 100, store: new Map<string, TreeSnapshot>() },
      }),
    )

    await store.listDir("")
    // Coldest first: the tiny directories are listed before the big one, so a
    // pure LRU trim would eat them before touching it.
    for (let d = 0; d < 25; d++) await store.listDir(`tiny${d}`)
    await store.listDir("big")

    // 26 + 25 + 100 = 151 nodes against a 100 ceiling: one 100-node victim.
    expect(store.allNodes().length).toBeLessThanOrEqual(100)
    expect(store.dirState("big")?.loaded).toBe(false)
    expect(store.dirState("tiny0")?.loaded).toBe(true)
    expect(store.dirState("tiny0")?.children).toEqual(["tiny0/only.ts"])
    store.dispose()
  })

  test("bounded scheduler gate map: many sidecar URLs do not grow the map without bound", async () => {
    // Keys are sidecar URLs, so cycling sidecars used to accumulate forever.
    // The old eviction only fired when it found a gate with `active === 0 &&
    // queue.length === 0`; if every gate held work it found nothing and the map
    // grew unbounded -- exactly under load. This asserts the invariant that
    // actually matters: the map never exceeds its intended bound.
    //
    // NOTE ON WHAT THIS DOES AND DOES NOT PROVE: it asserts the bound holds
    // while every gate is busy, which is the case the old code could not
    // handle. I could not construct a runtime-observable difference between
    // "evicted" and "retained" for a busy gate (an evicted gate's in-flight
    // jobs keep running against the object they closed over), so this is a
    // direct invariant assertion rather than a behavioural repro.
    // Keys are sidecar URLs, so cycling sidecars used to accumulate forever.
    // The old eviction only fired when it found a gate with `active === 0 &&
    // queue.length === 0`; if every gate held work it found nothing and the map
    // grew unbounded -- exactly under load.
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const stores = Array.from({ length: 60 }, (_, index) =>
      createRoot(() =>
        createFileTreeStore({
          scope: () => `/gate-${index}`,
          // A distinct key per store, as distinct sidecar URLs would produce.
          schedulerKey: () => `http://sidecar-${index}.local`,
          normalizeDir: (input: string) => input,
          // Each gate is left holding ACTIVE work, which is the case the old
          // eviction could not handle.
          list: async () => {
            await barrier
            return []
          },
          onError: () => {},
          cache: { store: new Map<string, TreeSnapshot>() },
        }),
      ),
    )
    for (const store of stores) void store.listDir("")

    expect(sharedListGateCount()).toBeLessThanOrEqual(32)

    release()
    for (const store of stores) store.dispose()
    await Promise.all([])
  })

  test("persist() saves the current scope so a fresh store for the same scope seeds warm", async () => {
    // Simulates a FileProvider remount: same directory, same backing cache map, but a
    // brand new createFileTreeStore() call (a fresh Solid store with nothing loaded yet).
    const listCalls: string[] = []
    const sharedCache = new Map<string, TreeSnapshot>()
    const build = () =>
      createRoot((dispose) => {
        const store = createFileTreeStore({
          scope: () => "/repo",
          normalizeDir: (input: string) => input,
          list: (dir: string) => {
            listCalls.push(dir)
            return Promise.resolve(
              (fs[dir] ?? []).map(
                (entry): FileNode => ({
                  path: dir ? `${dir}/${entry.name}` : entry.name,
                  name: entry.name,
                  absolute: `/repo/${dir ? `${dir}/${entry.name}` : entry.name}`,
                  type: entry.type,
                  ignored: false,
                }),
              ),
            )
          },
          onError: () => {},
          cache: { store: sharedCache },
        })
        return { store, dispose }
      })

    const first = build()
    await first.store.listDir("")
    await first.store.listDir("src")
    first.store.persist() // what FileProvider's onCleanup calls before unmounting
    first.dispose()

    listCalls.length = 0
    const second = build()
    // Seeded from the cache at construction time -- no refetch, and no waiting on a
    // promise -- this must be true synchronously, the same tick the store is created.
    expect(second.store.dirState("")?.loaded).toBe(true)
    expect(second.store.dirState("src")?.loaded).toBe(true)
    expect(second.store.dirState("src")?.children).toEqual(["src/index.ts", "src/lib"])
    expect(listCalls).toEqual([])
    second.dispose()
  })
})
