import { describe, expect, test } from "bun:test"
import {
  excludeModelSectionRows,
  indexSelectorRows,
  reconcileVirtualModelRows,
} from "./dialog-select-model-navigation"

describe("excludeModelSectionRows", () => {
  test("keeps untouched groups by identity and excludes only section members", () => {
    const groups = [
      { category: "one", items: [{ id: "1" }, { id: "2" }] },
      { category: "two", items: [{ id: "3" }, { id: "4" }] },
      { category: "three", items: [{ id: "5" }] },
    ]
    expect(excludeModelSectionRows(groups, new Set(), (item) => item.id)).toBe(groups)
    const projected = excludeModelSectionRows(groups, new Set(["1", "3", "4"]), (item) => item.id)
    expect(projected.map((group) => [group.category, group.items.map((item) => item.id)])).toEqual([
      ["one", ["2"]],
      ["three", ["5"]],
    ])
    expect(projected[0]).not.toBe(groups[0])
    expect(projected[1]).toBe(groups[2])
    expect(groups[0].items.map((item) => item.id)).toEqual(["1", "2"])
  })
})

describe("reconcileVirtualModelRows", () => {
  test("retains mounted Solid row identities across equivalent projections", () => {
    const model = { id: "model" }
    const initial = [
      { kind: "header" as const, key: "h", title: "Provider" },
      { kind: "item" as const, key: "m", navKey: "m", item: model },
      { kind: "separator" as const, key: "s" },
    ]
    const positions = [0, 1, 2].map((index) => ({ index, start: index * 25, size: 25 }))
    const first = reconcileVirtualModelRows(initial, positions, [])
    const same = reconcileVirtualModelRows(
      [
        { kind: "header" as const, key: "h", title: "Provider" },
        { kind: "item" as const, key: "m", navKey: "m", item: model },
        { kind: "separator" as const, key: "s" },
      ],
      positions.map((p) => ({ ...p })),
      first,
    )
    for (let i = 0; i < first.length; i++) expect(same[i]).toBe(first[i])
    const changed = reconcileVirtualModelRows(
      [
        { kind: "header" as const, key: "h", title: "Renamed Provider" },
        { kind: "item" as const, key: "m", navKey: "m", item: { id: "model" } },
        { kind: "separator" as const, key: "s" },
      ],
      positions,
      same,
    )
    expect(changed[0]).not.toBe(first[0])
    expect(changed[1]).not.toBe(first[1])
    expect(changed[2]).toBe(first[2])
    const shifted = reconcileVirtualModelRows(initial, positions.map((p) => ({ ...p, start: p.start + 5 })), first)
    for (let i = 0; i < first.length; i++) expect(shifted[i]).not.toBe(first[i])
  })
})

describe("indexSelectorRows", () => {
  test("preserves keyboard order, item identities and virtual positions", () => {
    const model = { id: "one" }
    const rows = [
      { kind: "header" as const },
      { kind: "item" as const, navKey: "recent:one", item: model },
      { kind: "separator" as const },
      { kind: "header" as const },
      { kind: "item" as const, navKey: "provider:one", item: model },
    ]
    const nav = indexSelectorRows(rows, "action:manage")
    expect(nav.keys).toEqual(["recent:one", "provider:one", "action:manage"])
    expect(nav.indexByKey.get("provider:one")).toBe(1)
    expect(nav.renderIndex.get("provider:one")).toBe(4)
    expect(nav.renderIndex.has("action:manage")).toBe(false)
    expect(nav.byKey.get("recent:one")?.item).toBe(model)
    expect(nav.byKey.get("action:manage")).toEqual({ navKey: "action:manage" })
  })

  test("empty and header-only lists still navigate to Manage", () => {
    for (const rows of [[], [{ kind: "header" as const }, { kind: "separator" as const }]]) {
      const nav = indexSelectorRows(rows, "action:manage")
      expect(nav.keys).toEqual(["action:manage"])
      expect(nav.indexByKey.get("action:manage")).toBe(0)
      expect(nav.renderIndex.size).toBe(0)
    }
  })

  test("large lists preserve exact indices without spread-argument limits", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({
      kind: "item" as const,
      navKey: `model:${i}`,
      item: i,
    }))
    const nav = indexSelectorRows(rows, "action:manage")
    expect(nav.keys.length).toBe(20_001)
    expect(nav.indexByKey.get("model:19999")).toBe(19_999)
    expect(nav.renderIndex.get("model:19999")).toBe(19_999)
    expect(nav.byKey.get("model:19999")?.item).toBe(19_999)
    expect(nav.indexByKey.get("action:manage")).toBe(20_000)
  })
})
