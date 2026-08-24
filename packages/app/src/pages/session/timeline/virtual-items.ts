import type { VirtualItem } from "@tanstack/solid-virtual"

export function filterVirtualIndexes(indexes: number[], count: number) {
  return indexes.filter((index) => index >= 0 && index < count)
}

/**
 * Single pass over the virtualizer's items building both per-key lookups.
 *
 * Items whose key is absent from the timeline projection are SKIPPED: the
 * virtualizer's item store is updated by async paths (ResizeObserver/scroll
 * notifies, count-shrink reconcile) and its getItemKey emits "removed:N"
 * placeholders for indexes past the row list, so a rendered key can
 * transiently have no TimelineRow. Rendering one would crash reading
 * row._tag; skipping only leaves an unmeasured index that self-heals on
 * the next consistent pass. hasRowKey must be O(1) (a Map.has).
 */
export function collectVirtualItems(
  items: readonly VirtualItem[],
  hasRowKey: (key: string) => boolean,
): { byKey: Map<string, VirtualItem>; keys: string[] } {
  const byKey = new Map<string, VirtualItem>()
  const keys: string[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item) continue
    const key = typeof item.key === "string" ? item.key : String(item.key)
    if (!hasRowKey(key)) continue
    byKey.set(key, item)
    keys.push(key)
  }
  return { byKey, keys }
}
