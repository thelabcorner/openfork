import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { TimelineRow } from "../src/pages/session/timeline/timeline-row"
import { createVirtualTimelineItemKey } from "../src/pages/session/timeline/virtual-item-key"

test("item key callback identity changes only when the row projection notifies", () => {
  createRoot((dispose) => {
    try {
      const original = new TimelineRow.UserMessage({ userMessageID: "a", anchor: true })
      const [rows, setRows] = createSignal<TimelineRow.TimelineRow[]>([original], { equals: false })
      const getKey = createVirtualTimelineItemKey(rows)
      const first = getKey()
      expect(first(0)).toBe("user-message:a")
      expect(first(1)).toBe("removed:1")
      for (let i = 0; i < 100; i++) expect(getKey()).toBe(first)

      // Content-only mutations don't change row descriptors or the callback.
      expect(getKey()).toBe(first)
      // A projection revision on a reused backing array MUST still replace it.
      setRows(rows())
      const sameArrayNewVersion = getKey()
      expect(sameArrayNewVersion).not.toBe(first)
      expect(sameArrayNewVersion(0)).toBe("user-message:a")

      const other = new TimelineRow.UserMessage({ userMessageID: "b", anchor: true })
      setRows([other])
      expect(getKey()).not.toBe(sameArrayNewVersion)
      expect(getKey()(0)).toBe("user-message:b")
      setRows([])
      expect(getKey()(0)).toBe("removed:0")
    } finally {
      dispose()
    }
  })
})
