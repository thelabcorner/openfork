import { describe, expect, test } from "bun:test"
import { buildFileTreeV2Model, createIncrementalLiveFileTreeV2, flattenFileTreeV2, flattenLiveFileTreeV2 } from "./file-tree-v2-model"
import type { FileNode } from "@opencode-ai/sdk/v2"

describe("buildFileTreeV2Model", () => {
  test("builds a sorted tree and flattens expanded directories", () => {
    const model = buildFileTreeV2Model(["src/z.ts", "src/lib/b.ts", "src/lib/a.ts", "README.md", "docs/guide.md"])

    expect(model.total).toBe(8)
    expect(flattenFileTreeV2(model, () => true).map((row) => [row.node.path, row.node.type, row.level])).toEqual([
      ["docs", "directory", 0],
      ["docs/guide.md", "file", 1],
      ["src", "directory", 0],
      ["src/lib", "directory", 1],
      ["src/lib/a.ts", "file", 2],
      ["src/lib/b.ts", "file", 2],
      ["src/z.ts", "file", 1],
      ["README.md", "file", 0],
    ])
  })

  test("skips children of collapsed directories", () => {
    const model = buildFileTreeV2Model(["src/lib/a.ts", "src/z.ts"])

    expect(flattenFileTreeV2(model, (path) => path !== "src/lib").map((row) => row.node.path)).toEqual([
      "src",
      "src/lib",
      "src/z.ts",
    ])
  })

  test("normalizes duplicate and messy paths", () => {
    const model = buildFileTreeV2Model(["src\\lib\\a.ts", "src/lib/a.ts", "/src//lib/b.ts/"])
    const rows = flattenFileTreeV2(model, () => true)

    expect(rows.map((row) => row.node.path)).toEqual(["src", "src/lib", "src/lib/a.ts", "src/lib/b.ts"])
    expect(rows.find((row) => row.node.path === "src/lib/a.ts")?.node.originalPath).toBe("src\\lib\\a.ts")
  })

  test("handles deeply nested paths", () => {
    const file = Array.from({ length: 130 }, (_, index) => `d${index}`).join("/") + "/leaf.ts"
    const model = buildFileTreeV2Model([file])

    expect(flattenFileTreeV2(model, () => true)).toHaveLength(131)
  })

  test("reuses immutable search rows across collapse and expand without retaining outdated depths", () => {
    const model = buildFileTreeV2Model(["src/lib/a.ts", "src/lib/b.ts"])
    const before = flattenFileTreeV2(model, () => true)
    expect(flattenFileTreeV2(model, (path) => path !== "src/lib")[1]).toBe(before[1])
    const restored = flattenFileTreeV2(model, () => true)
    for (let i = 0; i < before.length; i++) expect(restored[i]).toBe(before[i])
  })
})

describe("flattenLiveFileTreeV2", () => {
  test("incremental refresh is identical to full flatten for reorder, expand, collapse, metadata and root updates", () => {
    const make = (path: string, type: "directory" | "file" = "file", mtime = 0): FileNode => ({
      name: path.split("/").at(-1)!, path, absolute: `/repo/${path}`, type, ignored: false, mtime,
    })
    const data = new Map<string, FileNode[]>([
      ["", [make("src", "directory"), make("docs", "directory")]],
      ["src", [make("src/a.ts"), make("src/lib", "directory"), make("src/b.ts")]],
      ["src/lib", [make("src/lib/z.ts")]],
      ["docs", [make("docs/a.md")]],
    ])
    const open = new Set(["src", "src/lib", "docs"])
    const children = (dir: string) => data.get(dir) ?? []
    const expanded = (dir: string) => open.has(dir)
    const view = createIncrementalLiveFileTreeV2(children, expanded)
    const assertSame = () =>
      expect(view.rows().map(({ node, level }) => [node.path, level, node.mtime]))
        .toEqual(flattenLiveFileTreeV2(children, expanded).map(({ node, level }) => [node.path, level, node.mtime]))
    assertSame()
    data.set("src", [make("src/new.ts", "file", 5), make("src/lib", "directory"), make("src/b.ts")])
    view.update("src")
    assertSame()
    open.delete("src")
    view.update("src")
    assertSame()
    data.set("src/lib", [make("src/lib/changed.ts")])
    expect(view.update("src/lib")).toBe(view.rows()) // hidden subtree is deferred
    open.add("src")
    view.update("src")
    assertSame()
    data.set("", [make("docs", "directory"), make("src", "directory")])
    view.update("")
    assertSame()
  })

  test("incremental subtree refresh does not traverse unrelated expanded directories", () => {
    const make = (path: string, type: "directory" | "file"): FileNode => ({
      name: path.split("/").at(-1)!, path, absolute: `/repo/${path}`, type, ignored: false,
    })
    const directories = Array.from({ length: 500 }, (_, i) => make(`d${i}`, "directory"))
    const data = new Map<string, FileNode[]>([["", directories]])
    const opened = new Set(directories.map((dir) => dir.path))
    for (const directory of directories) {
      data.set(directory.path, Array.from({ length: 30 }, (_, i) => make(`${directory.path}/file${i}`, "file")))
    }
    let reads = 0
    const children = (dir: string) => { reads++; return data.get(dir) ?? [] }
    const view = createIncrementalLiveFileTreeV2(children, (dir) => opened.has(dir))
    expect(view.rows()).toHaveLength(15_500)
    reads = 0
    data.set("d231", [make("d231/new.ts", "file")])
    view.update("d231")
    expect(reads).toBe(1)
    expect(view.rows()).toHaveLength(15_471)
    expect(view.rows().find((r) => r.node.path === "d231/new.ts")).toBeDefined()
    expect(view.rows()).toEqual(flattenLiveFileTreeV2(children, (dir) => opened.has(dir)))
  })

  test("refreshes directory metadata without loading siblings, including collapsed directories and type changes", () => {
    const make = (path: string, type: "file" | "directory", mtime = 1): FileNode => ({
      name: path.split("/").at(-1)!, path, absolute: `/repo/${path}`, type, ignored: false, mtime,
    })
    const entries = new Map<string, FileNode>([
      ["src", make("src", "directory")],
      ["src/a.ts", make("src/a.ts", "file")],
    ])
    const listings = (dir: string) =>
      dir === "" ? [entries.get("src")!] : dir === "src" ? [entries.get("src/a.ts")!] : []
    const opened = new Set<string>()
    let listingReads = 0
    const children = (dir: string) => { listingReads++; return listings(dir) }
    const view = createIncrementalLiveFileTreeV2(children, (dir) => opened.has(dir), (path) => entries.get(path))
    const first = view.rows()[0]
    entries.set("src", make("src", "directory", 2))
    listingReads = 0
    view.update("src")
    expect(view.rows()[0]?.node.mtime).toBe(2)
    expect(view.rows()[0]).not.toBe(first)
    expect(listingReads).toBe(0)
    expect(view.rows()).toEqual(flattenLiveFileTreeV2(children, (dir) => opened.has(dir)))
    opened.add("src")
    view.update("src")
    expect(view.rows()).toHaveLength(2)
    entries.set("src", make("src", "file", 3))
    view.update("src")
    expect(view.rows().map((row) => [row.node.path, row.node.type, row.node.mtime]))
      .toEqual([["src", "file", 3]])
    expect(view.rows()).toEqual(flattenLiveFileTreeV2(children, (dir) => opened.has(dir)))
  })

  test("seeded differential: 1,000 watcher/root/collapse/metadata mutations preserve full preorder", () => {
    let seed = 0x5eeda11
    const rand = (max: number) => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      return (seed >>> 0) % max
    }
    const make = (path: string, type: "file" | "directory" = "file", mtime = 1): FileNode => ({
      name: path.split("/").at(-1)!, path, absolute: `/repo/${path}`, type, ignored: false, mtime,
    })
    const folders = Array.from({ length: 16 }, (_, index) => make(`d${index}`, "directory"))
    const nodes = new Map<string, FileNode>(folders.map((folder) => [folder.path, folder]))
    const listings = new Map<string, string[]>([["", folders.map((folder) => folder.path)]])
    const expanded = new Set<string>()
    for (const dir of folders) {
      expanded.add(dir.path)
      listings.set(dir.path, Array.from({ length: 12 }, (_, index) => {
        const path = `${dir.path}/f${index}.ts`
        nodes.set(path, make(path))
        return path
      }))
    }
    const children = (dir: string) => (listings.get(dir) ?? []).flatMap((path) => {
      const node = nodes.get(path)
      return node ? [node] : []
    })
    const opened = (path: string) => expanded.has(path)
    const view = createIncrementalLiveFileTreeV2(children, opened, (path) => nodes.get(path))
    const capture = (rows: ReturnType<typeof flattenLiveFileTreeV2>) =>
      rows.map((row) => [row.node.path, row.node.type, row.node.mtime, row.level])
    for (let step = 0; step < 1_000; step++) {
      const dir = folders[rand(folders.length)]!.path
      const action = rand(7)
      if (action === 0) {
        listings.get("")!.reverse()
        view.update("")
      } else if (action === 1) {
        if (expanded.has(dir)) expanded.delete(dir)
        else expanded.add(dir)
        view.update(dir)
      } else if (action === 2) {
        const next = [...(listings.get(dir) ?? [])]
        next.reverse()
        listings.set(dir, next)
        view.update(dir)
      } else if (action === 3) {
        const path = `${dir}/dynamic${rand(9)}.ts`
        nodes.set(path, make(path, "file", step + 10))
        const next = (listings.get(dir) ?? []).filter((p) => p !== path)
        next.splice(rand(next.length + 1), 0, path)
        listings.set(dir, next)
        view.update(dir)
      } else if (action === 4) {
        const next = [...(listings.get(dir) ?? [])]
        const index = next.findIndex((p) => p.includes("dynamic"))
        if (index >= 0) {
          nodes.delete(next[index]!)
          next.splice(index, 1)
          listings.set(dir, next)
        }
        view.update(dir)
      } else if (action === 5) {
        nodes.set(dir, make(dir, "directory", step + 2))
        view.update("")
      } else {
        const next = [...listings.get("")!]
        if (next.includes(dir)) next.splice(next.indexOf(dir), 1)
        else next.splice(rand(next.length + 1), 0, dir)
        listings.set("", next)
        view.update("")
      }
      expect(capture(view.rows())).toEqual(capture(flattenLiveFileTreeV2(children, opened)))
    }
  })

  test("root-only listing reuses expanded subtree spans without re-reading thousands of descendants", () => {
    const make = (path: string, type: "directory" | "file" = "file", mtime = 1): FileNode => ({
      path, name: path.split("/").at(-1)!, absolute: `/repo/${path}`, type, ignored: false, mtime,
    })
    const dirs = Array.from({ length: 250 }, (_, i) => make(`dir-${i}`, "directory"))
    const data = new Map<string, FileNode[]>([["", dirs]])
    for (const dir of dirs) data.set(dir.path, Array.from({ length: 40 }, (_, i) => make(`${dir.path}/f-${i}`)))
    let reads = 0
    const children = (path: string) => { reads++; return data.get(path) ?? [] }
    const view = createIncrementalLiveFileTreeV2(children, () => true)
    const knownLeaf = view.rows().find((row) => row.node.path === "dir-120/f-29")
    expect(view.rows().length).toBe(10_250)
    data.set("", [...dirs.toReversed(), make("root.ts", "file", 2)])
    reads = 0
    view.update("")
    expect(reads).toBe(1)
    expect(view.rows().find((row) => row.node.path === "dir-120/f-29")).toBe(knownLeaf)
    expect(view.rows()).toEqual(flattenLiveFileTreeV2(children, () => true))
  })

  test("malformed duplicate branches fall back to authoritative preorder after a removal", () => {
    const make = (path: string, type: "directory" | "file"): FileNode => ({
      name: path.split("/").at(-1)!, path, absolute: `/repo/${path}`, type, ignored: false,
    })
    const shared = make("same.ts", "file")
    const entries = new Map([
      ["", [make("a", "directory"), make("b", "directory")]],
      ["a", [shared]],
      ["b", [shared]],
    ])
    const children = (dir: string) => entries.get(dir) ?? []
    const view = createIncrementalLiveFileTreeV2(children, () => true)
    expect(view.rows().map((row) => row.node.path)).toEqual(["a", "same.ts", "b"])
    entries.set("a", [])
    view.update("a")
    expect(view.rows().map((row) => row.node.path))
      .toEqual(flattenLiveFileTreeV2(children, () => true).map((row) => row.node.path))
  })

  test("flattens live children using original paths for nested lookups", () => {
    const nodes: Record<string, FileNode[]> = {
      "": [
        { name: "src", path: "src", absolute: "/repo/src", type: "directory", ignored: false },
        { name: "README.md", path: "README.md", absolute: "/repo/README.md", type: "file", ignored: false },
      ],
      src: [
        { name: "a.ts", path: "src/a.ts", absolute: "/repo/src/a.ts", type: "file", ignored: false },
        { name: "lib", path: "src/lib", absolute: "/repo/src/lib", type: "directory", ignored: false },
      ],
      "src/lib": [{ name: "b.ts", path: "src/lib/b.ts", absolute: "/repo/src/lib/b.ts", type: "file", ignored: false }],
    }

    expect(
      flattenLiveFileTreeV2(
        (path) => nodes[path] ?? [],
        (path) => path === "src",
      ).map((row) => [row.node.path, row.node.originalPath, row.level]),
    ).toEqual([
      ["src", "src", 0],
      ["src/a.ts", "src/a.ts", 1],
      ["src/lib", "src/lib", 1],
      ["README.md", "README.md", 0],
    ])
  })

  test("deduplicates cross-listing paths and terminates malformed cycles", () => {
    const directory: FileNode = {
      name: "src", path: "src", absolute: "/repo/src", type: "directory", ignored: false,
    }
    const leaf: FileNode = {
      name: "index.ts", path: "src/index.ts", absolute: "/repo/src/index.ts", type: "file", ignored: false,
    }
    const rows = flattenLiveFileTreeV2(
      (path) => path === "" ? [directory, leaf] : path === "src" ? [directory, leaf, leaf] : [],
      () => true,
    )
    expect(rows.map((row) => [row.node.path, row.level])).toEqual([
      ["src", 0],
      ["src/index.ts", 1],
    ])
  })

  test("reuses unchanged live rows and replaces wrappers when tree depth changes", () => {
    const leaf: FileNode = {
      name: "file.ts", path: "src/file.ts", absolute: "/repo/src/file.ts", type: "file", ignored: false,
    }
    const dir: FileNode = {
      name: "src", path: "src", absolute: "/repo/src", type: "directory", ignored: false,
    }
    const nodes = (path: string) => path === "" ? [dir] : path === "src" ? [leaf] : []
    const rows = flattenLiveFileTreeV2(nodes, () => true)
    const again = flattenLiveFileTreeV2(nodes, () => true)
    expect(again[0]).toBe(rows[0])
    expect(again[1]).toBe(rows[1])
    const wrongParent = flattenLiveFileTreeV2((path) => path === "" ? [leaf] : [], () => false)
    expect(wrongParent[0]?.level).toBe(0)
    expect(wrongParent[0]).not.toBe(rows[1])
    expect(rows[1]?.level).toBe(1)
  })
})
