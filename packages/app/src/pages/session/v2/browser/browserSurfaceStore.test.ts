import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { browserSurfaceStore } from "./browserSurfaceStore"

const viewport = {
  mode: "fill" as const,
  width: null,
  height: null,
  presetId: null,
  orientation: "portrait" as const,
}

test("surface-store writes are value-deduped and preserve entry identity", () =>
  createRoot((dispose) => {
    try {
      browserSurfaceStore.clear("dedupe")
      browserSurfaceStore.setViewport("dedupe", viewport)
      const before = browserSurfaceStore.get("dedupe")
      expect(before).not.toBeNull()

      browserSurfaceStore.setViewport("dedupe", { ...viewport })
      expect(browserSurfaceStore.get("dedupe")).toBe(before)

      browserSurfaceStore.presentRect("dedupe", { x: 0, y: 0, width: 800, height: 600 })
      const afterRect = browserSurfaceStore.get("dedupe")
      browserSurfaceStore.presentRect("dedupe", { x: 0, y: 0, width: 800, height: 600 })
      expect(browserSurfaceStore.get("dedupe")).toBe(afterRect)
    } finally {
      browserSurfaceStore.clear("dedupe")
      dispose()
    }
  }),
)

test("clear deletes one keyed surface without rebuilding unrelated entries", () =>
  createRoot((dispose) => {
    try {
      browserSurfaceStore.clear("clear-a")
      browserSurfaceStore.clear("clear-b")
      browserSurfaceStore.setVisible("clear-a", true)
      browserSurfaceStore.setVisible("clear-b", true)

      const mapBefore = browserSurfaceStore.byTabId
      const bBefore = browserSurfaceStore.get("clear-b")
      browserSurfaceStore.clear("clear-a")

      expect(browserSurfaceStore.byTabId).toBe(mapBefore)
      expect(browserSurfaceStore.get("clear-a")).toBeNull()
      expect(browserSurfaceStore.get("clear-b")).toBe(bBefore)
    } finally {
      browserSurfaceStore.clear("clear-a")
      browserSurfaceStore.clear("clear-b")
      dispose()
    }
  }),
)
