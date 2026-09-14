import { describe, expect, test } from "bun:test"
import { estimateEventBytes } from "@opencode-ai/core/event-replay"
import { MAX_REPLAY_BYTES, MAX_REPLAY_FRAMES, ringMaxBytes } from "./handlers/event"

// The replay byte guard must agree with the ring's own retention budget. The
// ring can never produce more than it retains, so a guard below ringMaxBytes
// means holding bytes we refuse to send and forcing a full snapshot hydration
// for a window the server is already retaining -- the same "second ceiling
// defeats the primary capacity" defect as a frame ceiling below the ring.
describe("replay byte guard vs ring byte budget", () => {
  test("the byte guard matches the ring's retention budget", () => {
    expect(MAX_REPLAY_BYTES).toBe(ringMaxBytes)
  })

  test("a near-ring-full replay is now accepted, not refused", () => {
    // 4096 frames of ~1.5 KiB = ~6 MiB, inside the ring's 8 MiB budget: this
    // used to be refused at the old 4 MiB guard, forcing a hydration; it is now
    // accepted because the guard matches the ring.
    const payload = { id: "evt_1", type: "session.text.delta", data: { text: "x".repeat(1500) } }
    const perFrame = estimateEventBytes(payload)
    const total = perFrame * MAX_REPLAY_FRAMES
    expect(total).toBeLessThanOrEqual(ringMaxBytes)
    expect(total).toBeLessThanOrEqual(MAX_REPLAY_BYTES)
  })
})
