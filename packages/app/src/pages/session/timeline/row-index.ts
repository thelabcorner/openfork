import { TimelineRow } from "./timeline-row"

export type TimelineRowIndexes = {
  rowByKey: Map<string, TimelineRow.TimelineRow>
  rowIndexByKey: Map<string, number>
  messageRowIndex: Map<string, number>
  messageRowIndices: Map<string, number[]>
  messageLastRowIndex: Map<string, number>
  lastAssistantGroupKey: Map<string, string>
}

export function createTimelineRowIndexes(): TimelineRowIndexes {
  return {
    rowByKey: new Map(),
    rowIndexByKey: new Map(),
    messageRowIndex: new Map(),
    messageRowIndices: new Map(),
    messageLastRowIndex: new Map(),
    lastAssistantGroupKey: new Map(),
  }
}

export function clearTimelineRowIndexes(indexes: TimelineRowIndexes) {
  indexes.rowByKey.clear()
  indexes.rowIndexByKey.clear()
  indexes.messageRowIndex.clear()
  indexes.messageRowIndices.clear()
  indexes.messageLastRowIndex.clear()
  indexes.lastAssistantGroupKey.clear()
}

export function indexTimelineRow(indexes: TimelineRowIndexes, row: TimelineRow.TimelineRow, index: number) {
  const key = TimelineRow.key(row)
  indexes.rowByKey.set(key, row)
  indexes.rowIndexByKey.set(key, index)
  const id = row._tag === "ContextMessage" ? row.messageID : "userMessageID" in row ? row.userMessageID : undefined
  if (!id) return
  if (!indexes.messageRowIndex.has(id)) indexes.messageRowIndex.set(id, index)
  const list = indexes.messageRowIndices.get(id)
  if (list) list.push(index)
  else indexes.messageRowIndices.set(id, [index])
  indexes.messageLastRowIndex.set(id, index)
  if (row._tag === "AssistantPart") indexes.lastAssistantGroupKey.set(id, row.group.key)
}

export function removeTimelineRowIndex(indexes: TimelineRowIndexes, row: TimelineRow.TimelineRow) {
  const key = TimelineRow.key(row)
  const rowIndex = indexes.rowIndexByKey.get(key)
  indexes.rowByKey.delete(key)
  indexes.rowIndexByKey.delete(key)
  const id = row._tag === "ContextMessage" ? row.messageID : "userMessageID" in row ? row.userMessageID : undefined
  if (!id) return
  const indices = indexes.messageRowIndices.get(id)
  if (!indices) return
  const at = indices.indexOf(rowIndex ?? -1)
  if (at >= 0) indices.splice(at, 1)
  if (indices.length === 0) {
    indexes.messageRowIndices.delete(id)
    indexes.messageRowIndex.delete(id)
    indexes.messageLastRowIndex.delete(id)
    indexes.lastAssistantGroupKey.delete(id)
    return
  }
  indexes.messageRowIndex.set(id, indices[0]!)
  indexes.messageRowIndices.set(id, indices)
  indexes.messageLastRowIndex.set(id, indices.at(-1)!)
  if (row._tag === "AssistantPart" && indexes.lastAssistantGroupKey.get(id) === row.group.key) {
    indexes.lastAssistantGroupKey.delete(id)
  }
}

/**
 * Remove an indexed contiguous suffix in O(removedRows + sum(log rowsPerOwner)).
 *
 * Repeated removeTimelineRowIndex() calls search and splice the same owner
 * array on every removed row (quadratic for one enormous assistant turn).
 * Index lists are sorted, so one lower-bound search and one length assignment
 * per affected owner preserve the prefix without moving its elements.
 */
export function truncateTimelineRowIndexes(
  indexes: TimelineRowIndexes,
  rows: readonly TimelineRow.TimelineRow[],
  start: number,
) {
  if (!Number.isSafeInteger(start) || start < 0 || start > rows.length)
    throw new RangeError("Timeline row suffix start is out of bounds")
  if (start === rows.length) return
  // A single-turn transcript replaces its entire projection at start=0.
  // All maps are invalidated in one operation; individual key deletions would
  // needlessly traverse every old row and populate an owner Set.
  if (start === 0) {
    clearTimelineRowIndexes(indexes)
    return
  }
  const changed = new Set<string>()
  for (let index = start; index < rows.length; index++) {
    const row = rows[index]!
    const key = TimelineRow.key(row)
    indexes.rowByKey.delete(key)
    indexes.rowIndexByKey.delete(key)
    const id = row._tag === "ContextMessage" ? row.messageID : "userMessageID" in row ? row.userMessageID : undefined
    if (id) changed.add(id)
  }
  for (const id of changed) {
    const positions = indexes.messageRowIndices.get(id)
    if (!positions) continue
    let lo = 0
    let hi = positions.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (positions[mid]! < start) lo = mid + 1
      else hi = mid
    }
    positions.length = lo
    if (!lo) {
      indexes.messageRowIndices.delete(id)
      indexes.messageRowIndex.delete(id)
      indexes.messageLastRowIndex.delete(id)
      indexes.lastAssistantGroupKey.delete(id)
      continue
    }
    indexes.messageRowIndex.set(id, positions[0]!)
    indexes.messageLastRowIndex.set(id, positions[lo - 1]!)
    // The most recent surviving AssistantPart determines the group key, even
    // if the removed suffix contained more recent context/other row types.
    let lastGroup: string | undefined
    for (let at = lo - 1; at >= 0; at--) {
      const row = rows[positions[at]!]!
      if (row._tag !== "AssistantPart") continue
      lastGroup = row.group.key
      break
    }
    if (lastGroup === undefined) indexes.lastAssistantGroupKey.delete(id)
    else indexes.lastAssistantGroupKey.set(id, lastGroup)
  }
}
