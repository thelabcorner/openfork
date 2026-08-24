import { expect, test } from "bun:test"
import type { VirtualItem } from "@tanstack/solid-virtual"
import { collectVirtualItems } from "./virtual-items"

const item = (index: number, key: string): VirtualItem => ({
  index,
  key,
  start: index * 10,
  size: 10,
  end: index * 10 + 10,
  lane: 0,
})

test("collects items and keys for known row keys", () => {
  const { byKey, keys } = collectVirtualItems([item(0, "a"), item(1, "b")], (key) =>
    ["a", "b"].includes(key),
  )

  expect(keys).toEqual(["a", "b"])
  expect(byKey.get("a")?.index).toBe(0)
  expect(byKey.get("b")?.index).toBe(1)
})

test("skips orphan keys so they can never mount a crashing row", () => {
  const known = new Map([
    ["user-message:1", {}],
    ["assistant-part:1:g", {}],
  ])
  const { byKey, keys } = collectVirtualItems(
    [item(0, "user-message:1"), item(1, "removed:1"), item(2, "assistant-part:1:g")],
    (key) => known.has(key),
  )

  expect(keys).toEqual(["user-message:1", "assistant-part:1:g"])
  expect(byKey.has("removed:1")).toBe(false)
  expect(byKey.size).toBe(2)
})
