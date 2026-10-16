import {
  Virtualizer, elementScroll, observeElementOffset, observeElementRect,
  type VirtualItem, type VirtualizerOptions,
} from "@tanstack/solid-virtual"
import { createComputed, createSignal, mergeProps, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

/**
 * TanStack virtual-core can transiently return missing measurement slots
 * during count/key changes. The stock Solid adapter calls
 * reconcile(items, { key: "index" }) BEFORE exposing getVirtualItems(), and
 * dereferences undefined.index. Downstream filtering cannot prevent its crash.
 *
 * Fast path: validate already-sorted, unique items without allocation.
 * Recovery path: reject invalid/out-of-range slots and sort/deduplicate by
 * index before Solid's keyed store ever sees them.
 */
export function sanitizeVirtualItems(items: readonly (VirtualItem | undefined)[], count: number): VirtualItem[] {
  let previous = -1
  let valid = true
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.index) || item.index <= previous || item.index >= count) {
      valid = false
      break
    }
    previous = item.index
  }
  if (valid) return items as VirtualItem[]
  const byIndex = new Map<number, VirtualItem>()
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= count) continue
    byIndex.set(item.index, item)
  }
  return [...byIndex.values()].sort((left, right) => left.index - right.index)
}

/**
 * Safe application adapter for TanStack Solid Virtual 3.x. It mirrors the
 * adapter lifecycle, reactive options, and Store-backed live VirtualItems,
 * replacing ONLY the unsafe keyed reconciliation input. No core fork and
 * no changes to virtual measurement semantics.
 */
export function createSafeVirtualizer<TScrollElement extends Element, TItemElement extends Element>(
  options: Omit<
    VirtualizerOptions<TScrollElement, TItemElement>,
    "observeElementRect" | "observeElementOffset" | "scrollToFn"
  > & Partial<Pick<
    VirtualizerOptions<TScrollElement, TItemElement>,
    "observeElementRect" | "observeElementOffset" | "scrollToFn"
  >>,
): Virtualizer<TScrollElement, TItemElement> {
  const resolved = mergeProps({ observeElementRect, observeElementOffset, scrollToFn: elementScroll }, options)
  const core = new Virtualizer<TScrollElement, TItemElement>(resolved)
  const [items, setItems] = createStore<VirtualItem[]>(
    sanitizeVirtualItems(core.getVirtualItems(), core.options.count),
  )
  const [total, setTotal] = createSignal(core.getTotalSize())
  const virtualizer = new Proxy(core, {
    get(target, prop, receiver) {
      if (prop === "getVirtualItems") return () => items
      if (prop === "getTotalSize") return () => total()
      return Reflect.get(target, prop, receiver)
    },
  })
  const publish = () => {
    setItems(reconcile(sanitizeVirtualItems(core.getVirtualItems(), core.options.count), { key: "index" }))
    setTotal(core.getTotalSize())
  }
  virtualizer.setOptions(resolved)
  onMount(() => {
    const cleanup = virtualizer._didMount()
    virtualizer._willUpdate()
    onCleanup(cleanup)
  })
  createComputed(() => {
    virtualizer.setOptions(mergeProps(resolved, options, {
      onChange: (instance: Virtualizer<TScrollElement, TItemElement>, sync: boolean) => {
        instance._willUpdate()
        publish()
        options.onChange?.(instance, sync)
      },
    }))
    virtualizer._willUpdate()
    publish()
  })
  return virtualizer
}
