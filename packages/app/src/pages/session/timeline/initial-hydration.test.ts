import { describe, expect, test } from "bun:test"
import { createInitialTimelineHydrationGate } from "./initial-hydration"

describe("session timeline initial-only loading policy", () => {
  test("allows a loader on a genuinely empty, unhydrated first open", () => {
    const gate = createInitialTimelineHydrationGate()
    expect(gate.eligible("local/session-a", false, false)).toBe(true)
    expect(gate.eligible("local/session-a", false, false)).toBe(true)
  })

  test("the first paint permanently disarms loading despite subsequent history hydration", () => {
    const gate = createInitialTimelineHydrationGate()
    expect(gate.eligible("local/session-a", false, false)).toBe(true)
    expect(gate.eligible("local/session-a", false, true)).toBe(false)
    expect(gate.eligible("local/session-a", false, false)).toBe(false) // history pagination/cache miss
    expect(gate.eligible("local/session-a", true, false)).toBe(false)  // repair completes
    expect(gate.eligible("local/session-a", false, false)).toBe(false) // refetch starts
  })

  test("empty sessions disarm on initial hydration completion without requiring a user message", () => {
    const gate = createInitialTimelineHydrationGate()
    expect(gate.eligible("local/empty", false, false)).toBe(true)
    expect(gate.eligible("local/empty", true, false)).toBe(false)
    expect(gate.eligible("local/empty", false, false)).toBe(false)
  })

  test("reopening a previously hydrated session cannot trigger a new initial loader", () => {
    const gate = createInitialTimelineHydrationGate()
    gate.eligible("local/session-a", true, false)
    gate.eligible("local/session-b", true, true)
    expect(gate.eligible("local/session-a", false, false)).toBe(false)
    expect(gate.eligible("local/session-b", false, false)).toBe(false)
    expect(gate.eligible("local/session-c", false, false)).toBe(true)
  })

  test("session identity is scoped by server and never leaks to an unrelated session", () => {
    const gate = createInitialTimelineHydrationGate()
    gate.eligible("server-a\0same-id", true, false)
    expect(gate.eligible("server-a\0same-id", false, false)).toBe(false)
    expect(gate.eligible("server-b\0same-id", false, false)).toBe(true)
    expect(gate.eligible(undefined, false, false)).toBe(false)
  })

  test("never re-arms an earlier session after many other sessions have hydrated", () => {
    const gate = createInitialTimelineHydrationGate()
    gate.eligible("first", true, false)
    for (let index = 0; index < 2048; index++) {
      gate.eligible(`later-${index}`, true, false)
    }
    expect(gate.eligible("first", false, false)).toBe(false)
    expect(gate.eligible("later-0", false, false)).toBe(false)
    expect(gate.eligible("new", false, false)).toBe(true)
  })
})
