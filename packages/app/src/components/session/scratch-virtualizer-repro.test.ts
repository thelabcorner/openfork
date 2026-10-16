import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { ledgerEntryAt, ledgerPageEnds } from "./session-context-virtual-rows"

type Row = { messageID: string }
const page = (start: number, size: number): Row[] =>
  Array.from({ length: size }, (_, i) => ({ messageID: `m-${start + i}` }))

describe("scratch: virtualizer item integrity under count churn", () => {
  test("adapter-driven count/page transitions keep items defined", () => {
    const [pages, setPages] = createSignal<readonly (readonly Row[])[]>([])
    const [rootEl, setRootEl] = createSignal<HTMLDivElement>()
    let offset = 0
    let offsetCb: ((offset: number, isScrolling: boolean) => void) | undefined
    const problems: string[] = []

    const count = () => pages().reduce((sum, p) => sum + p.length, 0)

    createRoot((dispose) => {
      const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
        get count() {
          return count()
        },
        getScrollElement: () => rootEl() ?? null,
        initialRect: { width: 420, height: 440 },
        estimateSize: () => 45,
        overscan: 7,
        getItemKey: (index) => {
          const ends = ledgerPageEnds(pages())
          return ledgerEntryAt(pages(), ends, index)?.messageID ?? index
        },
        observeElementRect: (_instance, cb) => {
          cb({ width: 420, height: 440 })
          return () => {}
        },
        observeElementOffset: (_instance, cb) => {
          offsetCb = cb
          cb(offset, false)
          return () => {}
        },
      })
      virtualizer._didMount()
      virtualizer._willUpdate()

      const check = (label: string) => {
        const items = virtualizer.getVirtualItems()
        items.forEach((item, i) => {
          if (!item) problems.push(`${label}: undefined item at position ${i} (count=${count()}, len=${items.length})`)
        })
      }

      check("initial empty")

      setRootEl(document.createElement("div"))
      check("root attached")

      setPages([page(0, 50)])
      check("page1")

      setPages([page(0, 50), page(50, 50)])
      check("page2")

      offset = 2000
      offsetCb?.(offset, true)
      check("scrolled page2")

      setPages([])
      check("cleared")

      offset = 0
      offsetCb?.(offset, false)
      check("cleared+scroll reset")

      setPages([page(0, 30)])
      check("new session page1")

      setPages([page(0, 30), page(30, 30), page(60, 30)])
      check("new session page3")

      offset = 4000
      offsetCb?.(offset, true)
      check("scrolled page3")

      setPages([page(0, 5)])
      check("shrink")

      dispose()
    })

    expect(problems).toEqual([])
  })
})
