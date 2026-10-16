import type { VirtualItem } from "@tanstack/solid-virtual"

export function filterVirtualIndexes(indexes: number[], count: number) {
  return indexes.filter((index) => index >= 0 && index < count)
}

/**
 * Reconcile a virtualizer's measurement window with the *current* projection.
 * A count/key update and getVirtualItems() are not an atomic transaction. Its
 * old key may survive for a tick at an index now owned by another row, which
 * used to filter every item and blank the whole message column.
 */
export function collectVirtualItems(
  items: readonly (VirtualItem | undefined)[],
  hasRowKey: (key: string) => boolean,
  currentKeyAt?: (index: number) => string | undefined,
): { byKey: Map<string, VirtualItem>; keys: string[] } {
  const byKey = new Map<string, VirtualItem>()
  const keys: string[] = []
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.index) || item.index < 0) continue
    const key = currentKeyAt ? currentKeyAt(item.index) : String(item.key)
    if (!key || !hasRowKey(key) || byKey.has(key)) continue
    byKey.set(key, String(item.key) === key ? item : { ...item, key })
    keys.push(key)
  }
  return { byKey, keys }
}

/**
 * The active streaming row may be pinned outside the viewport. A nonempty
 * virtualizer window is not proof that visible pixels are covered.
 * Test the union of measured intervals, with only a 1px rounding allowance.
 */
export function coversVirtualViewport(
  items: Iterable<VirtualItem>,
  top: number,
  bottom: number,
  tolerance = 1,
): boolean {
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return false
  let covered = top
  for (const item of items) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.end <= covered) continue
    if (item.start > covered + tolerance) return false
    covered = Math.max(covered, item.end)
    if (covered >= bottom - tolerance) return true
  }
  return false
}

/**
 * True if a newly measured height must be compensated to keep reading content
 * at the same physical y. Avoid range.startIndex: it may lag the DOM while an
 * upward scroll and a delayed ResizeObserver measurement cross in one frame.
 *
 * Full rows above the viewport always affect the reading anchor. A row partly
 * clipped at the top does too, but only if its successor starts on-screen.
 * A single giant visible row remains the anchor to itself instead.
 */
export function shouldCompensateReadingResize(
  item: VirtualItem,
  next: VirtualItem | undefined,
  viewportTop: number,
  viewportBottom: number,
): boolean {
  if (!Number.isFinite(viewportTop) || !Number.isFinite(viewportBottom) || viewportBottom <= viewportTop) return false
  if (item.end <= viewportTop + 0.5) return true
  if (item.start >= viewportTop - 0.5) return false
  return !!next && next.start >= viewportTop - 0.5 && next.start < viewportBottom - 0.5
}

/**
 * A detached/reconnected scroll viewport can transiently leave TanStack's
 * range null and getVirtualItems() empty while measurements remain valid.
 * Recover only the intersecting window via O(log n) binary search, never a
 * full-list render. Normal steady-state rendering never calls this path.
 */
export function recoverVirtualWindow(
  measurements: readonly VirtualItem[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 8,
): VirtualItem[] {
  if (!measurements.length || !Number.isFinite(scrollTop) || !Number.isFinite(viewportHeight)) return []
  const total = measurements[measurements.length - 1]!.end
  const height = Math.max(1, viewportHeight)
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, total - height)))
  let lo = 0
  let hi = measurements.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (measurements[mid]!.end <= top) lo = mid + 1
    else hi = mid
  }
  const first = Math.min(lo, measurements.length - 1)
  let end = first
  const bottom = top + height
  while (end < measurements.length && measurements[end]!.start < bottom) end++
  return measurements.slice(Math.max(0, first - overscan), Math.min(measurements.length, end + overscan))
}

/**
 * Merge the ordered visible range, temporary resize pins and the active row
 * into a unique, bounded index window. This is a three-way merge:
 * O(visible + pinned + 1) time, one output allocation, no Set/sort/filter.
 *
 * Inputs from defaultRangeExtractor and resize pinning are ascending. Unlike
 * a concatenation/sort, an offscreen active row can be inserted at any
 * position without copying or sorting pinned indices.
 */
export function mergeVirtualIndexes(
  visible: readonly number[],
  pinned: readonly number[],
  active: number,
  count: number,
): number[] {
  if (count <= 0) return []
  // Resize pins exist only for a few frames after an unusually large height
  // correction. Most scroll frames have none; keep the already-owned
  // defaultRangeExtractor array and insert only the active row if necessary.
  if (!pinned.length) {
    const activeValid = Number.isSafeInteger(active) && active >= 0 && active < count
    if (!visible.length) return activeValid ? [active] : []
    if (!activeValid) return visible as number[]
    if (active < visible[0]!) return [active, ...visible]
    if (active > visible[visible.length - 1]!) return [...visible, active]
    let lo = 0
    let hi = visible.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (visible[mid]! < active) lo = mid + 1
      else hi = mid
    }
    if (visible[lo] === active) return visible as number[]
    return [...visible.slice(0, lo), active, ...visible.slice(lo)]
  }
  const merged: number[] = []
  let vi = 0
  let pi = 0
  let activePending = Number.isSafeInteger(active) && active >= 0 && active < count
  while (vi < visible.length || pi < pinned.length || activePending) {
    const v = visible[vi] ?? Infinity
    const p = pinned[pi] ?? Infinity
    const a = activePending ? active : Infinity
    const index = Math.min(v, p, a)
    if (!Number.isFinite(index)) break
    if (v === index) vi++
    if (p === index) pi++
    if (a === index) activePending = false
    if (index < 0 || index >= count || merged[merged.length - 1] === index) continue
    merged.push(index)
  }
  return merged
}
