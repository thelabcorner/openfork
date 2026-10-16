/**
 * Select a tiny leaderboard without sorting the entire usage portfolio.
 * O(n * limit) time and O(limit) auxiliary space; at the page's limit of five,
 * this avoids the O(n log n) sort and the full-array allocation. Ties retain
 * their original order, as in a stable descending Array.sort.
 */
export function topRanked<T>(
  rows: readonly T[],
  limit: number,
  score: (row: T) => number,
  include: (row: T) => boolean,
): T[] {
  if (limit <= 0) return []
  const top: T[] = []
  for (const row of rows) {
    if (!include(row)) continue
    const value = score(row)
    let index = top.length
    while (index > 0 && score(top[index - 1]) < value) index--
    if (index >= limit) continue
    top.splice(index, 0, row)
    if (top.length > limit) top.pop()
  }
  return top
}