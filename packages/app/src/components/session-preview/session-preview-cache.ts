import type { SessionGroupEntry } from "@/context/session-groups"
import type { SessionPreviewIndex, SessionPreviewRelationships, SessionPreviewSection } from "./session-preview-model"
import { sessionPreviewGroupOnly, sessionPreviewRelationships } from "./session-preview-model"

/**
 * Relationship projections are immutable for a committed group snapshot. Store
 * those expensive tree walks by snapshot identity (weakly) instead of rebuilding
 * them every time the pointer crosses a tab/sidebar row.
 *
 * Never use a time-based stale cache for live group memberships: the producer
 * replaces the snapshot when its revision changes, giving the next hover a
 * fresh bucket automatically. The per-snapshot LRU bounds retained projections
 * even if a single server has thousands of independently hovered sessions.
 */
export function createSessionPreviewProjectionCache(maxPerSnapshot = 24) {
  const limit = Math.max(1, Math.floor(maxPerSnapshot))
  const sessions = new WeakMap<readonly SessionGroupEntry[], Map<string, SessionPreviewRelationships>>()
  const groups = new WeakMap<SessionGroupEntry, SessionPreviewSection>()

  const session = (input: {
    sessionID: string
    groups: readonly SessionGroupEntry[]
    index: SessionPreviewIndex
  }): SessionPreviewRelationships => {
    let bucket = sessions.get(input.groups)
    if (!bucket) {
      bucket = new Map()
      sessions.set(input.groups, bucket)
    }
    const cached = bucket.get(input.sessionID)
    if (cached) {
      // Refresh recency without constructing another projection.
      bucket.delete(input.sessionID)
      bucket.set(input.sessionID, cached)
      return cached
    }
    const value = sessionPreviewRelationships(input)
    bucket.set(input.sessionID, value)
    if (bucket.size > limit) bucket.delete(bucket.keys().next().value!)
    return value
  }
  const group = (source: SessionGroupEntry): SessionPreviewSection => {
    const cached = groups.get(source)
    if (cached) return cached
    const value = sessionPreviewGroupOnly(source)
    groups.set(source, value)
    return value
  }
  return { session, group }
}

/** One module-wide reusable projection cache, with no reactive subscriptions. */
export const sessionPreviewProjectionCache = createSessionPreviewProjectionCache()
