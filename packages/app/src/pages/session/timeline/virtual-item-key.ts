import { createMemo, type Accessor } from "solid-js"
import { TimelineRow } from "./timeline-row"

/**
 * A function identity change is a TanStack measurement-cache dependency.
 * Keep the key callback stable for unrelated reactive changes (scroll, status,
 * tool output), but issue a fresh callback whenever the timeline projection
 * invalidates. That also handles equal-count reorders and removals correctly.
 *
 * Projection append paths may mutate their array in place; callers must pass
 * an accessor that NOTIFIES on those mutations (e.g. safeTimelineRows).
 */
export function createVirtualTimelineItemKey(
  projection: Accessor<readonly TimelineRow.TimelineRow[]>,
) {
  return createMemo(() => {
    const rows = projection()
    return (index: number) => {
      const row = rows[index]
      return row ? TimelineRow.key(row) : `removed:${index}`
    }
  })
}
