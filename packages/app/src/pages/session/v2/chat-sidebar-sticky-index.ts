/**
 * Sparse index of sticky section boundaries in the virtual sidebar.
 *
 * A virtualizer asks for the active sticky head on every scroll range update.
 * Backward-scanning all preceding rows makes that query O(distance to header),
 * which becomes particularly expensive with expanded multi-session clusters.
 * Rebuild this index only when the block structure changes, then resolve each
 * scroll query with a binary search over section/boundary markers.
 */
export type ChatSidebarStickyMarker = { index: number; section: boolean }

export function indexChatSidebarStickyHeaders(blocks: readonly { type: string }[]): ChatSidebarStickyMarker[] {
  const markers: ChatSidebarStickyMarker[] = []
  for (let index = 0; index < blocks.length; index++) {
    const type = blocks[index]?.type
    if (type === "section-head") markers.push({ index, section: true })
    else if (type === "oxp" || type === "empty" || type === "archived") {
      markers.push({ index, section: false })
    }
  }
  return markers
}

export function stickyChatSidebarHeader(markers: readonly ChatSidebarStickyMarker[], startIndex: number): number {
  if (!Number.isInteger(startIndex) || startIndex < 0) return -1
  let low = 0
  let high = markers.length
  while (low < high) {
    const middle = low + ((high - low) >>> 1)
    if (markers[middle]!.index <= startIndex) low = middle + 1
    else high = middle
  }
  const marker = markers[low - 1]
  return marker?.section ? marker.index : -1
}