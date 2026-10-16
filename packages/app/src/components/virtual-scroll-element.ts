export function virtualScrollElement(root: HTMLElement | undefined) {
  if (!root?.isConnected) return null
  return root.closest<HTMLDivElement>(".scroll-view__viewport")
}

/**
 * Measure a virtualized row element that is about to be handed to
 * `virtualizer.measureElement`.
 *
 * Solid flushes `createEffect` callbacks in registration order, and it runs
 * `ref` callbacks before it writes reactive attributes. Both orderings mean a
 * row can reach `measureElement` while its `data-index` is still absent.
 * `indexFromElement` then resolves -1: it warns (twice per row, because the
 * sync path also resolves the index for its cached-size lookup),
 * `resizeItem` discards the measurement, and the ResizeObserver entry is
 * cached under a bogus `-1` key.
 *
 * Stamp the index first so the row measures on its real key. A reactive JSX
 * `data-index` attribute still owns later index changes and is the authority
 * the ResizeObserver re-reads on every resize; stamping here only guarantees
 * the index is present at measure time.
 */
export function measureRowElement<TItemElement extends Element>(
  virtualizer: { measureElement: (node: TItemElement | null) => void },
  element: TItemElement,
  index: number,
) {
  element.setAttribute("data-index", String(index))
  virtualizer.measureElement(element)
}

/** `ref` form of {@link measureRowElement} for a virtualized row. */
export function measureVirtualRow<TItemElement extends Element>(
  virtualizer: { measureElement: (node: TItemElement | null) => void },
  index: number,
) {
  return (element: TItemElement) => {
    if (!element) return
    measureRowElement(virtualizer, element, index)
  }
}
