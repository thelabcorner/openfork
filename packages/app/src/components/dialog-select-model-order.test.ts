import { describe, expect, test } from "bun:test"
import { applySectionOrder, dragPreviewOffset } from "./dialog-select-model-order"

const keys = ["anthropic:a", "anthropic:b", "anthropic:c"]

describe("applySectionOrder", () => {
  test("returns items unchanged without a stored order", () => {
    expect(applySectionOrder(keys, undefined, (x) => x)).toBe(keys)
    expect(applySectionOrder(keys, [], (x) => x)).toBe(keys)
  })

  test("reorders pinned models and appends unknown ones", () => {
    expect(applySectionOrder(keys, ["anthropic:c", "anthropic:a"], (x) => x)).toEqual([
      "anthropic:c",
      "anthropic:a",
      "anthropic:b",
    ])
  })

  test("appends models missing from a stale snapshot in cost order", () => {
    expect(applySectionOrder([...keys, "anthropic:new"], ["anthropic:c", "anthropic:a"], (x) => x)).toEqual([
      "anthropic:c",
      "anthropic:a",
      "anthropic:b",
      "anthropic:new",
    ])
  })

  test("ignores snapshots that pin fewer than two visible models", () => {
    const single = keys.slice(0, 1)
    expect(applySectionOrder(single, ["anthropic:a"], (x) => x)).toBe(single)
  })

  test("ignores snapshots whose keys no longer resolve", () => {
    const stale = ["gone:1", "gone:2"]
    expect(applySectionOrder(keys, stale, (x) => x)).toBe(keys)
  })
})

describe("dragPreviewOffset", () => {
  const h = 28

  test("no offset without movement", () => {
    expect(dragPreviewOffset(2, 2, 0, h)).toBe(0)
    expect(dragPreviewOffset(2, 2, 2, h)).toBe(0)
  })

  test("dragging down shifts intervening rows up", () => {
    expect(dragPreviewOffset(0, 2, 1, h)).toBe(-h)
    expect(dragPreviewOffset(0, 2, 2, h)).toBe(-h)
    expect(dragPreviewOffset(0, 2, 3, h)).toBe(0)
  })

  test("dragging up shifts intervening rows down", () => {
    expect(dragPreviewOffset(3, 1, 1, h)).toBe(h)
    expect(dragPreviewOffset(3, 1, 2, h)).toBe(h)
    expect(dragPreviewOffset(3, 1, 0, h)).toBe(0)
  })

  test("never offsets the dragged row itself", () => {
    expect(dragPreviewOffset(0, 3, 0, 28)).toBe(0)
    expect(dragPreviewOffset(3, 0, 3, 28)).toBe(0)
  })
})
