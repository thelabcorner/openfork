import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { VirtualItem } from "@tanstack/solid-virtual"
import { createSafeVirtualizer, sanitizeVirtualItems } from "../src/components/safe-solid-virtualizer"

const item = (index: number): VirtualItem => ({
  index, key: `row-${index}`, start: index * 40, size: 40, end: (index + 1) * 40, lane: 0,
})

test("safe item admission avoids an allocation for valid ordered ranges", () => {
  const items = [item(1), item(2), item(3)]
  expect(sanitizeVirtualItems(items, 5)).toBe(items)
})

test("sparse, duplicate, out-of-range, and reordered items are sanitized before reconciliation", () => {
  const mixed = [item(3), undefined, item(0), item(3), item(-1), item(9), item(1)]
  const clean = sanitizeVirtualItems(mixed, 4)
  expect(clean.map((row) => row.index)).toEqual([0, 1, 3])
  expect(clean.every((row) => !!row && row.index >= 0)).toBe(true)
})

test("safe Solid virtualizer survives invalid range indexes and reactive count churn", () => {
  createRoot((dispose) => {
    try {
      const [count, setCount] = createSignal(4)
      const virtualizer = createSafeVirtualizer<HTMLDivElement, HTMLDivElement>({
        get count() { return count() },
        estimateSize: () => 40,
        initialRect: { width: 500, height: 200 },
        getScrollElement: () => null,
        rangeExtractor: (range) => [-1, 0, 1, range.count + 5, 1, 2, 3],
      })
      expect(virtualizer.getVirtualItems().map((row) => row.index)).toEqual([0, 1, 2, 3])
      expect(virtualizer.getTotalSize()).toBe(160)
      setCount(1)
      expect(virtualizer.getVirtualItems().map((row) => row.index)).toEqual([0])
      expect(virtualizer.getTotalSize()).toBe(40)
      setCount(0)
      expect(virtualizer.getVirtualItems()).toEqual([])
      setCount(3)
      expect(virtualizer.getVirtualItems().map((row) => row.index)).toEqual([0, 1, 2])
    } finally {
      dispose()
    }
  })
})
