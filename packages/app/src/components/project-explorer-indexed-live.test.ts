import { describe, expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { flattenLiveFileTreeV2 } from "./file-tree-v2-model"
import { createIndexedLiveFileTreeV2 } from "./project-explorer-indexed-live"

const make = (path: string, type: "file" | "directory" = "file", mtime = 1): FileNode => ({
  path, name: path.split("/").at(-1)!, absolute: `/repo/${path}`, type, ignored: false, mtime,
})

describe("indexed filesystem live preorder", () => {
  test("local updates preserve reference flatten through collapsed metadata and directory type replacement", () => {
    const entries = new Map<string, FileNode>([
      ["src", make("src", "directory")],
      ["src/a.ts", make("src/a.ts")],
      ["src/deep", make("src/deep", "directory")],
      ["src/deep/file.ts", make("src/deep/file.ts")],
      ["other.md", make("other.md")],
    ])
    const childPaths = new Map([
      ["", ["src", "other.md"]],
      ["src", ["src/a.ts", "src/deep"]],
      ["src/deep", ["src/deep/file.ts"]],
    ])
    const opened = new Set(["src", "src/deep"])
    const children = (dir: string) => (childPaths.get(dir) ?? []).flatMap((path) => {
      const node = entries.get(path)
      return node ? [node] : []
    })
    const isOpen = (dir: string) => opened.has(dir)
    const view = createIndexedLiveFileTreeV2(children, isOpen, (path) => entries.get(path))
    const parity = () => {
      const expected = flattenLiveFileTreeV2(children, isOpen)
      expect(view.length).toBe(expected.length)
      expect(view.rows()).toEqual(expected)
      for (let i = 0; i < expected.length; i++) {
        expect(view.at(i)).toBe(expected[i])
        expect(view.indexOfPath(expected[i]!.node.path)).toBe(i)
        expect(view.rowForPath(expected[i]!.node.path)).toBe(expected[i])
      }
    }
    parity()
    const other = view.rowForPath("other.md")
    const originalKeysVersion = view.keysVersion
    entries.set("src/a.ts", make("src/a.ts", "file", 7))
    view.update("src")
    parity()
    expect(view.keysVersion).toBe(originalKeysVersion)
    childPaths.set("src", ["src/deep", "src/a.ts", "src/new.ts"])
    entries.set("src/new.ts", make("src/new.ts"))
    view.update("src")
    parity()
    expect(view.keysVersion).toBeGreaterThan(originalKeysVersion)
    expect(view.rowForPath("other.md")).toBe(other)

    opened.delete("src")
    view.update("src")
    parity()
    entries.set("src", make("src", "directory", 2))
    view.update("src")
    parity()
    entries.set("src", make("src", "file", 3))
    view.update("src")
    parity()
    entries.set("src", make("src", "directory", 4))
    opened.add("src")
    view.update("src")
    parity()
    childPaths.set("", ["other.md", "src"])
    view.update("")
    parity()
  })

  test("1,000 seeded watcher changes preserve exact path/depth/reference order", () => {
    let seed = 0x5eeda11
    const random = (max: number) => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      return (seed >>> 0) % max
    }
    const dirs = Array.from({ length: 40 }, (_, i) => make(`dir-${i}`, "directory"))
    const entries = new Map(dirs.map((node) => [node.path, node]))
    const listings = new Map<string, string[]>([["", dirs.map((node) => node.path)]])
    const opened = new Set(dirs.map((node) => node.path))
    for (const dir of dirs) {
      listings.set(dir.path, Array.from({ length: 25 }, (_, i) => {
        const path = `${dir.path}/f-${i}.ts`
        entries.set(path, make(path))
        return path
      }))
    }
    const children = (path: string) => (listings.get(path) ?? []).flatMap((name) => {
      const node = entries.get(name)
      return node ? [node] : []
    })
    const isOpen = (path: string) => opened.has(path)
    const view = createIndexedLiveFileTreeV2(children, isOpen, (path) => entries.get(path))
    for (let n = 0; n < 1_000; n++) {
      const dir = dirs[random(dirs.length)]!.path
      const action = random(6)
      if (action === 0) {
        if (opened.has(dir)) opened.delete(dir)
        else opened.add(dir)
        view.update(dir)
      } else if (action === 1) {
        listings.set(dir, [...listings.get(dir)!].reverse())
        view.update(dir)
      } else if (action === 2) {
        const path = `${dir}/dynamic-${random(8)}.ts`
        entries.set(path, make(path, "file", n + 10))
        const next = listings.get(dir)!.filter((item) => item !== path)
        next.splice(random(next.length + 1), 0, path)
        listings.set(dir, next)
        view.update(dir)
      } else if (action === 3) {
        const next = listings.get(dir)!.filter((item) => !item.includes("dynamic"))
        for (const item of listings.get(dir)!) if (item.includes("dynamic")) entries.delete(item)
        listings.set(dir, next)
        view.update(dir)
      } else if (action === 4) {
        entries.set(dir, make(dir, "directory", n + 1))
        view.update(dir)
      } else {
        listings.get("")!.reverse()
        view.update("")
      }
      const expected = flattenLiveFileTreeV2(children, isOpen)
      expect(view.rows().map((r) => [r.node.path, r.level, r.node.mtime]))
        .toEqual(expected.map((r) => [r.node.path, r.level, r.node.mtime]))
      if (expected.length) {
        const offset = random(expected.length)
        expect(view.at(offset)?.node.path).toBe(expected[offset]?.node.path)
        expect(view.indexOfPath(expected[offset]!.node.path)).toBe(offset)
      }
    }
  })

  test("large local update never materializes dense rows until explicitly requested", () => {
    const roots = Array.from({ length: 1_000 }, (_, i) => make(`d-${i}`, "directory"))
    const lists = new Map<string, FileNode[]>([["", roots]])
    const nodes = new Map<string, FileNode>(roots.map((r) => [r.path, r]))
    for (const dir of roots) {
      const nested = Array.from({ length: 49 }, (_, i) => make(`${dir.path}/f-${i}.ts`))
      lists.set(dir.path, nested)
      for (const row of nested) nodes.set(row.path, row)
    }
    let reads = 0
    const children = (path: string) => {
      reads++
      return lists.get(path) ?? []
    }
    const view = createIndexedLiveFileTreeV2(children, () => true, (path) => nodes.get(path))
    expect(view.length).toBe(50_000)
    reads = 0
    const old = view.rowForPath("d-500/f-3.ts")
    lists.set("d-500", [make("d-500/f-changed.ts")])
    view.update("d-500")
    expect(view.length).toBe(49_952)
    expect(reads).toBe(1)
    expect(view.rowForPath("d-500/f-3.ts")).toBeUndefined()
    expect(view.rowForPath("d-500/f-changed.ts")).toBeDefined()
    expect(view.indexOfPath("d-500/f-changed.ts")).toBeGreaterThan(0)
    expect(old).toBeDefined()
    expect(view.rows()).toEqual(flattenLiveFileTreeV2(children, () => true))
  })
})
