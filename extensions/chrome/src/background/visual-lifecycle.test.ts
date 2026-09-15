import { describe, expect, test } from "bun:test"
import { VisualRequestTracker, abortVisualRequestsForTab } from "./visual-lifecycle"

describe("Chrome visual request lifecycle", () => {
  test("admits visual requests concurrently across tabs but never twice on one tab", () => {
    const tracker = new VisualRequestTracker()
    expect(tracker.tryTrack("req-a", 7)).toBe(true)
    expect(tracker.tryTrack("req-b", 8)).toBe(true)
    expect(tracker.tryTrack("req-c", 7)).toBe(false)

    expect(tracker.tabId("req-b")).toBe(8)
    expect(tracker.requestIdsForTab(7)).toEqual(["req-a"])
    tracker.untrack("req-a")
    expect(tracker.tryTrack("req-c", 7)).toBe(true)
    expect(tracker.requestIdsForTab(7)).toEqual(["req-c"])
    expect(tracker.size).toBe(2)
  })

  test("navigation/tab-loss fanout aborts every visual flight on only that tab", async () => {
    const tracker = new VisualRequestTracker()
    tracker.tryTrack("req-a", 7)
    tracker.tryTrack("req-b", 8)
    const sent: Array<{ tabId: number; requestId: string }> = []

    const count = await abortVisualRequestsForTab(tracker, 7, "navigation", async (tabId, requestId) => {
      sent.push({ tabId, requestId })
      if (requestId === "req-a") throw new Error("content context already gone")
    })

    expect(count).toBe(1)
    expect(sent).toEqual([{ tabId: 7, requestId: "req-a" }])
    // Listener-driven abort does not untrack early. The owning dispatch finally
    // block remains authoritative for terminal cleanup even when sendMessage
    // races a navigation and cannot reach the old content context.
    expect(tracker.size).toBe(2)
    expect(tracker.interruption("req-a")).toBe("navigation")
    expect(tracker.interruption("req-b")).toBeUndefined()
  })

  test("first interruption reason is sticky until the owning dispatch untracks", () => {
    const tracker = new VisualRequestTracker()
    tracker.tryTrack("req", 9)
    expect(tracker.interrupt("req", "caller-abort")).toBe(true)
    expect(tracker.interrupt("req", "tab-removed")).toBe(true)
    expect(tracker.interruption("req")).toBe("caller-abort")
    tracker.untrack("req")
    expect(tracker.interruption("req")).toBeUndefined()
  })
})
