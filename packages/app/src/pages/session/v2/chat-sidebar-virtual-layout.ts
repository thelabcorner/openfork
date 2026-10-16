/**
 * Single source of truth for the fixed-height virtual sidebar blocks.
 *
 * These blocks should never be ResizeObserver-measured: Solid's ref callback
 * can precede descendant attachment, momentarily reporting a zero-height
 * element. Publishing that size into TanStack compresses every subsequent
 * row until (and sometimes after) the observer recovers.
 *
 * Only content-dependent blocks (OXP, empty, archived) need measurement.
 */
export type SidebarFixedBlock =
  | "section-head"
  | "session"
  | "cluster-head"
  | "cluster-member"
  | "more"
  | "less"

export function sidebarFixedBlockHeight(type: string, density: "compact" | "detailed"): number | undefined {
  switch (type) {
    case "section-head": return 24
    case "session": return density === "detailed" ? 36 : 23
    case "cluster-head": return 25
    case "cluster-member": return 23
    case "more":
    case "less": return 23
    default: return undefined
  }
}

/**
 * Sticky headers remain absolute virtual rows. Do not switch their position to
 * CSS sticky: doing so puts the header into normal flow while its neighbors
 * remain absolutely positioned and corrupts their apparent coordinates.
 * Clamp against the next section/boundary so headers push out naturally.
 */
export function sidebarStickyBlockOffset(
  start: number,
  size: number,
  scrollOffset: number,
  nextBoundaryStart?: number,
): number {
  if (![start, size, scrollOffset].every(Number.isFinite)) return Number.isFinite(start) ? start : 0
  const pinned = Math.max(start, scrollOffset)
  if (nextBoundaryStart === undefined || !Number.isFinite(nextBoundaryStart)) return pinned
  return Math.max(start, Math.min(pinned, nextBoundaryStart - Math.max(0, size)))
}
