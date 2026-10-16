export type UsageSortValue = number | string

/**
 * Stable, bounded sorted prefix for "show more" tables.
 *
 * When the visible window is small relative to the source, retain only the
 * best K rows in a max-heap. The heap root is the worst retained row; ties
 * preserve original source order just like stable Array.sort.
 *
 * Time: O(n log K + K log K), space: O(K). Full-size requests use an ordinary
 * stable sort. Avoid per-comparison accessors and never mutate server arrays.
 */
export function sortedUsagePrefix<T>(
  rows: readonly T[],
  limit: number,
  valueOf: (row: T) => UsageSortValue,
  direction: "asc" | "desc",
): T[] {
  const count = Math.min(rows.length, Math.max(0, Math.floor(limit)))
  if (!count) return []

  type Entry = { row: T; index: number; value: UsageSortValue }
  const sign = direction === "asc" ? 1 : -1
  const compareValue = (a: UsageSortValue, b: UsageSortValue) =>
    (typeof a === "string" || typeof b === "string"
      ? String(a).localeCompare(String(b))
      : a - (b as number)) * sign
  const compare = (a: Entry, b: Entry) => compareValue(a.value, b.value) || a.index - b.index
  const fullSort = () =>
    [...rows]
      .sort((a, b) => compareValue(valueOf(a), valueOf(b)))
      .slice(0, count)

  // Native Timsort beats the heap on small or nearly fully revealed tables,
  // particularly when the upstream query has already provided sorted rows.
  // Callers with a documented presorted source can bypass ranking altogether.
  if (rows.length <= 512 || count >= rows.length / 2) return fullSort()

  const heap: Entry[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const value = valueOf(row)
    if (typeof value === "number" && Number.isNaN(value)) return fullSort()
    const candidate: Entry = { row, index, value }
    if (heap.length < count) {
      heap.push(candidate)
      for (let child = heap.length - 1; child > 0; ) {
        const parent = (child - 1) >> 1
        if (compare(heap[parent], heap[child]) >= 0) break
        ;[heap[parent], heap[child]] = [heap[child], heap[parent]]
        child = parent
      }
      continue
    }
    if (compare(candidate, heap[0]) >= 0) continue
    heap[0] = candidate
    for (let parent = 0; ; ) {
      const left = parent * 2 + 1
      if (left >= heap.length) break
      const right = left + 1
      let worst = left
      if (right < heap.length && compare(heap[right], heap[left]) > 0) worst = right
      if (compare(heap[parent], heap[worst]) >= 0) break
      ;[heap[parent], heap[worst]] = [heap[worst], heap[parent]]
      parent = worst
    }
  }
  return heap.sort(compare).map((entry) => entry.row)
}