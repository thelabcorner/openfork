import { describe, expect, test } from "bun:test"
import { buildFileTreeV2Model, flattenFileTreeV2 } from "./file-tree-v2-model"
import { createIndexedSearchFileTreeRows } from "./project-explorer-indexed-search"

describe("weighted indexed search rows", () => {
  test("single-toggle, hidden-toggle and Collapse All parity", () => {
    const model = buildFileTreeV2Model([
      "src/a.ts", "src/lib/child.ts", "src/lib/deep/a.ts",
      "src/lib/deep/b.ts", "docs/README.md", "docs/guide/intro.md",
    ])
    const view = createIndexedSearchFileTreeRows(model, new Set())
    let collapsed = new Set<string>()
    const initial = view.rows()
    const check = () => {
      const reference = flattenFileTreeV2(model, (path) => !collapsed.has(path))
      expect(view.length).toBe(reference.length)
      expect(view.rows()).toEqual(reference)
      reference.forEach((row, index) => {
        expect(view.at(index)).toBe(row)
        expect(view.indexOfPath(row.node.path)).toBe(index)
        expect(view.rowForPath(row.node.path)).toBe(row)
      })
    }
    check()
    collapsed.add("src/lib")
    view.update(collapsed)
    check()
    const hidden = view.rows()
    const generation = view.keysVersion
    collapsed.add("src/lib/deep")
    view.update(collapsed)
    expect(view.rows()).toBe(hidden)
    expect(view.keysVersion).toBe(generation)
    check()
    collapsed.delete("src/lib")
    view.update(collapsed)
    check()
    collapsed.clear()
    view.update(collapsed)
    check()
    expect(view.rows()).toEqual(initial)
    collapsed = new Set([...model.children.keys()].filter(Boolean))
    view.update(collapsed)
    check()
    collapsed.clear()
    view.update(collapsed)
    check()
  })

  test("500 deterministic search-folder changes match the full reference", () => {
    const model = buildFileTreeV2Model(Array.from({ length: 4_000 }, (_, i) =>
      `src/d${i % 80}/nested/f${i}.ts`))
    const view = createIndexedSearchFileTreeRows(model, new Set())
    let collapsed = new Set<string>()
    let seed = 4137
    for (let n = 0; n < 500; n++) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      const directory = `src/d${seed % 80}`
      collapsed = new Set(collapsed)
      if (collapsed.has(directory)) collapsed.delete(directory)
      else collapsed.add(directory)
      view.update(collapsed)
      const expected = flattenFileTreeV2(model, (path) => !collapsed.has(path))
      expect(view.length).toBe(expected.length)
      expect(view.rows().map((row) => [row.node.path, row.level]))
        .toEqual(expected.map((row) => [row.node.path, row.level]))
      if (expected.length) {
        const offset = seed % expected.length
        expect(view.at(offset)?.node.path).toBe(expected[offset]?.node.path)
      }
    }
  })

  test("50k search projection avoids complete-array copy for a localized folder toggle", () => {
    const model = buildFileTreeV2Model(Array.from({ length: 50_000 }, (_, i) =>
      `src/group-${i % 100}/file-${i}.ts`))
    const view = createIndexedSearchFileTreeRows(model, new Set())
    const original = view.rowForPath("src/group-99/file-99.ts")
    expect(view.length).toBe(model.total)
    const count = view.chunkCount
    const collapsed = new Set(["src/group-15"])
    view.update(collapsed)
    expect(view.length).toBe(model.total - 500)
    expect(view.indexOfPath("src/group-15/file-15.ts")).toBe(-1)
    expect(view.rowForPath("src/group-99/file-99.ts")).toBe(original)
    expect(view.chunkCount).toBeLessThan(count + 10)
    expect(view.rows()).toEqual(flattenFileTreeV2(model, (path) => !collapsed.has(path)))
    view.update(new Set())
    expect(view.length).toBe(model.total)
    expect(view.rows()).toEqual(flattenFileTreeV2(model, () => true))
  })
})
