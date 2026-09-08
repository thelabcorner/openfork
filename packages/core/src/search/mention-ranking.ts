import type { Matcher } from "./matcher"

const DAY_MS = 24 * 60 * 60 * 1000

// Deliberately bounded below the measured exact-basename vs longer-prefix score
// gap. Freshness breaks lexical ties and near-ties; it does not replace search
// relevance with an mtime sort.
const MENTION_RECENCY_BY_DAY = [6, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1] as const

export type MentionFileMetadata = { size: number; mtime: number; lineCount?: number }

export function mentionRecencyBoost(mtime: number | undefined, now = Date.now()): number {
  if (typeof mtime !== "number" || !Number.isFinite(mtime) || mtime <= 0) return 0
  const age = Math.max(0, now - mtime)
  return MENTION_RECENCY_BY_DAY[Math.floor(age / DAY_MS)] ?? 0
}

/**
 * Re-rank an already relevance-gated file page with a small live recency prior.
 * Keeping this post-match is intentional: saves update metadata cheaply without
 * rebuilding the prepared fuzzy index, and mtime can never admit a non-match.
 */
export function rankFileMentionResults(
  results: readonly Matcher.UnifiedResult[],
  metadata: (path: string) => MentionFileMetadata | undefined,
  now = Date.now(),
): Matcher.UnifiedResult[] {
  return results
    .map((row, order) => {
      if (row.kind !== "file" || !row.path || row.type === "directory") return { row, order, rankScore: row.score }
      const meta = metadata(row.path)
      const mtime = meta?.mtime ?? row.mtime
      const rowWithFreshMeta = meta
        ? { ...row, size: meta.size, mtime: meta.mtime, lineCount: meta.lineCount }
        : row
      return {
        row: rowWithFreshMeta,
        order,
        rankScore: row.score + mentionRecencyBoost(mtime, now),
      }
    })
    .sort((a, b) => b.rankScore - a.rankScore || b.row.score - a.row.score || a.order - b.order)
    .map(({ row, rankScore }) => (row.kind === "file" ? { ...row, score: rankScore } : row))
}
