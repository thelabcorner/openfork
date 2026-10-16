import { describe, expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import {
  appendedProjectExplorerSearchPaths,
  createProjectExplorerSearchAccumulator,
  mergeProjectExplorerSearchPaths,
  projectProjectExplorerSearchRows,
  startProjectExplorerSearch,
} from "./project-explorer-search-runner"
import { buildFileTreeV2Model, flattenFileTreeV2 } from "./file-tree-v2-model"

const node = (index: number): FileNode => ({
  name: `file-${index}.ts`,
  path: `src/file-${index}.ts`,
  absolute: `/repo/src/file-${index}.ts`,
  type: "file",
  ignored: false,
})

describe("project explorer cooperative search", () => {
  test("searches 50k loaded nodes in cooperative slices", async () => {
    const nodes = Array.from({ length: 50_000 }, (_, index) => node(index))
    const result = await new Promise<{
      matches: number
      rows: number
      slices: number
      maxSliceMs: number
      totalMs: number
    }>((resolve) => {
      startProjectExplorerSearch({
        query: "file-",
        nodes,
        root: () => nodes,
        children: () => [],
        complete: (search, metrics) =>
          resolve({
            matches: search.matches.size,
            rows: search.rows.length,
            slices: metrics.slices,
            maxSliceMs: metrics.maxSliceMs,
            totalMs: metrics.totalMs,
          }),
      })
    })

    console.info(`[explorer-50k] ${JSON.stringify(result)}`)
    expect(result.matches).toBe(50_000)
    expect(result.rows).toBe(50_000)
    expect(result.slices).toBeGreaterThan(1)
    // This is deliberately looser than the 4ms target to avoid CI scheduler
    // noise while still catching a regression back to one monolithic 20ms+
    // traversal on ordinary developer hardware.
    expect(result.maxSliceMs).toBeLessThan(16)
  })

  test("a superseding generation cancels before publishing stale results", async () => {
    const nodes = Array.from({ length: 50_000 }, (_, index) => node(index))
    let cancelled = false
    let published = false
    const stop = startProjectExplorerSearch({
      query: "file-",
      nodes,
      root: () => nodes,
      children: () => [],
      cancelled: () => cancelled,
      complete: () => {
        published = true
      },
    })
    cancelled = true
    await new Promise((resolve) => setTimeout(resolve, 10))
    stop()
    expect(published).toBe(false)
  })

  test("candidate-set mode skips static tree projection", async () => {
    const nodes = [node(1)]
    const result = await new Promise<{ matches: Set<string>; ancestors: Set<string>; rows: number }>((resolve) => {
      startProjectExplorerSearch({
        query: "file-",
        nodes,
        root: () => {
          throw new Error("candidate-set mode must not project rows")
        },
        children: () => {
          throw new Error("candidate-set mode must not project rows")
        },
        projectRows: false,
        complete: (search) => resolve({ matches: new Set(search.matches), ancestors: new Set(search.ancestors), rows: search.rows.length }),
      })
    })
    expect(result.matches).toEqual(new Set(["src/file-1.ts"]))
    expect(result.ancestors).toEqual(new Set(["src"]))
    expect(result.rows).toBe(0)
  })

  test("wide root materialization is lazy before the first cooperative yield", () => {
    const rootNodes = Array.from({ length: 50_000 }, (_, index) => node(index))
    let accesses = 0
    const source = new Proxy(rootNodes, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) accesses++
        return Reflect.get(target, key, receiver)
      },
    })
    let virtualTime = 0
    let completed = 0
    let enteredProjection = false
    const scheduled: Array<() => void> = []
    startProjectExplorerSearch({
      query: "file-",
      nodes: rootNodes,
      root: () => { enteredProjection = true; return source },
      children: () => [],
      sliceMs: 1,
      now: () => (virtualTime += 0.02),
      schedule: (run) => { scheduled.push(run); return 0 as unknown as ReturnType<typeof setTimeout> },
      complete: (result) => { completed = result.rows.length },
    })
    while (scheduled.length > 0 && !enteredProjection) scheduled.shift()!()
    expect(enteredProjection).toBe(true)
    expect(accesses).toBeLessThan(5000)
    expect(completed).toBe(0)
    while (scheduled.length > 0) scheduled.shift()!()
    expect(completed).toBe(50_000)
  })

  test("merges unloaded server paths and derives every ancestor", () => {
    const base = {
      query: "router",
      matches: new Set(["src/router.ts"]),
      ancestors: new Set(["src"]),
      rows: [],
    }
    const merged = mergeProjectExplorerSearchPaths(base, [
      "packages/core/src/server/router.ts",
      "packages\\app\\src\\router.ts",
    ])
    expect(merged.matches).toEqual(
      new Set(["src/router.ts", "packages/core/src/server/router.ts", "packages/app/src/router.ts"]),
    )
    expect(merged.ancestors).toEqual(
      new Set([
        "src",
        "packages/core/src/server",
        "packages/core/src",
        "packages/core",
        "packages",
        "packages/app/src",
        "packages/app",
      ]),
    )
  })

  test("incremental pages converge regardless of local/remote completion order without mutating snapshots", () => {
    const local = {
      query: "file", matches: new Set(["src/file-local.ts"]),
      ancestors: new Set(["src"]), rows: [],
    }
    for (const remoteFirst of [true, false]) {
      const accumulator = createProjectExplorerSearchAccumulator("file")
      let previous = accumulator.snapshot()
      if (remoteFirst) {
        accumulator.page(["packages/app/file-first.ts"], ["packages/app"])
        previous = accumulator.snapshot()
      } else {
        accumulator.local(local)
        previous = accumulator.snapshot()
      }
      const oldMatches = new Set(previous.matches)
      const oldAncestors = new Set(previous.ancestors)
      if (remoteFirst) accumulator.local(local)
      else accumulator.page(["packages/app/file-first.ts"], ["packages/app"])
      accumulator.page(["packages/app/file-next.ts", "src/file-local.ts"], [])
      const next = accumulator.snapshot()
      expect(new Set(next.matches)).toEqual(new Set([
        "src/file-local.ts", "packages/app/file-first.ts", "packages/app/file-next.ts",
      ]))
      expect(new Set(next.ancestors)).toEqual(new Set(["src", "packages/app", "packages"]))
      expect(new Set(previous.matches)).toEqual(oldMatches)
      expect(new Set(previous.ancestors)).toEqual(oldAncestors)
      const unchanged = accumulator.page([])
      expect(unchanged).toBe(next)
      expect(accumulator.local(local)).toBe(next)
    }
  })

  test("immutable paginated snapshots isolate membership, size and iterators from later pages", () => {
    const accumulator = createProjectExplorerSearchAccumulator("file")
    const empty = accumulator.snapshot()
    accumulator.page(["src/file-a.ts", "src/file-b.ts"])
    const first = accumulator.snapshot()
    const iterator = first.matches[Symbol.iterator]()
    expect(iterator.next().value).toBe("src/file-a.ts")
    accumulator.page(["src/file-c.ts", "pkg/lib/file-d.ts"])
    const second = accumulator.snapshot()
    expect(first.matches.size).toBe(2)
    expect(first.matches.has("src/file-c.ts")).toBe(false)
    expect(first.ancestors.has("pkg")).toBe(false)
    expect(iterator.next().value).toBe("src/file-b.ts")
    expect(iterator.next().done).toBe(true)
    expect([...first.matches]).toEqual(["src/file-a.ts", "src/file-b.ts"])
    expect([...second.matches]).toEqual([
      "src/file-a.ts", "src/file-b.ts", "src/file-c.ts", "pkg/lib/file-d.ts",
    ])
    expect([...second.ancestors]).toEqual(["src", "pkg/lib", "pkg"])
    expect(empty.matches.size).toBe(0)
    expect(empty.ancestors.size).toBe(0)
    const published = accumulator.page(["src/file-a.ts", "pkg/lib/file-d.ts"])
    expect(published).toBe(second)
    expect(published.matches.size).toBe(4)
  })

  test("directory-only pages preserve complete ancestry closure for later file pages", () => {
    const accumulator = createProjectExplorerSearchAccumulator("target")
    accumulator.page([], ["packages/core/src/server"])
    const early = accumulator.snapshot()
    expect(new Set(early.ancestors)).toEqual(new Set([
      "packages", "packages/core", "packages/core/src", "packages/core/src/server",
    ]))
    accumulator.page(["packages/core/src/server/target.ts"])
    expect(new Set(accumulator.snapshot().ancestors)).toEqual(new Set(early.ancestors))
    expect(early.matches.size).toBe(0)
    expect(accumulator.snapshot().matches.size).toBe(1)
  })

  test("rejects rooted and traversing server paths before normalization can launder them", () => {
    const accumulator = createProjectExplorerSearchAccumulator("secret")
    accumulator.page(
      ["/etc/secret.txt", "\\\\server\\share\\secret.txt", "C:\\windows\\secret.txt",
        "../secret.txt", "src/../../secret.txt", "src/./secret.txt",
        "safe/secret.txt"],
      ["/etc", "C:\\windows", "..\\src", "safe"],
    )
    expect(new Set(accumulator.snapshot().matches)).toEqual(new Set(["safe/secret.txt"]))
    expect(new Set(accumulator.snapshot().ancestors)).toEqual(new Set(["safe"]))
    const legacy = mergeProjectExplorerSearchPaths(
      { query: "secret", matches: new Set(), ancestors: new Set(), rows: [] },
      ["/etc/secret.txt", "safe/secret.txt"],
    )
    expect(new Set(legacy.matches)).toEqual(new Set(["safe/secret.txt"]))
  })

  test("watcher local-refresh additions are append-only; removals rebase without losing remote hits", () => {
    const accumulator = createProjectExplorerSearchAccumulator("file")
    const makeLocal = (...paths: string[]) => ({
      query: "file", matches: new Set(paths), ancestors: new Set<string>(), rows: [],
    })
    accumulator.page(["pkg/file-remote.ts", "src/file-shared.ts"])
    accumulator.local(makeLocal("src/file-local.ts", "src/file-shared.ts"))
    const before = accumulator.snapshot()
    const added = accumulator.refreshLocal(makeLocal(
      "src/file-local.ts", "src/file-shared.ts", "src/file-new.ts",
    ))
    expect(new Set(added.matches)).toEqual(new Set([
      "pkg/file-remote.ts", "src/file-shared.ts", "src/file-local.ts", "src/file-new.ts",
    ]))
    expect(appendedProjectExplorerSearchPaths(before.matches, added.matches)).toEqual(["src/file-new.ts"])
    expect(new Set(before.matches).has("src/file-new.ts")).toBe(false)
    const same = accumulator.refreshLocal(makeLocal(
      "src/file-local.ts", "src/file-shared.ts", "src/file-new.ts",
    ))
    expect(same).toBe(added)
    const removed = accumulator.refreshLocal(makeLocal("src/file-shared.ts", "src/file-new.ts"))
    expect(appendedProjectExplorerSearchPaths(added.matches, removed.matches)).toBeUndefined()
    expect(new Set(removed.matches)).toEqual(new Set([
      "pkg/file-remote.ts", "src/file-shared.ts", "src/file-new.ts",
    ]))
    expect(new Set(removed.ancestors)).toEqual(new Set(["pkg", "src"]))
    expect(new Set(added.matches).has("src/file-local.ts")).toBe(true)
    accumulator.page(["pkg/file-later.ts"])
    expect(new Set(accumulator.snapshot().matches)).toEqual(new Set([
      "pkg/file-remote.ts", "src/file-shared.ts", "src/file-new.ts", "pkg/file-later.ts",
    ]))
  })

  test("cooperative 50k watcher rebase preserves remote pages arriving mid-flight and old snapshots", () => {
    const accumulator = createProjectExplorerSearchAccumulator("file")
    const remote = Array.from({ length: 25_000 }, (_, i) => `pkg/file-remote-${i}.ts`)
    const local = Array.from({ length: 25_000 }, (_, i) => `src/file-local-${i}.ts`)
    const asResult = (paths: Iterable<string>) => ({
      query: "file", matches: new Set(paths), ancestors: new Set<string>(), rows: [],
    })
    accumulator.page(remote)
    accumulator.local(asResult(local))
    const before = accumulator.snapshot()
    const scheduled: Array<() => void> = []
    let virtualNow = 0
    let schedules = 0
    let completed = 0
    accumulator.refreshLocalCooperatively(asResult(local.slice(1)), {
      now: () => (virtualNow += 0.01),
      sliceMs: 0.4,
      schedule: (run) => {
        schedules++
        scheduled.push(run)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      complete: (snapshot) => { completed = snapshot.matches.size },
    })
    scheduled.shift()!()
    accumulator.page(["pkg/file-arrived-mid-rebase.ts"])
    while (scheduled.length) scheduled.shift()!()
    expect(schedules).toBeGreaterThan(20)
    expect(completed).toBe(50_000)
    expect(accumulator.snapshot().matches.has("src/file-local-0.ts")).toBe(false)
    expect(accumulator.snapshot().matches.has("pkg/file-arrived-mid-rebase.ts")).toBe(true)
    expect(before.matches.has("src/file-local-0.ts")).toBe(true)
    expect(before.matches.has("pkg/file-arrived-mid-rebase.ts")).toBe(false)
  })

  test("cancelling a cooperative local search rebase never publishes partial membership", () => {
    const accumulator = createProjectExplorerSearchAccumulator("file")
    const local = Array.from({ length: 3_000 }, (_, i) => `src/file-${i}.ts`)
    const result = (paths: string[]) => ({
      query: "file", matches: new Set(paths), ancestors: new Set<string>(), rows: [],
    })
    accumulator.local(result(local))
    const before = accumulator.snapshot()
    const scheduled: Array<() => void> = []
    let virtualNow = 0
    let published = false
    const cancel = accumulator.refreshLocalCooperatively(result(local.slice(1)), {
      now: () => (virtualNow += 0.01),
      sliceMs: 0.2,
      schedule: (run) => {
        scheduled.push(run)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      complete: () => { published = true },
    })
    scheduled.shift()!()
    cancel()
    while (scheduled.length) scheduled.shift()!()
    expect(published).toBe(false)
    expect(accumulator.snapshot()).toBe(before)
    expect(accumulator.snapshot().matches.has("src/file-0.ts")).toBe(true)
    accumulator.refreshLocal(result(local.slice(1)))
    expect(accumulator.snapshot().matches.has("src/file-0.ts")).toBe(false)
  })

  test("authoritative deletion hides stale remote file and directory subtree, even on later pages", async () => {
    const accumulator = createProjectExplorerSearchAccumulator("file")
    const local = { query: "file", matches: new Set<string>(), ancestors: new Set<string>(), rows: [] }
    accumulator.page([
      "src/removed/file.ts", "src/removed/deep/file.ts",
      "src/survivor/file.ts", "other/file.ts",
    ], ["src/removed"])
    accumulator.local(local)
    const before = accumulator.snapshot()
    expect(accumulator.invalidateRemoteRoots(["src/removed"])).toBe(true)
    expect(accumulator.invalidateRemoteRoots(["src/removed"])).toBe(false)
    accumulator.page(["src/removed/later-file.ts", "src/survivor/new-file.ts"])
    const result = await new Promise<ReturnType<typeof accumulator.snapshot>>((resolve) => {
      accumulator.refreshLocalCooperatively(local, { complete: resolve })
    })
    expect(new Set(result.matches)).toEqual(new Set([
      "src/survivor/file.ts", "other/file.ts", "src/survivor/new-file.ts",
    ]))
    expect(new Set(result.ancestors)).toEqual(new Set(["src/survivor", "src", "other"]))
    expect(before.matches.has("src/removed/file.ts")).toBe(true)
    expect(result.matches.has("src/removed/file.ts")).toBe(false)
    accumulator.page(["src/removed/last-file.ts"])
    expect(accumulator.snapshot()).toBe(result)
  })

  test("directory-to-file conversion removes descendant hits and stale directory hint but keeps the file", async () => {
    const accumulator = createProjectExplorerSearchAccumulator("src")
    const local = {
      query: "src", matches: new Set(["src/replaced"]), ancestors: new Set(["src"]), rows: [],
    }
    accumulator.page([
      "src/replaced", "src/replaced/old-file.ts", "src/replaced/deeper/old-file.ts",
      "src/keep.ts",
    ], ["src/replaced"])
    accumulator.local(local)
    expect(accumulator.invalidateRemoteDescendants(["src/replaced"])).toBe(true)
    expect(accumulator.invalidateRemoteDescendants(["src/replaced"])).toBe(false)
    accumulator.page(["src/replaced/late-file.ts", "src/new-file.ts"], ["src/replaced"])
    const current = await new Promise<ReturnType<typeof accumulator.snapshot>>((resolve) => {
      accumulator.refreshLocalCooperatively(local, { complete: resolve })
    })
    expect(new Set(current.matches)).toEqual(new Set([
      "src/replaced", "src/keep.ts", "src/new-file.ts",
    ]))
    expect(new Set(current.ancestors)).toEqual(new Set(["src"]))
    expect(current.matches.has("src/replaced/old-file.ts")).toBe(false)
    accumulator.page(["src/replaced/another.ts"])
    expect(accumulator.snapshot()).toBe(current)
  })

  test("invalidated search path shared by local and remote remains visible when locally re-created", async () => {
    const accumulator = createProjectExplorerSearchAccumulator("file")
    const existing = {
      query: "file", matches: new Set(["src/file.ts"]), ancestors: new Set(["src"]), rows: [],
    }
    accumulator.page(["src/file.ts", "src/remote-file.ts"])
    accumulator.local(existing)
    accumulator.invalidateRemoteRoots(["src/file.ts"])
    const result = await new Promise<ReturnType<typeof accumulator.snapshot>>((resolve) => {
      accumulator.refreshLocalCooperatively(existing, { complete: resolve })
    })
    expect(result.matches.has("src/file.ts")).toBe(true)
    expect(result.matches.has("src/remote-file.ts")).toBe(true)
    accumulator.page(["src/file.ts"])
    expect(accumulator.snapshot()).toBe(result)
  })

  test("projects a server-discovered match as its ancestors load", () => {
    const result = mergeProjectExplorerSearchPaths(
      { query: "router", matches: new Set(), ancestors: new Set(), rows: [] },
      ["packages/core/src/server/router.ts"],
    )
    const initial = flattenFileTreeV2(buildFileTreeV2Model(["packages/core/placeholder.ts"]), () => true)
    expect(projectProjectExplorerSearchRows(initial, result, "router").map((row) => row.node.path)).toEqual([
      "packages",
      "packages/core",
    ])

    const loaded = flattenFileTreeV2(
      buildFileTreeV2Model(["packages/core/src/server/router.ts", "packages/core/placeholder.ts"]),
      () => true,
    )
    expect(projectProjectExplorerSearchRows(loaded, result, "router").map((row) => row.node.path)).toEqual([
      "packages",
      "packages/core",
      "packages/core/src",
      "packages/core/src/server",
      "packages/core/src/server/router.ts",
    ])
  })

  test("search projection overlays newly loaded descendants without cloning or mutating the search snapshot", () => {
    const result = {
      query: "target",
      matches: new Set(["src/existing-target.ts"]),
      ancestors: new Set(["src"]),
      rows: [],
    }
    const rows = flattenFileTreeV2(
      buildFileTreeV2Model(["src/existing-target.ts", "src/deep/new-target.ts", "src/other.ts"]),
      () => true,
    )
    const projected = projectProjectExplorerSearchRows(rows, result, "target")
    expect(projected.map((row) => row.node.path)).toEqual([
      "src",
      "src/deep",
      "src/deep/new-target.ts",
      "src/existing-target.ts",
    ])
    expect(result.matches).toEqual(new Set(["src/existing-target.ts"]))
    expect(result.ancestors).toEqual(new Set(["src"]))
  })

  test("incremental projection agrees with full set merging across varied trees", () => {
    for (let seed = 0; seed < 36; seed++) {
      const paths = Array.from({ length: 240 }, (_, index) => {
        const folder = `group-${(seed + index * 7) % 19}`
        const name = (seed + index) % 5 === 0 ? `target-${index}.ts` : `other-${index}.ts`
        return `${folder}/nested-${index % 7}/${name}`
      })
      const rows = flattenFileTreeV2(buildFileTreeV2Model(paths), () => true)
      const remote = rows.filter((_, index) => index % 13 === seed % 13).map((row) => row.node.path)
      const result = mergeProjectExplorerSearchPaths(
        { query: "target", matches: new Set(), ancestors: new Set(), rows: [] },
        remote,
      )
      const liveMatches = rows.map((row) => row.node.path).filter((path) => path.toLowerCase().includes("target"))
      const merged = mergeProjectExplorerSearchPaths(result, liveMatches)
      const expected = rows
        .filter((row) => merged.matches.has(row.node.path) || merged.ancestors.has(row.node.path))
        .map((row) => row.node.path)
      expect(projectProjectExplorerSearchRows(rows, result, "target").map((row) => row.node.path)).toEqual(expected)
    }
  })
})
