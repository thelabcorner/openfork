import { expect, test } from "bun:test"
import { createVirtualizer, defaultRangeExtractor, Virtualizer } from "@tanstack/solid-virtual"
import { createEffect, createRoot, createSignal } from "solid-js"
import { measureRowElement } from "@/components/virtual-scroll-element"
import { filterVirtualIndexes } from "@/pages/session/timeline/virtual-items"

test("end anchoring survives consecutive resizes when the first scroll write is clamped", () => {
  const writes: { offset: number; adjustments?: number }[] = []
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 5,
    estimateSize: () => 50,
    initialOffset: 50,
    initialRect: { width: 400, height: 200 },
    anchorTo: "end",
    scrollEndThreshold: 1,
    getScrollElement: () => null,
    scrollToFn: (offset, options) => writes.push({ offset, adjustments: options.adjustments }),
    observeElementRect: () => {},
    observeElementOffset: () => {},
  })

  virtualizer.getTotalSize()
  virtualizer.resizeItem(4, 120)
  expect(writes).toEqual([{ offset: 50, adjustments: 70 }])
  writes.length = 0

  virtualizer.resizeItem(4, 200)
  expect(writes).toEqual([{ offset: 120, adjustments: 80 }])
})

test("reactive count updates preserve measured row sizes", () => {
  createRoot((dispose) => {
    const [count, setCount] = createSignal(2)
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      get count() {
        return count()
      },
      getScrollElement: () => null,
      estimateSize: () => 60,
      initialRect: { width: 800, height: 600 },
    })

    expect(virtualizer.getTotalSize()).toBe(120)
    virtualizer.resizeItem(0, 100)
    expect(virtualizer.getTotalSize()).toBe(160)

    setCount(3)

    expect(virtualizer.itemSizeCache.get(0)).toBe(100)
    expect(virtualizer.getTotalSize()).toBe(220)
    dispose()
  })
})

test("initial rect projects rows before a scroll element connects", () => {
  createRoot((dispose) => {
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: 100,
      getScrollElement: () => null,
      estimateSize: () => 28,
      initialRect: { width: 0, height: 600 },
      overscan: 10,
    })

    expect(virtualizer.getVirtualItems().length).toBeGreaterThan(0)
    dispose()
  })
})

test("clamps oversized offsets with scroll margin and padding changes", () => {
  const options = (paddingEnd: number) => ({
    count: 20,
    estimateSize: () => 60,
    initialOffset: Number.MAX_SAFE_INTEGER,
    initialRect: { width: 800, height: 600 },
    scrollMargin: 64,
    paddingEnd,
    overscan: 1,
    getScrollElement: () => null,
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
  })
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>(options(64))

  expect(virtualizer.getVirtualItems().map((item) => item.index)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

  virtualizer.setOptions(options(600))
  expect(virtualizer.getVirtualItems().map((item) => item.index)).toEqual([18, 19])
})

test("stale pinned indexes do not produce missing virtual items after count shrinks", () => {
  createRoot((dispose) => {
    const [count, setCount] = createSignal(2)
    const pinned = [1]
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      get count() {
        return count()
      },
      getScrollElement: () => null,
      estimateSize: () => 60,
      initialRect: { width: 800, height: 600 },
      rangeExtractor: (range) =>
        filterVirtualIndexes([...new Set([...defaultRangeExtractor(range), ...pinned])], range.count),
    })

    expect(virtualizer.getVirtualItems().map((item) => item.index)).toEqual([0, 1])
    setCount(1)
    expect(virtualizer.getVirtualItems().map((item) => item.index)).toEqual([0])
    expect(() => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item]))).not.toThrow()
    dispose()
  })
})

test("a row measured from an earlier-registered effect still resolves its index", () => {
  // Why this test exists: Solid flushes createEffect callbacks in registration
  // order, and it runs `ref` callbacks before writing reactive attributes. A
  // row that measures itself from `onMount` -- registered before the JSX that
  // writes `data-index` -- therefore sees a missing attribute. Without the
  // explicit stamp, virtual-core logs
  // "Missing attribute name 'data-index={index}' on measured element" twice
  // per row and resizeItem drops the measurement (index resolves to -1).
  const seen: Array<string | null> = []
  const row = document.createElement("div")
  const virtualizer = {
    measureElement: (node: HTMLElement | null) => {
      seen.push(node?.getAttribute("data-index") ?? null)
    },
  }

  createRoot((dispose) => {
    document.body.append(row)
    // Stand-in for onMount(...measure(element)), registered first.
    createEffect(() => {
      virtualizer.measureElement(row)
    })
    // Stand-in for the compiled reactive `data-index={item().index}`.
    createEffect(() => {
      row.setAttribute("data-index", "4")
    })
    return dispose
  })

  // Effects flush at the end of createRoot, in registration order.
  expect(seen).toEqual([null])
  row.remove()
})

test("measureRowElement publishes the index before the virtualizer reads it", () => {
  const seen: Array<string | null> = []
  const row = document.createElement("div")
  const virtualizer = {
    measureElement: (node: HTMLElement | null) => {
      seen.push(node?.getAttribute("data-index") ?? null)
    },
  }

  createRoot((dispose) => {
    document.body.append(row)
    // Same registration order as the test above: the measuring effect is
    // created before the reactive attribute effect.
    createEffect(() => {
      measureRowElement(virtualizer, row, 4)
    })
    createEffect(() => {
      row.setAttribute("data-index", "4")
    })
    return dispose
  })

  expect(seen).toEqual(["4"])
  row.remove()
})
