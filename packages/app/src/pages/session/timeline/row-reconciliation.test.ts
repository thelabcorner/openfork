import { expect, test } from "bun:test"
import { reuseTimelineRows, syncTimelineRows } from "./row-reconciliation"
import { createTimelineRowIndexes, indexTimelineRow, removeTimelineRowIndex } from "./row-index"
import { TimelineRow } from "./timeline-row"

test("same-array reconciliation preserves rows before a later tail replacement", () => {
  const first = new TimelineRow.UserMessage({ userMessageID: "user-1", anchor: true })
  const second = new TimelineRow.UserMessage({ userMessageID: "user-2", anchor: true })
  const rows = [first, second]
  const indexes = createTimelineRowIndexes()
  rows.forEach((row, index) => indexTimelineRow(indexes, row, index))

  const unchanged = reuseTimelineRows(rows, [
    new TimelineRow.UserMessage({ userMessageID: "user-1", anchor: true }),
    new TimelineRow.UserMessage({ userMessageID: "user-2", anchor: true }),
  ])
  expect(unchanged).toBe(rows)
  syncTimelineRows(rows, unchanged)

  const start = rows.length - 1
  expect(start).toBe(1)
  removeTimelineRowIndex(indexes, rows[start]!)
  rows.length = start
  const replacement = new TimelineRow.UserMessage({ userMessageID: "user-2", anchor: false })
  rows.push(replacement)
  indexTimelineRow(indexes, replacement, start)

  expect(rows).toEqual([first, replacement])
  expect(indexes.rowByKey.get("user-message:user-2")).toBe(replacement)
  expect(indexes.rowIndexByKey.get("user-message:user-2")).toBe(1)
  expect(indexes.messageRowIndex.get("user-2")).toBe(1)
})

test("aligned row topology reuses all unchanged instances and changes only the edited row", () => {
  const previous = Array.from({ length: 120 }, (_, index) =>
    new TimelineRow.UserMessage({ userMessageID: `user-${index}`, anchor: true }),
  )
  const next = previous.map((row, index) =>
    new TimelineRow.UserMessage({ userMessageID: `user-${index}`, anchor: index === 52 ? false : true }),
  )
  const reconciled = reuseTimelineRows(previous, next)
  expect(reconciled).not.toBe(previous)
  expect(reconciled).toHaveLength(previous.length)
  for (let index = 0; index < previous.length; index++)
    expect(reconciled[index]).toBe(index === 52 ? next[index] : previous[index])
  expect(reuseTimelineRows(previous, previous)).toBe(previous)
})

test("reordered equal-length rows take key-aware reconciliation, not positional reuse", () => {
  const a = new TimelineRow.UserMessage({ userMessageID: "a", anchor: true })
  const b = new TimelineRow.UserMessage({ userMessageID: "b", anchor: true })
  const previous = [a, b]
  const result = reuseTimelineRows(previous, [
    new TimelineRow.UserMessage({ userMessageID: "b", anchor: true }),
    new TimelineRow.UserMessage({ userMessageID: "a", anchor: true }),
  ])
  expect(result).toEqual([b, a])
  expect(result[0]).toBe(b)
  expect(result[1]).toBe(a)
})
