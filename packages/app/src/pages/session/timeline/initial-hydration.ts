/**
 * A timeline is eligible for initial-loading UI only until its first
 * paintable content or completed initial hydration. Neither history pagination,
 * background refresh, stream repair, nor cache eviction may re-arm the loader.
 *
 * The gate lives across SessionPage remounts: a remount is not a first visit.
 * Preserve this invariant for the lifetime of the renderer, including after
 * arbitrarily many tab switches. Each remembered identity is just a string,
 * not hydrated message content.
 */
export function createInitialTimelineHydrationGate() {
  const painted = new Set<string>()

  return {
    eligible(key: string | undefined, ready: boolean, hasContent: boolean): boolean {
      if (!key) return false
      if (ready || hasContent) {
        painted.add(key)
        return false
      }
      return !painted.has(key)
    },
  }
}

/** Shared across route and panel remounts; the source store remains authoritative. */
export const initialTimelineHydration = createInitialTimelineHydrationGate()
