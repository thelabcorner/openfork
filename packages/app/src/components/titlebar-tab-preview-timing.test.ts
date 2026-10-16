import { describe, expect, test } from "bun:test"
import {
  TAB_PREVIEW_OPEN_DELAY,
  TAB_PREVIEW_SKIP_WINDOW,
  markTabPreviewClosed,
  tabPreviewIsWarm,
  tabPreviewOpenDelay,
} from "./titlebar-tab-preview-timing"

describe("titlebar preview hover streak", () => {
  test("cold hovers retain the existing 450ms delay", () => {
    // The module has not recorded any closure before this test.
    expect(tabPreviewIsWarm(-1)).toBe(false)
    expect(tabPreviewOpenDelay(-1)).toBe(TAB_PREVIEW_OPEN_DELAY)
  })

  test("neighbouring tabs open immediately, and the skip window expires exactly on its boundary", () => {
    markTabPreviewClosed(1000)
    expect(tabPreviewOpenDelay(1000)).toBe(0)
    expect(tabPreviewOpenDelay(1000 + TAB_PREVIEW_SKIP_WINDOW - 1)).toBe(0)
    expect(tabPreviewOpenDelay(1000 + TAB_PREVIEW_SKIP_WINDOW)).toBe(TAB_PREVIEW_OPEN_DELAY)
    expect(tabPreviewOpenDelay(999)).toBe(TAB_PREVIEW_OPEN_DELAY)
  })

  test("closing another preview extends the warm streak", () => {
    markTabPreviewClosed(2000)
    markTabPreviewClosed(2200)
    expect(tabPreviewOpenDelay(2201)).toBe(0)
    expect(tabPreviewOpenDelay(2200 + TAB_PREVIEW_SKIP_WINDOW)).toBe(TAB_PREVIEW_OPEN_DELAY)
  })
})