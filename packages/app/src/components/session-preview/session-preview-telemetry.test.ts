import { expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { previewTelemetryIDs, samePreviewTelemetryIDs } from "./session-preview-telemetry"

const item = (id: string) => ({ item: { row: { row: { id } } } })

test("telemetry projection deduplicates repeated membership and the header identity", () => {
  expect(previewTelemetryIDs([item("a"), item("b"), item("a")], "b")).toEqual(["a", "b"])
  expect(previewTelemetryIDs([item("a"), {}, item("b")], "c")).toEqual(["a", "b", "c"])
  expect(previewTelemetryIDs([], "header")).toEqual(["header"])
  expect(previewTelemetryIDs([], undefined)).toEqual([])
  expect(samePreviewTelemetryIDs(["a", "b"], ["a", "b"])).toBe(true)
  expect(samePreviewTelemetryIDs(["a", "b"], ["b", "a"])).toBe(false)
  expect(samePreviewTelemetryIDs(["a"], ["a", "b"])).toBe(false)
})

test("virtual-measurement changes cannot retrigger telemetry bootstrap for unchanged visible IDs", () => {
  createRoot((dispose) => {
    const [rows, setRows] = createSignal([item("a"), item("b")])
    const ids = createMemo(() => previewTelemetryIDs(rows(), "header"), undefined, {
      equals: samePreviewTelemetryIDs,
    })
    try {
      const initial = ids()
      setRows([item("a"), item("b")])
      expect(ids()).toBe(initial)
      setRows([item("b"), item("a")])
      expect(ids()).not.toBe(initial)
      expect(ids()).toEqual(["b", "a", "header"])
    } finally {
      dispose()
    }
  })
})