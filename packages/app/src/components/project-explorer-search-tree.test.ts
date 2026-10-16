import { describe, expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { flattenFileTreeV2 } from "./file-tree-v2-model"
import { buildProjectExplorerSearchTree, startProjectExplorerSearchTree } from "./project-explorer-search-tree"
import { createProjectExplorerSearchAccumulator } from "./project-explorer-search-runner"

describe("Project Explorer workspace search projection", () => {
  const loaded = (path: string, type: "file" | "directory" = "file"): FileNode => ({
    path, name: path.slice(path.lastIndexOf("/") + 1), absolute: `/workspace/${path}`,
    ignored: false, type,
  })

  test("projects unloaded server hits without requesting directory listings", () => {
    const matches = new Set(["packages/app/src/router.ts", "packages/core/src/router.ts"])
    const ancestors = new Set(["packages", "packages/app", "packages/app/src", "packages/core", "packages/core/src"])
    let lookups = 0
    const model = buildProjectExplorerSearchTree(matches, ancestors, (path) => {
      lookups++
      return path === "packages/app" ? loaded(path, "directory") : undefined
    })
    expect(lookups).toBe(model.total)
    expect(flattenFileTreeV2(model, () => true).map((r) => [r.node.path, r.node.type, r.level])).toEqual([
      ["packages", "directory", 0],
      ["packages/app", "directory", 1],
      ["packages/app/src", "directory", 2],
      ["packages/app/src/router.ts", "file", 3],
      ["packages/core", "directory", 1],
      ["packages/core/src", "directory", 2],
      ["packages/core/src/router.ts", "file", 3],
    ])
  })

  test("search collapse is projection-only and independent of persisted directory state", () => {
    const model = buildProjectExplorerSearchTree(
      new Set(["src/deep/target.ts", "src/top-target.ts"]),
      new Set(["src", "src/deep"]), () => undefined,
    )
    expect(flattenFileTreeV2(model, (path) => path !== "src/deep").map((r) => r.node.path))
      .toEqual(["src", "src/deep", "src/top-target.ts"])
    expect(flattenFileTreeV2(model, () => true).map((r) => r.node.path))
      .toEqual(["src", "src/deep", "src/deep/target.ts", "src/top-target.ts"])
  })

  test("preserves original absolute/native paths and directory matches", () => {
    const dir = loaded("src/target", "directory")
    const native = { ...loaded("src/target/file.ts"), size: 100, mtime: 567 }
    const nodes = new Map([dir, native].map((node) => [node.path, node]))
    const model = buildProjectExplorerSearchTree(
      new Set(["src/target", "src/target/file.ts"]),
      new Set(["src"]), (path) => nodes.get(path),
    )
    const paths = flattenFileTreeV2(model, () => true)
    expect(paths.find((row) => row.node.path === "src/target")?.node.type).toBe("directory")
    expect(paths.find((row) => row.node.path === native.path)?.node).toMatchObject({
      absolute: "/workspace/src/target/file.ts", originalPath: native.path, size: 100, mtime: 567,
    })
  })

  test("synthetic paths use their verified workspace root for absolute actions", () => {
    for (const [root, expected] of [
      ["/workspace", "/workspace/src/main.ts"],
      ["C:\\workspace", "C:\\workspace\\src\\main.ts"],
      ["/", "/src/main.ts"],
    ]) {
      const model = buildProjectExplorerSearchTree(
        new Set(["src/main.ts"]), new Set(), () => undefined, root,
      )
      const rows = flattenFileTreeV2(model, () => true)
      expect(rows.at(-1)?.node.absolute).toBe(expected)
    }
  })

  test("rejects absolute, traversal, and Windows drive paths in search results", () => {
    const model = buildProjectExplorerSearchTree(
      new Set(["../secrets.txt", "src/../../secrets.txt", "/etc/passwd", "C:\\secret.txt", "safe/file.ts"]),
      new Set(), () => undefined, "/workspace",
    )
    expect(flattenFileTreeV2(model, () => true).map((r) => r.node.path)).toEqual(["safe", "safe/file.ts"])
  })

  test("deep remote paths synthesize their ancestry even if server omits ancestor hints", () => {
    const path = Array.from({ length: 120 }, (_, i) => `level${i}`).join("/") + "/target.ts"
    const model = buildProjectExplorerSearchTree(new Set([path]), new Set(), () => undefined)
    expect(model.total).toBe(121)
    const rows = flattenFileTreeV2(model, () => true)
    expect(rows.length).toBe(121)
    expect(rows.at(-1)?.node.path).toBe(path)
  })

  test("large projections can flatten without filesystem callbacks or excessive allocations", () => {
    const matches = new Set(Array.from({ length: 50_000 }, (_, i) => `src/dir-${i % 100}/target-${i}.ts`))
    const model = buildProjectExplorerSearchTree(matches, new Set(), () => undefined)
    expect(model.total).toBe(50_101)
    expect(flattenFileTreeV2(model, () => true)).toHaveLength(50_101)
  })

  test("the cooperative builder produces the same rows and metadata as the synchronous reference", async () => {
    const paths = new Set(Array.from({ length: 3_200 }, (_, i) =>
      `src/group-${i % 40}/file-${String(3_200 - i).padStart(5, "0")}.ts`,
    ))
    paths.add("README.md")
    const ancestors = new Set(["src"])
    const lookup = (path: string) => path === "README.md" ? loaded(path) : undefined
    const expected = buildProjectExplorerSearchTree(paths, ancestors, lookup, "C:\\repo")
    const result = await new Promise<ReturnType<typeof buildProjectExplorerSearchTree>>((resolve) => {
      startProjectExplorerSearchTree({
        matches: paths,
        ancestors,
        lookup,
        root: "C:\\repo",
        sliceMs: 0.2,
        complete: (model) => resolve(model),
      })
    })
    expect(result.total).toBe(expected.total)
    expect(flattenFileTreeV2(result, () => true)).toEqual(flattenFileTreeV2(expected, () => true))
  })

  test("an in-flight projector never reads paths from later pages appended to the same index", () => {
    const accumulator = createProjectExplorerSearchAccumulator("file")
    accumulator.page(["src/file-a.ts", "src/file-b.ts"])
    const earlier = accumulator.snapshot()
    const scheduled: Array<() => void> = []
    let built: ReturnType<typeof buildProjectExplorerSearchTree> | undefined
    startProjectExplorerSearchTree({
      matches: earlier.matches,
      ancestors: earlier.ancestors,
      lookup: () => undefined,
      root: "/workspace",
      schedule: (run) => {
        scheduled.push(run)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      sliceMs: 1,
      complete: (model) => { built = model },
    })
    // The source is append-only, but this projector must see frozen bounds.
    accumulator.page(["src/file-c.ts", "src/file-d.ts", "pkg/file-e.ts"])
    while (scheduled.length > 0) scheduled.shift()!()
    expect(built).toBeDefined()
    expect(flattenFileTreeV2(built!, () => true).map((row) => row.node.path))
      .toEqual(["src", "src/file-a.ts", "src/file-b.ts"])
    const latest = accumulator.snapshot()
    expect(flattenFileTreeV2(buildProjectExplorerSearchTree(
      latest.matches, latest.ancestors, () => undefined,
    ), () => true).map((row) => row.node.path))
      .toEqual(["pkg", "pkg/file-e.ts", "src", "src/file-a.ts", "src/file-b.ts", "src/file-c.ts", "src/file-d.ts"])
  })

  test("even a single 50k-sibling directory builds and sorts cooperatively", async () => {
    const matches = new Set(Array.from({ length: 50_000 }, (_, i) =>
      `src/file-${String(50_000 - i).padStart(5, "0")}.ts`,
    ))
    const { rows, slices, maxSliceMs } = await new Promise<{
      rows: string[]
      slices: number
      maxSliceMs: number
    }>((resolve) => {
      startProjectExplorerSearchTree({
        matches,
        ancestors: new Set(),
        lookup: () => undefined,
        sliceMs: 2,
        complete: (model, metrics) => resolve({
          rows: flattenFileTreeV2(model, () => true).slice(0, 5).map((row) => row.node.path),
          slices: metrics.slices,
          maxSliceMs: metrics.maxSliceMs,
        }),
      })
    })
    expect(rows).toEqual([
      "src", "src/file-00001.ts", "src/file-00002.ts", "src/file-00003.ts", "src/file-00004.ts",
    ])
    expect(slices).toBeGreaterThan(4)
    console.info(`[explorer-cooperative-projector-50k] ${JSON.stringify({ slices, maxSliceMs })}`)
  })

  test("cancellation prevents obsolete 50k search projections from publishing", async () => {
    const matches = new Set(Array.from({ length: 50_000 }, (_, i) => `src/file-${i}.ts`))
    let published = false
    const stop = startProjectExplorerSearchTree({
      matches,
      ancestors: new Set(),
      lookup: () => undefined,
      sliceMs: 0.1,
      complete: () => { published = true },
    })
    stop()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(published).toBe(false)
  })
})
