/**
 * Bounded, stable ranking and projection helpers for Usage.summary.
 *
 * All inputs are already aggregated dimensions: these helpers never hydrate
 * full generation histories and preserve source iteration order on ties.
 */

/** Each model contributes three complete series: cost, tokens, and messages. */
export function usageModelSeriesBudget(maxValues: number, periods: number): number {
  if (!Number.isFinite(maxValues) || maxValues <= 0 || !Number.isFinite(periods) || periods <= 0) return 0
  return Math.max(0, Math.floor(maxValues / (3 * periods)))
}

export function usageBucketFloor(periods: readonly { readonly start: number }[], timestamp: number): number {
  let lo = 0
  let hi = periods.length
  while (lo < hi) {
    const middle = lo + Math.floor((hi - lo) / 2)
    if (periods[middle]!.start <= timestamp) lo = middle + 1
    else hi = middle
  }
  return lo - 1
}

/**
 * Collapse chronological usage periods into at most K lossless additive
 * display buckets. Representative-point sampling is invalid for this data:
 * the hero sums emitted periods for its totals, and provider/model series
 * accumulate the complete timeline into these same selected start boundaries.
 *
 * O(N + K) time after periods are sorted, rather than O(N log K).
 * A returned bucket's timestamp is the inclusive start of its represented
 * interval; metrics sum all source periods until the next returned start.
 */
export function rollupUsagePeriods<K extends "messages" | "requests", T extends {
  start: number
  cost: number
  tokens: number
} & Record<K, number>>(items: T[], max: number, countField: K): T[] {
  if (items.length <= max) return items
  if (max <= 0) return []
  if (max === 1) {
    const result = { ...items[0]!, cost: 0, tokens: 0, [countField]: 0 } as T
    for (const item of items) {
      result.cost += item.cost
      result.tokens += item.tokens
      ;(result as Record<K, number>)[countField] += item[countField]
    }
    return [result]
  }
  const end = items.length - 1
  const out = new Array<T>(max)
  for (let i = 0; i < max; i++) {
    const picked = items[Math.floor((i * end) / (max - 1))]!
    out[i] = { ...picked, cost: 0, tokens: 0, [countField]: 0 } as T
  }
  let slot = 0
  for (const item of items) {
    while (slot + 1 < out.length && out[slot + 1]!.start <= item.start) slot++
    out[slot]!.cost += item.cost
    out[slot]!.tokens += item.tokens
    ;(out[slot]! as Record<K, number>)[countField] += item[countField]
  }
  return out
}

type Ranked<T> = { value: T; score: number; index: number }

/**
 * Return the K highest-scored items, preserving iteration order on equal
 * scores. O(N log K + K log K) time, O(K) auxiliary storage.
 *
 * The scoring function runs exactly once per candidate, even when that
 * function must sum many per-period values.
 */
export function topUsageBy<T>(source: Iterable<T>, count: number, score: (value: T) => number): T[] {
  const limit = Math.max(0, Math.floor(count))
  if (!Number.isFinite(limit) && limit !== Infinity) return []
  if (limit === 0) return []

  const heap: Ranked<T>[] = []
  // Worst means lower score or (for an equal score) later insertion.
  const worse = (a: Ranked<T>, b: Ranked<T>) =>
    a.score < b.score || (a.score === b.score && a.index > b.index)

  let index = 0
  for (const value of source) {
    const item: Ranked<T> = { value, score: score(value), index: index++ }
    if (heap.length < limit) {
      let at = heap.length
      heap.push(item)
      while (at > 0) {
        const parent = Math.floor((at - 1) / 2)
        if (!worse(heap[at]!, heap[parent]!)) break
        ;[heap[at], heap[parent]] = [heap[parent]!, heap[at]!]
        at = parent
      }
      continue
    }
    if (!worse(heap[0]!, item)) continue
    heap[0] = item
    let at = 0
    for (;;) {
      const left = at * 2 + 1
      if (left >= heap.length) break
      const right = left + 1
      let next = left
      if (right < heap.length && worse(heap[right]!, heap[left]!)) next = right
      if (!worse(heap[next]!, heap[at]!)) break
      ;[heap[at], heap[next]] = [heap[next]!, heap[at]!]
      at = next
    }
  }
  heap.sort((a, b) => b.score - a.score || a.index - b.index)
  return heap.map((entry) => entry.value)
}

/** Precompute each model's total once, without re-scanning it during sorting. */
export function topUsageSeries<T extends ReadonlyMap<number, { readonly messages: number }>>(
  entries: Iterable<readonly [string, T]>,
  count: number,
): Array<[string, T]> {
  return topUsageBy(entries, count, ([, periods]) => {
    let total = 0
    for (const bucket of periods.values()) total += bucket.messages
    return total
  }).map(([key, periods]) => [key, periods])
}
