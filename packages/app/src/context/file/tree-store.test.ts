import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createFileTreeStore, type TreeSnapshot } from "./tree-store"

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

function makeStore(opts?: { cache?: { maxScopes?: number; maxNodes?: number } }) {
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

  test("prewarm lists the root and shallow directories on a cold scope", async () => {
    const { store, switchTo } = makeStore()
    switchTo("/other")
    await store.prewarm()
    expect(store.dirState("")?.loaded).toBe(true)
    expect(store.dirState("src")?.loaded).toBe(true)
    expect(store.dirState("src")?.children).toEqual(["src/index.ts", "src/lib"])
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
