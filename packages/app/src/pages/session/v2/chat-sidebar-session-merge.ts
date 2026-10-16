import type { Session } from "@opencode-ai/sdk/v2/client"

/** Match the canonical server index's descending activity / ascending id order. */
export const compareChatSidebarSessionTime = (a: Session, b: Session) =>
  (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Assemble the globally sorted session index from project-owned slices.
 *
 * A single project already has a sorted server-owned index: clone/dedupe it in
 * linear time rather than sorting it again. For multiple projects, V8's
 * optimized TimSort outperformed an explicit binary-heap k-way merge in real
 * Bun benchmarks, even with 50 projects / 25,000 rows. Preserve that faster
 * native sort rather than choosing a worse constant factor for theoretical
 * O(N log P) complexity.
 *
 * Deduplication intentionally retains the LAST source's Session object,
 * including when an earlier project carries a newer timestamp. That matches
 * the existing `uniqueSidebarSessions(flattened).sort(compareSessionTime)`
 * contract (Map overwrites values for existing keys).
 * Never mutates its inputs. Every source must be ordered by the comparator.
 */
export function mergeSortedChatSidebarSessions(sources: readonly (readonly Session[])[]): Session[] {
  if (!sources.length) return []
  if (sources.length === 1) {
    const seen = new Set<string>()
    const rows = sources[0]!
    for (const row of sources[0]!) {
      // A single canonical project slice is already sorted and unique. If
      // legacy overlapping slices violate that invariant, preserve the old
      // last-wins deduplication and re-sort the winners.
      if (seen.has(row.id)) {
        return [...new Map(rows.map((item) => [item.id, item] as const)).values()].sort(compareChatSidebarSessionTime)
      }
      seen.add(row.id)
    }
    return [...rows]
  }
  // Mirror the proven multi-project native path exactly. flatMap's extra
  // callback/flatten overhead produced a small regression with five sources.
  const concatenated: Session[] = []
  for (const rows of sources) concatenated.push(...rows)
  return [...new Map(concatenated.map((row) => [row.id, row] as const)).values()].sort(compareChatSidebarSessionTime)
}