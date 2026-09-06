import { describe, expect, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { MAX_REPLAY_FRAMES, ringCapacity, subscriberCapacity } from "./handlers/event"

/**
 * The native route's replay ceiling and its subscriber queue capacity are
 * COUPLED, and the coupling is easy to break silently.
 *
 * A full replay window is enqueued SYNCHRONOUSLY, before the response body
 * stream is ever pulled. `makeByteBoundedSubscriberQueue.offer` does not drop
 * on overflow: `Queue.offerUnsafe` returning false sets `failed` and calls
 * `Queue.failCauseUnsafe(SubscriberOverflowError)`, so an over-capacity replay
 * FAILS THE STREAM. A reconnect more than `capacity` frames behind becomes a
 * hard disconnect instead of a replay or a gap.
 *
 * Before this was fixed the route had MAX_REPLAY_FRAMES = 4096 over a 256-item
 * queue. The two traps when testing this (found the hard way):
 *   - `take(accepted + 1)` HANGS FOREVER: a failed queue never yields again.
 *   - `take(accepted)` SUCCEEDS even when the queue is already failed, so a
 *     naive "offer N, drain N, expect success" test passes against the bug.
 * The overflow is therefore detected via the offer loop's refusal index.
 */
const attempt = (capacity: number, frames: number) =>
  Effect.gen(function* () {
    const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<{ sequence: number }>({
      capacity,
      maxBytes: 8 * 1024 * 1024,
      sizeOf: () => 1,
    })
    let accepted = 0
    let firstRefusal = -1
    for (let i = 0; i < frames; i++) {
      if (!subscriber.offer({ sequence: i })) {
        firstRefusal = i
        break
      }
      accepted += 1
    }
    // Drain exactly the accepted prefix -- never one more, or this hangs.
    const exit = yield* Stream.runCollect(Stream.take(subscriber.stream, accepted)).pipe(
      Effect.map((chunk) => chunk.length),
      Effect.exit,
    )
    return { accepted, firstRefusal, delivered: Exit.isSuccess(exit) ? exit.value : -1 }
  }).pipe(Effect.scoped)

describe("native route replay capacity", () => {
  test("the subscriber queue can hold a full replay window plus headroom", () => {
    // The invariant, stated against the exported constants rather than literals,
    // so raising the ceiling without the queue fails here.
    expect(subscriberCapacity).toBeGreaterThan(MAX_REPLAY_FRAMES)
    expect(subscriberCapacity).toBe(ringCapacity + 256)
    expect(MAX_REPLAY_FRAMES).toBe(ringCapacity)
  })

  test("a full replay window is accepted and drained", async () => {
    const result = await Effect.runPromise(attempt(subscriberCapacity, MAX_REPLAY_FRAMES))
    // Nothing refused: the window fits with room for live events.
    expect(result.firstRefusal).toBe(-1)
    expect(result.accepted).toBe(MAX_REPLAY_FRAMES)
    expect(result.delivered).toBe(MAX_REPLAY_FRAMES)
  })

  test("a window larger than the queue would fail the stream", async () => {
    // The regression this guards. With the pre-fix 256-item queue, the 257th
    // offer was refused and the queue was already failed.
    const overflow = await Effect.runPromise(attempt(256, MAX_REPLAY_FRAMES))
    expect(overflow.firstRefusal).toBe(256)
    expect(overflow.accepted).toBeLessThan(MAX_REPLAY_FRAMES)
  })
})
