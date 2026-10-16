import { describe, expect, test } from "bun:test"
import { adjacentTabKey, mergeVisibleTabOrder, projectTabOrder } from "./titlebar-tab-order"

describe("adjacentTabKey", () => {
  test("follows the visible left-to-right order", () => {
    expect(adjacentTabKey(["c", "a", "b"], "c", 1)).toBe("a")
    expect(adjacentTabKey(["c", "a", "b"], "a", -1)).toBe("c")
  })

  test("skips tabs omitted from the visible order", () => {
    expect(adjacentTabKey(["a", "c"], "a", 1)).toBe("c")
    expect(adjacentTabKey(["a", "c"], "c", 1)).toBe("a")
  })
})

test("merges reordered visible tabs around hidden tabs", () => {
  expect(mergeVisibleTabOrder(["a", "hidden", "b", "c"], ["a", "b", "c"], ["c", "a", "b"])).toEqual([
    "c",
    "hidden",
    "a",
    "b",
  ])
})

test("projects sortable/shortcut indices and drag order in one pass", () => {
  const tabs = [
    { id: "s1", visible: true },
    { id: "hidden", visible: false },
    { id: "s2", visible: true },
    { id: "app", visible: true },
  ]
  const keys: string[] = []
  const projection = projectTabOrder(tabs, (tab) => {
    keys.push(tab.id)
    return tab.id
  }, (tab) => tab.visible)
  expect(keys).toEqual(["s1", "hidden", "s2", "app"])
  expect(projection.visible).toEqual([tabs[0], tabs[2], tabs[3]])
  expect(projection.ids).toEqual(["s1", "s2", "app"])
  expect(projection.allKeys).toEqual(["s1", "hidden", "s2", "app"])
  expect([...projection.index.entries()]).toEqual([["s1", 0], ["s2", 1], ["app", 2]])
  expect(projection.byKey.get("hidden")).toBe(tabs[1])
})

test("preserves first-match navigation and last-match sortable index for duplicate keys", () => {
  const tabs = [{ id: "duplicate" }, { id: "other" }, { id: "duplicate" }]
  const projection = projectTabOrder(tabs, (tab) => tab.id, () => true)
  expect(projection.byKey.get("duplicate")).toBe(tabs[0])
  expect(projection.index.get("duplicate")).toBe(2)
  expect(projection.ids).toEqual(["duplicate", "other", "duplicate"])
})

test("is equivalent to the original visible-tab filters and ordering for arbitrary tab counts", () => {
  for (let size = 0; size <= 96; size++) {
    const tabs = Array.from({ length: size }, (_, i) => ({ id: `tab-${i % 37}`, visible: i % 5 !== 0 }))
    const projected = projectTabOrder(tabs, (tab) => tab.id, (tab) => tab.visible)
    const visible = tabs.filter((tab) => tab.visible)
    expect(projected.visible).toEqual(visible)
    expect(projected.ids).toEqual(visible.map((tab) => tab.id))
    expect(projected.allKeys).toEqual(tabs.map((tab) => tab.id))
    for (const tab of tabs) expect(projected.byKey.get(tab.id)).toBe(tabs.find((item) => item.id === tab.id))
    for (const [i, tab] of visible.entries()) {
      expect(projected.index.get(tab.id)).toBe(visible.map((item) => item.id).lastIndexOf(tab.id))
    }
  }
})
