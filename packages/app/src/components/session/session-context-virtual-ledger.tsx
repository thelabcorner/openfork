import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualItem,
} from "@tanstack/solid-virtual"
import { measureVirtualRow } from "@/components/virtual-scroll-element"
import { ledgerEntryAt, ledgerPageEnds, safeLedgerVirtualItems, sameLedgerVirtualRange } from "./session-context-virtual-rows"

type LedgerRowSlot = {
  index: number
  key: VirtualItem["key"]
  start: () => number
  update: (start: number) => void
}

/** Stable keyed row shell, with a fine-grained reactive position. */
function createLedgerRowSlot(item: VirtualItem): LedgerRowSlot {
  const [start, setStart] = createSignal(item.start)
  let current = item.start
  return {
    index: item.index,
    key: item.key,
    start,
    update(next) {
      if (next === current) return
      current = next
      setStart(next)
    },
  }
}

/**
 * The pager swaps immutable page snapshots. Count, keys and row reads must all
 * use the same snapshot; the virtualizer may briefly retain indices from the
 * previous count while its reactive range is reconciling.
 */
export function ContextLedgerVirtualRows<T extends { messageID: string }>(props: {
  pages: () => readonly (readonly T[])[]
  count: () => number
  renderRow: (row: T) => JSX.Element
}) {
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const snapshot = createMemo((previous?: { pages: readonly (readonly T[])[]; ends: number[] }) => {
    const pages = props.pages()
    if (previous?.pages === pages) return previous
    return { pages, ends: ledgerPageEnds(pages) }
  })
  const rowAt = (index: number) => {
    const current = snapshot()
    return ledgerEntryAt(current.pages, current.ends, index)
  }
  // The stock TanStack Solid adapter reconciles virtual measurements by
  // "index". That keyed, mutable-store diff can expose transient missing
  // slots to <For> during range/count changes (and dereference item.index).
  // Publish a complete, validated range through ONE signal instead. Stable
  // slots retain DOM identity even if virtual-core replaces a measurement
  // object when resizing a row, avoiding ResizeObserver remount feedback.
  const [items, setItems] = createSignal<LedgerRowSlot[]>([])
  const [totalSize, setTotalSize] = createSignal(0)
  const itemKey = createMemo(() => {
    const current = snapshot()
    return (index: number) => ledgerEntryAt(current.pages, current.ends, index)?.messageID ?? `missing:${index}`
  })
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => root() ?? null,
    initialRect: { width: 420, height: 440 },
    estimateSize: () => 45,
    overscan: 7,
    getItemKey: (index) => rowAt(index)?.messageID ?? `missing:${index}`,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
  })
  let published: LedgerRowSlot[] = []
  let slots = new Map<VirtualItem["key"], LedgerRowSlot>()
  const publish = () => {
    const measurements = safeLedgerVirtualItems(virtualizer.getVirtualItems(), virtualizer.options.count, rowAt)
    batch(() => {
      const nextSlots = new Map<VirtualItem["key"], LedgerRowSlot>()
      const next: LedgerRowSlot[] = []
      for (const item of measurements) {
        const existing = slots.get(item.key)
        const slot = existing?.index === item.index ? existing : createLedgerRowSlot(item)
        slot.update(item.start)
        next.push(slot)
        nextSlots.set(item.key, slot)
      }
      slots = nextSlots // Release out-of-range shells; memory is O(visible rows).
      if (!sameLedgerVirtualRange(published, next)) {
        published = next
        setItems(next)
      }
      setTotalSize(virtualizer.getTotalSize())
    })
  }
  createEffect(() => {
    // Use one page snapshot for both measurements and row IDs. Do not force a
    // whole-ledger flatten, or invalidate measurement keys on totals-only updates.
    const current = snapshot()
    const getItemKey = itemKey()
    root()
    virtualizer.setOptions({
      count: current.ends.at(-1) ?? 0,
      getScrollElement: () => root() ?? null,
      initialRect: { width: 420, height: 440 },
      estimateSize: () => 45,
      overscan: 7,
      getItemKey,
      observeElementRect,
      observeElementOffset,
      scrollToFn: elementScroll,
      onChange: () => {
        virtualizer._willUpdate()
        publish()
      },
    })
    virtualizer._willUpdate()
    publish()
  })
  onMount(() => {
    const cleanup = virtualizer._didMount()
    virtualizer._willUpdate()
    publish()
    onCleanup(cleanup)
  })
  return (
    <div ref={setRoot} class="max-h-[min(440px,50vh)] overflow-y-auto overscroll-contain" role="list"
      aria-label="Context ledger messages">
      <div class="relative" style={{ height: `${totalSize()}px` }}>
        <For each={items()}>
          {(item) => {
            const row = () => rowAt(item.index)
            return (
              <div ref={measureVirtualRow(virtualizer, item.index)} data-index={item.index}
                role="listitem" class="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${item.start()}px)` }}>
                <Show when={row()} keyed>{(entry) => props.renderRow(entry)}</Show>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}
