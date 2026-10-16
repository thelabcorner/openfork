export function adjacentTabKey(order: string[], current: string | undefined, offset: -1 | 1) {
  if (!current || order.length === 0) return
  const index = order.indexOf(current)
  if (index === -1) return
  return order[(index + offset + order.length) % order.length]
}

export function mergeVisibleTabOrder(all: string[], current: string[], next: string[]) {
  const visible = new Set(current)
  const reordered = next.values()
  return all.map((key) => (visible.has(key) ? (reordered.next().value ?? key) : key))
}

/** One projection per tab-order/visibility revision. Keeps the visible order,
 * sortable indices and full-order reorder inputs consistent without repeated
 * tab-key generation or scans during keyboard and drag gestures. */
export function projectTabOrder<T>(
  tabs: readonly T[],
  keyOf: (tab: T) => string,
  isVisible: (tab: T, key: string) => boolean,
) {
  const visible: T[] = []
  const ids: string[] = []
  const allKeys: string[] = []
  const index = new Map<string, number>()
  const byKey = new Map<string, T>()

  for (const tab of tabs) {
    const key = keyOf(tab)
    allKeys.push(key)
    // Match `tabs.find()` for duplicate keys; the index map retains its
    // historical last-match semantics.
    if (!byKey.has(key)) byKey.set(key, tab)
    if (!isVisible(tab, key)) continue
    index.set(key, visible.length)
    visible.push(tab)
    ids.push(key)
  }
  return { visible, ids, allKeys, index, byKey }
}

/** Remove orphaned per-tab display state on structural tab-list revisions.
 * Session/group visibility can be restored from their reactive owners when a
 * tab is reopened; closed keys need not accumulate for the window's lifetime.
 */
export function staleTabVisibilityKeys(visibility: Readonly<Record<string, boolean>>, keys: readonly string[]) {
  const live = new Set(keys)
  return Object.keys(visibility).filter((key) => !live.has(key))
}
