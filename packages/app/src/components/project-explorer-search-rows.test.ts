import { describe, expect, test } from "bun:test"
import {
  buildFileTreeV2Model, createIncrementalSearchFileTreeRows, flattenFileTreeV2,
} from "./file-tree-v2-model"

describe("incremental search-tree rows", () => {
  test("local collapse and expansion preserve canonical preorder and row identities", () => {
    const model = buildFileTreeV2Model([
      "src/a.ts", "src/lib/child.ts", "src/lib/deep/leaf.ts",
      "src/lib/deep/other.ts", "docs/README.md", "docs/guide/intro.md",
    ])
    let collapsed = new Set<string>()
    const view = createIncrementalSearchFileTreeRows(model, collapsed)
    const original = view.rows()
    const check = () => expect(view.rows()).toEqual(flattenFileTreeV2(model, (path) => !collapsed.has(path)))
    check()
    collapsed = new Set(["src/lib"])
    view.update(collapsed)
    check()
    const hidden = view.rows()
    collapsed = new Set(["src/lib", "src/lib/deep"])
    expect(view.update(collapsed)).toBe(hidden)
    check()
    collapsed = new Set(["src/lib/deep"])
    view.update(collapsed)
    check()
    collapsed = new Set()
    view.update(collapsed)
    check()
    expect(view.rows()).toEqual(original)
    collapsed = new Set([...model.children.keys()].filter(Boolean))
    view.update(collapsed)
    check()
    collapsed = new Set()
    view.update(collapsed)
    check()
  })

  test("500 deterministic folder toggles are identical to the full reference", () => {
    const model = buildFileTreeV2Model(Array.from({ length: 4_000 }, (_, i) =>
      `src/d${i % 80}/nested/f${i}.ts`))
    let collapsed = new Set<string>()
    const view = createIncrementalSearchFileTreeRows(model, collapsed)
    const known = view.rows().find((row) => row.node.path === "src/d39/nested/f39.ts")
    let seed = 4137
    for (let step = 0; step < 500; step++) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      const dir = `src/d${seed % 80}`
      const next = new Set(collapsed)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      collapsed = next
      view.update(collapsed)
      expect(view.rows().map((row) => [row.node.path, row.level]))
        .toEqual(flattenFileTreeV2(model, (path) => !collapsed.has(path))
          .map((row) => [row.node.path, row.level]))
      if (!collapsed.has("src/d39")) {
        expect(view.rows().find((row) => row.node.path === "src/d39/nested/f39.ts")).toBe(known)
      }
    }
  })

  test("a single collapse does not re-read unaffected tree buckets", () => {
    const model = buildFileTreeV2Model(Array.from({ length: 50_000 }, (_, i) =>
      `src/group-${i % 100}/file-${i}.ts`))
    const collapsed = new Set<string>()
    const view = createIncrementalSearchFileTreeRows(model, collapsed)
    expect(view.rows()).toHaveLength(model.total)
    const previous = view.rows().find((row) => row.node.path === "src/group-99/file-99.ts")
    collapsed.add("src/group-15")
    const after = view.update(collapsed)
    expect(after).toHaveLength(model.total - 500)
    expect(after.find((row) => row.node.path === "src/group-99/file-99.ts")).toBe(previous)
    expect(after).toEqual(flattenFileTreeV2(model, (path) => !collapsed.has(path)))
    collapsed.delete("src/group-15")
    expect(view.update(collapsed)).toEqual(flattenFileTreeV2(model, () => true))
  })
})
