/**
 * Search selection changes much more often than the result list. Materialize
 * positions once per result-list revision instead of scanning every hit on
 * every ArrowUp/ArrowDown, active-row pin, and scroll-range extraction.
 */
export function indexChatSidebarSearchHits<T extends { key: string }>(hits: readonly T[]): ReadonlyMap<string, number> {
  const positions = new Map<string, number>()
  for (let index = 0; index < hits.length; index++) {
    const key = hits[index]!.key
    // Match the old findIndex contract for duplicate logical keys.
    if (!positions.has(key)) positions.set(key, index)
  }
  return positions
}