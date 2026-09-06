import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { estimateEventBytes } from "@opencode-ai/core/event-replay"
import { MAX_REPLAY_BYTES, MAX_REPLAY_FRAMES, subscriberCapacity } from "./handlers/event"

// The replay byte guard must agree with the ring's own retention budget. The
// ring can never produce more than it retains, so a guard below ringMaxBytes
// means holding bytes we refuse to send and forcing a full snapshot hydration
// for a window the server is already retaining -- the same "second ceiling
// defeats the primary capacity" defect as a frame ceiling below the ring.
const RING_MAX_BYTES = 8 * 1024 * 1024

describe("replay byte guard vs ring byte budget", () => {
  test("the byte guard matches the ring's retention budget", () => {
    expect(MAX_REPLAY_BYTES).toBe(RING_MAX_BYTES)
  })

  test("a near-ring-full replay is now accepted, not refused", () => {
    // 4096 frames of ~1.5 KiB = ~6 MiB, inside the ring's 8 MiB budget: this
    // used to be refused at the old 4 MiB guard, forcing a hydration; it is now
    // accepted because the guard matches the ring.
    const payload = { id: "evt_1", type: "session.text.delta", data: { text: "x".repeat(1500) } }
    const perFrame = estimateEventBytes(payload)
    const total = perFrame * MAX_REPLAY_FRAMES
    expect(total).toBeLessThanOrEqual(RING_MAX_BYTES)
    expect(total).toBeLessThanOrEqual(MAX_REPLAY_BYTES)
  })

  test("the subscriber queue holds that same ~6 MiB window", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<{ sequence: number }>({
            capacity: subscriberCapacity,
            maxBytes: RING_MAX_BYTES,
            sizeOf: () => 1,
          })
          let refused = -1
          for (let i = 0; i < MAX_REPLAY_FRAMES; i++) {
            if (!subscriber.offer({ sequence: i })) {
              refused = i
              break
            }
          }
          return refused
        }),
      ),
    )
    expect(result).toBe(-1)
  })

  test("an 8 MiB replay fits the queue (the guard's upper bound)", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<{ sequence: number }>({
            capacity: subscriberCapacity,
            maxBytes: RING_MAX_BYTES,
            sizeOf: () => MAX_REPLAY_BYTES,
          })
          // One frame carrying the entire 8 MiB budget: the queue must accept it
          // at empty pending (the check is pending > maxBytes - size).
          const ok = subscriber.offer({ sequence: 0 })
          return ok
        }),
      ),
    )
    expect(result).toBe(true)
  })
})
