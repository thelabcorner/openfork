/**
 * Navigation is a compact projection of the visible model rows. Headers and
 * separators consume virtual indices but never keyboard positions; Manage
 * consumes a keyboard position but is outside the virtualized viewport.
 */
export type SelectorNavigationSource<T> =
  | { kind: "item"; navKey: string; item: T }
  | { kind: "header" | "separator" }

export type SelectorNavigationEntry<T> = { navKey: string; item?: T }

/** Remove favorites/recents from provider groups without cloning untouched groups.
 * The old map/filter chain allocated one extra array and object per provider
 * whenever even a single favorite existed anywhere in the catalog. */
export function excludeModelSectionRows<T>(
  groups: readonly { category: string; items: T[] }[],
  excluded: ReadonlySet<string>,
  keyOf: (item: T) => string,
): Array<{ category: string; items: T[] }> {
  if (excluded.size === 0) return groups as Array<{ category: string; items: T[] }>
  const next: Array<{ category: string; items: T[] }> = []
  for (const group of groups) {
    let remaining: T[] | undefined
    for (let index = 0; index < group.items.length; index++) {
      const item = group.items[index]!
      if (excluded.has(keyOf(item))) {
        if (!remaining) remaining = group.items.slice(0, index)
      } else if (remaining) remaining.push(item)
    }
    if (!remaining) next.push(group)
    else if (remaining.length) next.push({ ...group, items: remaining })
  }
  return next
}

export type SelectorVirtualRow<T> =
  | { kind: "header"; key: string; provider?: string; title: string }
  | { kind: "separator"; key: string }
  | { kind: "item"; key: string; navKey: string; item: T }

type VirtualPosition = { index: number; start: number; size: number }
type VirtualEntry<T, V extends VirtualPosition> = { virtualRow: V; row: SelectorVirtualRow<T> | undefined }

/**
 * TanStack recreates virtual-item objects while Solid's <For> keys entries by
 * reference. Keep mounted rows stable across equivalent catalog projections:
 * same item identity, heading text, or separator, at the same measured slot.
 * Changed models/headings and shifted slots correctly receive new entries.
 */
export function reconcileVirtualModelRows<T, V extends VirtualPosition>(
  snapshot: readonly SelectorVirtualRow<T>[],
  virtual: readonly V[],
  previous: readonly VirtualEntry<T, V>[],
): VirtualEntry<T, V>[] {
  const prior = new Map<string, VirtualEntry<T, V>>()
  for (const entry of previous) if (entry.row) prior.set(entry.row.key, entry)
  const next: VirtualEntry<T, V>[] = []
  for (const virtualRow of virtual) {
    const row = snapshot[virtualRow.index]
    const existing = row && prior.get(row.key)
    const old = existing?.row
    const equivalent =
      old &&
      row &&
      old.kind === row.kind &&
      (row.kind === "item"
        ? old.kind === "item" && old.item === row.item && old.navKey === row.navKey
        : row.kind === "header"
          ? old.kind === "header" && old.provider === row.provider && old.title === row.title
          : true)
    if (
      equivalent &&
      existing.virtualRow.index === virtualRow.index &&
      existing.virtualRow.start === virtualRow.start &&
      existing.virtualRow.size === virtualRow.size
    ) {
      next.push(existing)
    } else {
      next.push({ virtualRow, row })
    }
  }
  return next
}

export function indexSelectorRows<T>(rows: readonly SelectorNavigationSource<T>[], manageKey: string) {
  const keys: string[] = []
  const byKey = new Map<string, SelectorNavigationEntry<T>>()
  const indexByKey = new Map<string, number>()
  const renderIndex = new Map<string, number>()
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i]
    if (item.kind !== "item") continue
    const row: SelectorNavigationEntry<T> = { navKey: item.navKey, item: item.item }
    renderIndex.set(row.navKey, i)
    indexByKey.set(row.navKey, keys.length)
    keys.push(row.navKey)
    byKey.set(row.navKey, row)
  }
  indexByKey.set(manageKey, keys.length)
  keys.push(manageKey)
  byKey.set(manageKey, { navKey: manageKey })
  return { keys, byKey, indexByKey, renderIndex }
}
