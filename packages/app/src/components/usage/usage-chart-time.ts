/**
 * Chronological chart coordinate helpers.
 * Usage histories are sparse, so index-based X coordinates compress inactivity
 * into an apparent continuous timeline. Use true timestamps for geometry and
 * a logarithmic nearest-neighbor lookup for hover.
 */
export function usageTimeRatio(start: number, end: number, value: number, index: number, count: number): number {
  const span = end - start
  return span > 0 ? (value - start) / span : index / Math.max(1, count - 1)
}

export function nearestUsageTimeIndex(periods: readonly { readonly start: number }[], fraction: number): number {
  if (periods.length === 0) return -1
  if (periods.length === 1) return 0
  const first = periods[0]!.start
  const last = periods[periods.length - 1]!.start
  if (last <= first) return Math.min(periods.length - 1, Math.max(0, Math.round(fraction * (periods.length - 1))))
  const target = first + Math.max(0, Math.min(1, fraction)) * (last - first)
  let lo = 0
  let hi = periods.length
  while (lo < hi) {
    const middle = lo + Math.floor((hi - lo) / 2)
    if (periods[middle]!.start < target) lo = middle + 1
    else hi = middle
  }
  if (lo === 0) return 0
  if (lo >= periods.length) return periods.length - 1
  const before = periods[lo - 1]!.start
  const after = periods[lo]!.start
  return target - before < after - target ? lo - 1 : lo
}
