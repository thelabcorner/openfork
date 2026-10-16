import { expect, test } from "bun:test"
import { Virtualizer, type VirtualItem } from "@tanstack/solid-virtual"
import { collectVirtualItems, coversVirtualViewport, mergeVirtualIndexes, recoverVirtualWindow, shouldCompensateReadingResize } from "./virtual-items"

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

test("reconciles stale virtualizer keys by current index without blanking the viewport", () => {
  const stale = [item(0, "old-a"), item(1, "old-b"), undefined, item(2, "removed:2")]
  const current = ["new-a", "new-b", "new-c"]
  const result = collectVirtualItems(stale, (key) => current.includes(key), (index) => current[index])
  expect(result.keys).toEqual(current)
  expect(result.byKey.get("new-a")).toMatchObject({ index: 0, key: "new-a" })
  expect(result.byKey.get("new-c")).toMatchObject({ index: 2, key: "new-c" })
  expect(collectVirtualItems([item(50, "stale")], () => true, (index) => current[index]).keys).toEqual([])
})

test("recovers only the visible slice when a reconnect temporarily returns no virtual items", () => {
  const measurements = Array.from({ length: 20_000 }, (_, index) => item(index, `row:${index}`))
  const middle = recoverVirtualWindow(measurements, 100_000, 400)
  expect(middle.length).toBeLessThanOrEqual(60)
  expect(middle.map((x) => x.index)).toContain(10_000)
  expect(middle.map((x) => x.index)).toContain(10_039)
  const beyondEnd = recoverVirtualWindow(measurements, 1e9, 400)
  expect(beyondEnd.at(-1)?.index).toBe(19_999)
  expect(recoverVirtualWindow([], 0, 400)).toEqual([])
  expect(recoverVirtualWindow(measurements, Number.NaN, 400)).toEqual([])
})

test("an offscreen active row does not count as visible viewport coverage", () => {
  const pinned = item(950, "active")
  const viewport = [item(50, "a"), item(51, "b"), item(52, "c")]
  expect(coversVirtualViewport([pinned], 500, 530)).toBe(false)
  expect(coversVirtualViewport([...viewport, pinned], 500, 530)).toBe(true)
  expect(coversVirtualViewport([item(50, "a"), item(52, "c"), pinned], 500, 530)).toBe(false)
  expect(coversVirtualViewport(viewport.slice(0, 2), 500, 530)).toBe(false)
  expect(coversVirtualViewport(viewport, 500, 530)).toBe(true)
  expect(coversVirtualViewport(viewport, Number.NaN, 530)).toBe(false)
  expect(coversVirtualViewport(viewport, 530, 500)).toBe(false)
})

test("resize compensation uses row geometry instead of potentially stale range indexes", () => {
  const measurements = Array.from({ length: 20 }, (_, index) => item(index, `row:${index}`))
  expect(shouldCompensateReadingResize(measurements[4]!, measurements[5], 55, 100)).toBe(true)
  expect(shouldCompensateReadingResize(measurements[5]!, measurements[6], 55, 100)).toBe(true)
  expect(shouldCompensateReadingResize(measurements[5]!, measurements[6], 50, 100)).toBe(false)
  expect(shouldCompensateReadingResize(measurements[5]!, measurements[6], 55, 59)).toBe(false)
  expect(shouldCompensateReadingResize(measurements[19]!, undefined, 195, 210)).toBe(false)
  expect(shouldCompensateReadingResize(measurements[5]!, measurements[6], Number.NaN, 100)).toBe(false)
})

test("TanStack applies a single above-anchor correction while scrolling backward", () => {
  const requested: number[] = []
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 20,
    estimateSize: () => 10,
    getItemKey: (index) => `row:${index}`,
    initialOffset: 55,
    initialRect: { width: 500, height: 50 },
    getScrollElement: () => null,
    observeElementRect: () => {},
    observeElementOffset: () => {},
    scrollToFn: (_offset, options) => requested.push(options.adjustments ?? 0),
    anchorTo: "end",
    scrollEndThreshold: 0,
  })
  virtualizer.getVirtualItems()
  virtualizer.scrollDirection = "backward"
  // This fork uses virtual-core 3.17.x, where the escape hatch is an
  // instance callback rather than an options field.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (row) =>
    shouldCompensateReadingResize(row, virtualizer.measurementsCache[row.index + 1], 55, 105)
  virtualizer.resizeItem(5, 40)
  // Core consumes scrollAdjustments immediately into its tracked offset.
  expect(virtualizer.scrollOffset).toBe(85)
  expect(requested).toContain(30)
  // Negative corrections must restore the exact original reading coordinate.
  virtualizer.resizeItem(5, 10)
  expect(virtualizer.scrollOffset).toBe(55)
  expect(requested).toContain(-30)
})

test("three-way range merge matches bounded sort/dedup for 2,000 varied windows", () => {
  let seed = 0x137bdf
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
  }
  for (let trial = 0; trial < 2000; trial++) {
    const count = random() % 1600
    const start = random() % (count + 1)
    const end = Math.min(count, start + (random() % 75))
    const visible = Array.from({ length: end - start }, (_, i) => start + i)
    const pinned = Array.from({ length: random() % 45 }, () => random() % (count + 15) - 7)
      .sort((a, b) => a - b)
    const active = random() % (count + 15) - 7
    const expected = [...new Set([...visible, ...pinned, active].filter((index) => index >= 0 && index < count))]
      .sort((a, b) => a - b)
    expect(mergeVirtualIndexes(visible, pinned, active, count)).toEqual(expected)
  }
})
