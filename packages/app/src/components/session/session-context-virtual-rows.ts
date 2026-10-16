/**
 * Prefix indexing for the Context ledger's immutable bounded pages.
 * Building the offsets costs O(pages); looking up a visible row costs
 * O(log pages) and never allocates a flattened 20k-element array.
 */
export function ledgerPageEnds<T>(pages: readonly (readonly T[])[]) {
  const ends: number[] = []
  let total = 0
  for (const page of pages) {
    total += page.length
    ends.push(total)
  }
  return ends
}

export function ledgerEntryAt<T>(
  pages: readonly (readonly T[])[],
  ends: readonly number[],
  index: number,
): T | undefined {
  if (!Number.isSafeInteger(index) || index < 0 || index >= (ends.at(-1) ?? 0)) return undefined
  let low = 0
  let high = ends.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (ends[mid]! <= index) low = mid + 1
    else high = mid
  }
  return pages[low]?.[index - (low === 0 ? 0 : ends[low - 1]!)]
}

/**
 * Sanitize virtual-core measurements before publishing a complete range to
 * Solid. Missing measurements or stale keys are legal while a session/count
 * switch settles; neither may reach a visible row.
 */
export function safeLedgerVirtualItems<T extends { index: number; key: string | number | bigint }>(
  items: readonly (T | undefined)[],
  count: number,
  rowAt: (index: number) => { messageID: string } | undefined,
): T[] {
  const valid: T[] = []
  let previous = -1
  let needsOrder = false
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= count) continue
    if (rowAt(item.index)?.messageID !== item.key) continue
    if (item.index <= previous) needsOrder = true
    previous = item.index
    valid.push(item)
  }
  if (!needsOrder) return valid
  const unique = new Map<number, T>()
  for (const item of valid) unique.set(item.index, item)
  return [...unique.values()].sort((a, b) => a.index - b.index)
}

/** Avoid notifying all visible <For> children for an unchanged core range. */
export function sameLedgerVirtualRange<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}
