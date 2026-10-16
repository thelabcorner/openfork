import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createFileTreeStore, type TreeSnapshot } from "./tree-store"
import { createIncrementalLiveFileTreeV2, flattenLiveFileTreeV2 } from "../../components/file-tree-v2-model"

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
  test("module snapshots never cross cache owners that share the same directory", async () => {
    const cache = new Map<string, TreeSnapshot>()
    const makeOwned = (owner: string) =>
      createRoot(() =>
        createFileTreeStore({
          scope: () => "/same/repo",
          cacheScope: () => `${owner}\u0000/same/repo`,
          normalizeDir: (input) => input,
          list: async () => [
            { path: "owner.txt", name: "owner.txt", absolute: "/same/repo/owner.txt", type: "file", ignored: false },
          ],
          onError: () => {},
          cache: { store: cache },
        }),
      )

    const serverA = makeOwned("server-a")
    await serverA.listDir("")
    serverA.persist()

    const serverB = makeOwned("server-b")
    expect(serverB.children("")).toEqual([])

    const serverAAgain = makeOwned("server-a")
    expect(serverAAgain.children("").map((node) => node.path)).toEqual(["owner.txt"])
  })

  test("warm snapshot is bounded, visible immediately, and never considered authoritative", async () => {
    const { store } = makeStore()
    await store.listDir("")
    store.expandDir("src", { list: false })
    await store.listDir("src")
    const warm = store.warmSnapshot(2, 8)
    expect(warm.nodeCount).toBeLessThanOrEqual(2)
    expect(warm.dir[""]?.loaded).toBe(false)

    const seeded = createRoot(() =>
      createFileTreeStore({
        scope: () => "/seeded",
        normalizeDir: (input) => input,
        list: async () => [],
        onError: () => {},
        cache: { store: new Map() },
      }),
    )
    expect(seeded.seedWarmSnapshot(warm)).toBe(true)
    expect(seeded.children("").length).toBeGreaterThan(0)
    expect(seeded.isLoaded("")).toBe(false)
  })

  test("warm snapshot never overwrites an authoritative root response", async () => {
    const { store } = makeStore()
    const warm = store.warmSnapshot()
    await store.listDir("")
    expect(store.seedWarmSnapshot(warm)).toBe(false)
    expect(store.children("").map((node) => node.path)).toEqual(["src", "package.json"])
  })

  test("queue overflow preserves cached children instead of applying an empty response", async () => {
    let blocked = false
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const store = createRoot(() => createFileTreeStore({
      scope: () => "/overflow",
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

  test("search-index snapshots are stable across asynchronous directory updates", async () => {
    const { store } = makeStore()
    await store.listDir("")
    const snapshot = store.allNodes()
    expect(store.allNodes()).toBe(snapshot)
    expect(snapshot.map((node) => node.path)).toEqual(["src", "package.json"])

    // Search consumes this snapshot over multiple event-loop slices while
    // another listing can append/swap-remove the live index.
    await store.listDir("src")
    expect(snapshot.map((node) => node.path)).toEqual(["src", "package.json"])
    const updated = store.allNodes()
    expect(updated).not.toBe(snapshot)
    expect(updated.map((node) => node.path)).toContain("src/index.ts")
    expect(store.allNodes()).toBe(updated)
  })

  test("unchanged watcher refresh preserves the child projection and validates freshness", async () => {
    const { store } = makeStore()
    await store.listDir("")
    const children = store.children("")
    const index = store.allNodes()
    store.markAllStale()
    expect(store.isLoaded("")).toBe(false)

    await store.listDir("", { force: true })
    expect(store.isLoaded("")).toBe(true)
    expect(store.children("")).toBe(children)
    expect(store.allNodes()).toBe(index)
  })

  test("first empty listing commits an authoritative empty child array", async () => {
    const { store } = makeStore()
    await store.listDir("empty")
    expect(store.dirState("empty")?.loaded).toBe(true)
    expect(store.dirState("empty")?.children).toEqual([])
    expect(store.isLoaded("empty")).toBe(true)
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

  test("interactive directory expansion promotes a queued background refresh without duplicate I/O", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const calls: Array<{ dir: string; priority: string }> = []
    const promotions: string[] = []
    const store = createRoot(() => createFileTreeStore({
      scope: () => "/priority",
      normalizeDir: (dir) => dir,
      list: async (dir, priority) => {
        calls.push({ dir, priority })
        if (dir.startsWith("blocked")) await blocked
        return []
      },
      promote: (dir) => { promotions.push(dir) },
      onError: () => {},
      cache: { store: new Map() },
    }))

    const active = Array.from({ length: 3 }, (_, i) => store.listDir(`blocked-${i}`, { priority: "background" }))
    const background = Array.from({ length: 20 }, (_, i) => store.listDir(`queued-${i}`, { priority: "background" }))
    const target = store.listDir("target", { priority: "background" })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls.map((x) => x.dir)).not.toContain("target")

    const interactive = store.listDir("target", { priority: "interactive" })
    expect(interactive).toBe(target)
    await interactive
    expect(calls.filter((x) => x.dir === "target")).toEqual([{ dir: "target", priority: "interactive" }])
    expect(promotions).toEqual(["target"])

    release()
    await Promise.all([...active, ...background])
    store.dispose()
  })

  test("new interactive listings bypass queued background work at the reserved slot", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const calls: string[] = []
    const store = createRoot(() => createFileTreeStore({
      scope: () => "/reserve",
      normalizeDir: (dir) => dir,
      list: async (dir) => {
        calls.push(dir)
        if (dir.startsWith("blocked")) await blocked
        return []
      },
      onError: () => {},
      cache: { store: new Map() },
    }))
    const active = Array.from({ length: 3 }, (_, i) => store.listDir(`blocked-${i}`, { priority: "background" }))
    const queued = Array.from({ length: 10 }, (_, i) => store.listDir(`pending-${i}`, { priority: "background" }))
    await Promise.resolve()
    await store.listDir("interactive", { priority: "interactive" })
    expect(calls.at(-1)).toBe("interactive")
    expect(calls.some((dir) => dir.startsWith("pending-"))).toBe(false)
    release()
    await Promise.all([...active, ...queued])
    store.dispose()
  })

  test("mass root removal drops descendant indexes and stale child caches without corrupting survivors", async () => {
    let removed = false
    const makeNode = (path: string, type: "file" | "directory"): FileNode => ({
      path, name: path.slice(path.lastIndexOf("/") + 1),
      absolute: `/mass/${path}`, type, ignored: false,
    })
    const store = createRoot(() => createFileTreeStore({
      scope: () => "/mass",
      normalizeDir: (dir) => dir,
      list: async (dir) => dir === ""
        ? removed ? [makeNode("keep", "directory")] : [
            makeNode("keep", "directory"),
            ...Array.from({ length: 1_500 }, (_, i) => makeNode(`drop-${i}`, "directory")),
          ]
        : [makeNode(`${dir}/leaf.ts`, "file")],
      onError: () => {},
      cache: { store: new Map(), maxLiveNodes: 10_000 },
    }))
    await store.listDir("")
    const loaded = Array.from({ length: 100 }, (_, i) => `drop-${i}`)
    await Promise.all(["keep", ...loaded].map((dir) => store.listDir(dir)))
    for (const dir of ["keep", ...loaded]) expect(store.children(dir)).toHaveLength(1)
    expect(store.allNodes().length).toBeGreaterThan(1_500)

    removed = true
    await store.listDir("", { force: true })
    expect(store.children("").map((item) => item.path)).toEqual(["keep"])
    expect(store.children("keep").map((item) => item.path)).toEqual(["keep/leaf.ts"])
    expect(store.hasNode("drop-0")).toBe(false)
    expect(store.hasNode("drop-0/leaf.ts")).toBe(false)
    expect(store.children("drop-0")).toEqual([])
    expect(store.allNodes().map((node) => node.path).toSorted()).toEqual(["keep", "keep/leaf.ts"])
    store.dispose()
  })

  test("preserves unchanged node identity across forced watcher refreshes", async () => {
    const { store } = makeStore()
    await store.listDir("")
    const before = store.node("src")
    await store.listDir("", { force: true })
    expect(store.node("src")).toBe(before)
  })

  test("cached child arrays remain O(1)-reusable until a same-order metadata update", async () => {
    let mtime = 1
    const store = createRoot(() => createFileTreeStore({
      scope: () => "/child-cache",
      normalizeDir: (path) => path,
      list: async () => Array.from({ length: 2000 }, (_, index) => ({
        name: `file-${index}.ts`, path: `file-${index}.ts`,
        absolute: `/child-cache/file-${index}.ts`, type: "file" as const,
        ignored: false, mtime: index === 1100 ? mtime : 1,
      })),
      onError: () => {},
      cache: { store: new Map() },
    }))
    await store.listDir("")
    const first = store.children("")
    expect(store.children("")).toBe(first)
    const revision = store.nodeRevision()
    await store.listDir("", { force: true })
    expect(store.children("")).toBe(first)
    expect(store.nodeRevision()).toBe(revision)

    mtime = 2
    await store.listDir("", { force: true })
    const second = store.children("")
    expect(second).not.toBe(first)
    expect(second[1100]?.mtime).toBe(2)
    expect(store.nodeRevision()).toBeGreaterThan(revision)
    expect(store.children("")).toBe(second)
    store.dispose()
  })

  test("directory to file replacement prunes old descendants but preserves the replacement path", async () => {
    let isDirectory = true
    const node = (path: string, type: "file" | "directory"): FileNode => ({
      path, name: path.split("/").at(-1)!, absolute: `/conversion/${path}`,
      type, ignored: false,
    })
    const store = createRoot(() => createFileTreeStore({
      scope: () => "/conversion",
      normalizeDir: (dir) => dir,
      list: async (dir) => {
        if (dir === "") return [node("src", isDirectory ? "directory" : "file"), node("other.md", "file")]
        if (dir === "src") return [node("src/deep", "directory")]
        if (dir === "src/deep") return [node("src/deep/child.ts", "file")]
        return []
      },
      onError: () => {},
      cache: { store: new Map() },
    }))
    await store.listDir("")
    await store.listDir("src")
    await store.listDir("src/deep")
    expect(store.hasNode("src/deep/child.ts")).toBe(true)
    expect(store.children("src/deep")).toHaveLength(1)
    const before = store.viewRevision()
    isDirectory = false
    await store.listDir("", { force: true })
    expect(store.node("src")?.type).toBe("file")
    expect(store.hasNode("src/deep")).toBe(false)
    expect(store.hasNode("src/deep/child.ts")).toBe(false)
    expect(store.children("src")).toEqual([])
    expect(store.children("src/deep")).toEqual([])
    expect(store.allNodes().map((item) => item.path).toSorted()).toEqual(["other.md", "src"])
    expect(store.changesSince(before)?.convertedDirectories).toEqual(["src"])
    expect(store.changesSince(before)?.removedRoots).toEqual([])
    store.dispose()
  })

  test("completed directory listing emits authoritative removed roots, but collapse and no-op do not", async () => {
    let present = true
    const node = (path: string, type: "directory" | "file"): FileNode => ({
      path, name: path.split("/").at(-1)!, absolute: `/removed/${path}`,
      type, ignored: false,
    })
    const store = createRoot(() => createFileTreeStore({
      scope: () => "/removed",
      normalizeDir: (path) => path,
      list: async (dir) => dir === ""
        ? [node("src", "directory"), node("stable.md", "file")]
        : present ? [node("src/deleted", "directory"), node("src/keep.ts", "file")] :
          [node("src/keep.ts", "file")],
      onError: () => {},
      cache: { store: new Map() },
    }))
    await store.listDir("")
    await store.listDir("src")
    await store.listDir("src/deleted")
    const before = store.viewRevision()
    present = false
    await store.listDir("src", { force: true })
    const changed = store.changesSince(before)
    expect(changed?.directories).toEqual(["src"])
    expect(changed?.removedRoots).toEqual(["src/deleted"])
    const after = store.viewRevision()
    await store.listDir("src", { force: true })
    expect(store.changesSince(after)?.removedRoots).toEqual([])
    store.collapseDir("src")
    expect(store.changesSince(after)?.removedRoots).toEqual([])
    store.reset()
    expect(store.changesSince(after)).toBeUndefined()
    store.dispose()
  })

  test("structural change journal reports affected directories, ignores no-ops and invalidates on reset", async () => {
    const { store } = makeStore()
    const initial = store.viewRevision()
    await store.listDir("")
    expect(store.changesSince(initial)?.directories).toEqual([""])
    const rootRevision = store.viewRevision()
    await store.listDir("", { force: true })
    expect(store.viewRevision()).toBe(rootRevision)
    expect(store.changesSince(rootRevision)?.directories).toEqual([])

    store.expandDir("src", { list: false })
    expect(store.changesSince(rootRevision)?.directories).toEqual(["src"])
    const expandedRevision = store.viewRevision()
    await store.listDir("src")
    expect(store.changesSince(expandedRevision)?.directories).toEqual(["src"])
    const listedRevision = store.viewRevision()
    store.collapseDir("src")
    expect(store.changesSince(listedRevision)?.directories).toEqual(["src"])
    store.reset()
    expect(store.changesSince(listedRevision)).toBeUndefined()
  })

  test("owner journal keeps incremental explorer rows identical through watcher, toggle, reset and metadata changes", async () => {
    let srcRevision = 1
    let srcLeaves = ["src/a.ts", "src/b.ts"]
    const node = (path: string, type: "directory" | "file"): FileNode => ({
      path, name: path.split("/").at(-1)!, absolute: `/view/${path}`,
      type, ignored: false, mtime: type === "file" ? srcRevision : 1,
    })
    const store = createRoot(() => createFileTreeStore({
      scope: () => "/view",
      normalizeDir: (dir) => dir,
      list: async (dir) => dir === ""
        ? [node("src", "directory"), node("README.md", "file")]
        : dir === "src" ? srcLeaves.map((leaf) => node(leaf, "file")) : [],
      onError: () => {},
      cache: { store: new Map() },
    }))
    const children = (dir: string) => store.children(dir)
    const expanded = (dir: string) => store.dirState(dir)?.expanded ?? false
    const projection = createIncrementalLiveFileTreeV2(children, expanded)
    let revision = store.viewRevision()
    const check = () => {
      const changes = store.changesSince(revision)
      if (!changes) projection.rebuild()
      else for (const directory of changes.directories) projection.update(directory)
      revision = store.viewRevision()
      const asPaths = (rows: ReturnType<typeof flattenLiveFileTreeV2>) =>
        rows.map((row) => [row.node.path, row.level, row.node.mtime])
      expect(asPaths(projection.rows())).toEqual(asPaths(flattenLiveFileTreeV2(children, expanded)))
    }

    await store.listDir("")
    check()
    store.expandDir("src", { list: false })
    check()
    await store.listDir("src")
    check()
    srcRevision = 2
    srcLeaves = ["src/b.ts", "src/c.ts", "src/a.ts"]
    await store.listDir("src", { force: true })
    check()
    store.collapseDir("src")
    check()
    srcLeaves = ["src/c.ts"]
    await store.listDir("src", { force: true })
    check()
    store.expandDir("src", { list: false })
    check()
    store.reset()
    check()
    store.dispose()
  })

  test("identical forced refresh does not invalidate allNodes consumers", async () => {
    const store = createRoot(() =>
      createFileTreeStore({
        scope: () => "/node-version",
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
