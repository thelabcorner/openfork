import { expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/solid-virtual"
import { measureVirtualRow, virtualScrollElement } from "./virtual-scroll-element"

test("resolves the connected viewport that owns the virtual root", () => {
  const stale = document.createElement("div")
  stale.className = "scroll-view__viewport"
  const viewport = document.createElement("div")
  viewport.className = "scroll-view__viewport"
  const root = document.createElement("div")
  viewport.append(root)
  document.body.append(viewport)

  expect(virtualScrollElement(root)).toBe(viewport)
  expect(virtualScrollElement(root)).not.toBe(stale)

  viewport.remove()
  expect(virtualScrollElement(root)).toBeNull()
})

function createRowVirtualizer(count: number) {
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    estimateSize: () => 24,
    initialRect: { width: 320, height: 720 },
    getScrollElement: () => null,
    observeElementRect: () => {},
    observeElementOffset: () => {},
    scrollToFn: () => {},
    getItemKey: (index) => `row-${index}`,
  })
  // Populate the flat measurement table the way a mount would.
  virtualizer.getTotalSize()
  return virtualizer
}

function captureWarnings() {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  return {
    warnings,
    restore: () => {
      console.warn = original
    },
  }
}

test("row measurement resolves its index before the virtualizer reads it", () => {
  const virtualizer = createRowVirtualizer(5)
  const row = document.createElement("div")
  document.body.append(row)

  const capture = captureWarnings()
  try {
    measureVirtualRow(virtualizer, 3)(row)
  } finally {
    capture.restore()
  }

  expect(capture.warnings).toEqual([])
  expect(row.getAttribute("data-index")).toBe("3")
  // Measured and cached under the real key, not a discarded `-1`.
  expect([...virtualizer.elementsCache.keys()]).toEqual(["row-3"])
  expect(virtualizer.itemSizeCache.has("row-3")).toBe(true)
  expect(virtualizer.itemSizeCache.has("row--1")).toBe(false)

  row.remove()
})

test("measuring before data-index exists is the defect the row ref prevents", () => {
  const virtualizer = createRowVirtualizer(5)
  const row = document.createElement("div")
  document.body.append(row)

  const capture = captureWarnings()
  try {
    // What Solid does for `ref={virtualizer.measureElement}`: the ref runs
    // before the reactive `data-index` attribute is written.
    virtualizer.measureElement(row)
  } finally {
    capture.restore()
  }

  // Twice per row: the sync path resolves the index once for the element key
  // and again inside `options.measureElement`'s cached-size lookup. That
  // doubling is why an unmounted viewport fills the console.
  expect(capture.warnings).toHaveLength(2)
  expect(capture.warnings.every((warning) => warning.includes("data-index"))).toBe(true)
  expect([...virtualizer.elementsCache.keys()]).toEqual(["row--1"])
  expect(virtualizer.itemSizeCache.size).toBe(0)

  row.remove()
})

test("the row ref tolerates a detached element", () => {
  const virtualizer = createRowVirtualizer(5)
  const row = document.createElement("div")

  const capture = captureWarnings()
  try {
    measureVirtualRow(virtualizer, 0)(row)
    measureVirtualRow(virtualizer, 0)(null as unknown as HTMLDivElement)
  } finally {
    capture.restore()
  }

  expect(capture.warnings).toEqual([])
  expect(row.getAttribute("data-index")).toBe("0")
})
