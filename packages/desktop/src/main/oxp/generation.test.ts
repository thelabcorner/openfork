import { describe, expect, test } from "bun:test"
import { OxpEndpointGenerationTracker } from "./generation"

describe("OXP desktop endpoint generation", () => {
  test("is stable for repeated state and monotonic across local endpoint restarts", () => {
    const tracker = new OxpEndpointGenerationTracker()
    const first = { state: "ready" as const, generation: 1, url: "http://127.0.0.1:1/mcp/a" }
    tracker.attach(1)
    expect(tracker.observe(1, first, 1)).toEqual({ accepted: true, generation: 1, changed: true })
    expect(tracker.observe(1, first, 1)).toEqual({ accepted: true, generation: 1, changed: false })
    expect(tracker.observe(1, { state: "stopped", generation: 1 }, 1)).toEqual({ accepted: true, changed: true })
    expect(tracker.observe(1, { state: "stopped", generation: 1 }, 1)).toEqual({ accepted: true, changed: false })
    expect(tracker.observe(1, { state: "ready", generation: 2, url: "http://127.0.0.1:2/mcp/b" }, 1)).toEqual({ accepted: true, generation: 2, changed: true })
  })

  test("treats a schema fingerprint change as a new endpoint identity", () => {
    const tracker = new OxpEndpointGenerationTracker()
    tracker.attach(1)
    const base = {
      state: "ready" as const,
      generation: 1,
      url: "http://127.0.0.1:1/mcp/a",
      schemaFingerprint: "a".repeat(64),
    }
    expect(tracker.observe(1, base, 1)).toEqual({
      accepted: true,
      generation: 1,
      changed: true,
    })
    expect(tracker.observe(1, base, 1)).toEqual({
      accepted: true,
      generation: 1,
      changed: false,
    })
    expect(
      tracker.observe(
        1,
        { ...base, schemaFingerprint: "b".repeat(64) },
        1,
      ),
    ).toEqual({
      accepted: true,
      generation: 2,
      changed: true,
    })
    expect(tracker.current()).toBe(2)
  })

  test("does not reuse a generation when a replacement sidecar starts again at generation one", () => {
    const tracker = new OxpEndpointGenerationTracker()
    expect(tracker.observe(7, { state: "ready", generation: 1, url: "http://127.0.0.1:1/mcp/a" }, 1)).toEqual({ accepted: true, generation: 1, changed: true })
    tracker.attach(8)
    expect(tracker.observe(8, { state: "ready", generation: 1, url: "http://127.0.0.1:2/mcp/c" }, 1)).toEqual({ accepted: true, generation: 2, changed: true })
    expect(tracker.current()).toBe(2)
  })

  test("rejects stale snapshots from the current sidecar by config or endpoint generation", () => {
    const tracker = new OxpEndpointGenerationTracker()
    tracker.attach(3)
    expect(tracker.observe(3, { state: "ready", generation: 4, url: "http://127.0.0.1:4/mcp/d" }, 9).accepted).toBe(true)
    expect(tracker.observe(3, { state: "ready", generation: 3, url: "http://127.0.0.1:3/mcp/c" }, 9)).toEqual({ accepted: false, changed: false })
    expect(tracker.observe(3, { state: "ready", generation: 4, url: "http://127.0.0.1:4/mcp/d" }, 8)).toEqual({ accepted: false, changed: false })
  })

  test("never rolls authority backward to an older sidecar epoch", () => {
    const tracker = new OxpEndpointGenerationTracker()
    tracker.attach(11)
    expect(tracker.observe(11, { state: "ready", generation: 2, url: "http://127.0.0.1:2/mcp/current" }, 5)).toEqual({
      accepted: true,
      generation: 1,
      changed: true,
    })
    expect(tracker.observe(10, { state: "ready", generation: 999, url: "http://127.0.0.1:9/mcp/stale" }, 999)).toEqual({
      accepted: false,
      changed: false,
    })
    expect(tracker.current()).toBe(1)
  })
})
