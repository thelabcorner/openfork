import { describe, expect, test } from "bun:test"
import { createSidecarStatus } from "./sidecar-status"

describe("desktop sidecar status projection", () => {
  test("replays the latest state and then publishes changes", () => {
    const status = createSidecarStatus()
    status.set({ state: "suspected-hang", consecutiveFailures: 3, checkedAt: "2026-09-28T00:00:00.000Z" })
    const seen: string[] = []
    const unsubscribe = status.subscribe((value) => seen.push(value.state))
    expect(seen).toEqual(["suspected-hang"])
    status.set({ state: "healthy", consecutiveFailures: 0, checkedAt: "2026-09-28T00:00:05.000Z" })
    expect(seen).toEqual(["suspected-hang", "healthy"])
    unsubscribe()
  })
})