import { expect, test } from "bun:test"
import { createTimelineRowIndexes, indexTimelineRow, removeTimelineRowIndex, truncateTimelineRowIndexes } from "./row-index"
import { TimelineRow } from "./timeline-row"

const assistantPart = (partID: string) =>
  new TimelineRow.AssistantPart({
    userMessageID: "user-1",
    group: {
      type: "part",
      key: partID,
      ref: { messageID: "assistant-1", partID },
      refs: [],
    } as any,
    previousAssistantPart: partID !== "part-1",
  })

test("tail replacement removes stale keys and preserves exact per-message row indexes", () => {
  const indexes = createTimelineRowIndexes()
  const user = new TimelineRow.UserMessage({ userMessageID: "user-1", anchor: true })
  const first = assistantPart("part-1")
  const second = assistantPart("part-2")
  const oldRows = [user, first, second]
  oldRows.forEach((row, index) => indexTimelineRow(indexes, row, index))

  for (const row of oldRows) removeTimelineRowIndex(indexes, row)
  const replacement = [new TimelineRow.UserMessage({ userMessageID: "user-1", anchor: true }), assistantPart("part-3")]
  replacement.forEach((row, offset) => indexTimelineRow(indexes, row, offset))

  expect(indexes.rowByKey.has("assistant-part:user-1:part-1")).toBe(false)
  expect(indexes.rowByKey.has("assistant-part:user-1:part-2")).toBe(false)
  expect(indexes.rowByKey.get("assistant-part:user-1:part-3")).toBe(replacement[1])
  expect(indexes.rowIndexByKey.get("assistant-part:user-1:part-3")).toBe(1)
  expect(indexes.messageRowIndex.get("user-1")).toBe(0)
  expect(indexes.messageRowIndices.get("user-1")).toEqual([0, 1])
  expect(indexes.messageLastRowIndex.get("user-1")).toBe(1)
  expect(indexes.lastAssistantGroupKey.get("user-1")).toBe("part-3")
})

test("bulk suffix removal agrees with a fresh full index on interleaved owners", () => {
  const owners = ["user-1", "user-2", "user-3", "user-4"]
  const rows = Array.from({ length: 160 }, (_, index) => {
    const owner = owners[(index * 17 + Math.floor(index / 7)) % owners.length]!
    if (index % 11 === 0 || index % 13 === 0) return new TimelineRow.ContextMessage({
      messageID: `context-${index}`, kind: "system", preview: "", text: "",
    })
    return new TimelineRow.AssistantPart({
      userMessageID: owner,
      group: { type: "part", key: `part-${index}`, ref: { messageID: "assistant", partID: `part-${index}` }, refs: [] } as any,
      previousAssistantPart: true,
    })
  })
  for (let cut = 0; cut <= rows.length; cut++) {
    const indexes = createTimelineRowIndexes()
    const expected = createTimelineRowIndexes()
    rows.forEach((row, index) => indexTimelineRow(indexes, row, index))
    rows.slice(0, cut).forEach((row, index) => indexTimelineRow(expected, row, index))
    truncateTimelineRowIndexes(indexes, rows, cut)
    for (const field of [
      "rowByKey", "rowIndexByKey", "messageRowIndex",
      "messageRowIndices", "messageLastRowIndex", "lastAssistantGroupKey",
    ] as const) {
      expect([...indexes[field].entries()]).toEqual([...expected[field].entries()])
    }
  }
})

test("suffix replacement restores owner indexes without touching prefix row identities", () => {
  const rows = [
    new TimelineRow.UserMessage({ userMessageID: "stable", anchor: true }),
    new TimelineRow.AssistantPart({
      userMessageID: "stable",
      group: { type: "part", key: "a", ref: { messageID: "a", partID: "a" }, refs: [] } as any,
      previousAssistantPart: false,
    }),
    assistantPart("old-1"),
    assistantPart("old-2"),
  ]
  const indexes = createTimelineRowIndexes()
  rows.forEach((row, index) => indexTimelineRow(indexes, row, index))
  truncateTimelineRowIndexes(indexes, rows, 2)
  rows.length = 2
  rows.push(assistantPart("replacement"))
  indexTimelineRow(indexes, rows[2]!, 2)
  expect(indexes.rowByKey.get("user-message:stable")).toBe(rows[0])
  expect(indexes.lastAssistantGroupKey.get("stable")).toBe("a")
  expect(indexes.lastAssistantGroupKey.get("user-1")).toBe("replacement")
  expect(indexes.messageRowIndices.get("stable")).toEqual([0, 1])
  expect(indexes.messageRowIndices.get("user-1")).toEqual([2])
  expect(indexes.rowByKey.has("assistant-part:user-1:old-2")).toBe(false)
})

test("suffix bounds are checked and a no-op does not mutate any maps", () => {
  const indexes = createTimelineRowIndexes()
  const row = new TimelineRow.UserMessage({ userMessageID: "user", anchor: true })
  indexTimelineRow(indexes, row, 0)
  expect(() => truncateTimelineRowIndexes(indexes, [row], -1)).toThrow(RangeError)
  expect(() => truncateTimelineRowIndexes(indexes, [row], 2)).toThrow(RangeError)
  truncateTimelineRowIndexes(indexes, [row], 1)
  expect(indexes.rowByKey.get("user-message:user")).toBe(row)
})
