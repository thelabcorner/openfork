import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { it } from "../lib/effect"
import {
  MAX_REPLAY_FRAMES,
  SUBSCRIBER_CAPACITY,
  SUBSCRIBER_HEADROOM,
} from "../../src/server/routes/instance/httpapi/handlers/event"

// Regression: subscriber capacity is coupled to the replay ceiling.
//
// A full replay window is enqueued SYNCHRONOUSLY inside `Stream.unwrap`, before
// the response body stream is ever pulled. `makeByteBoundedSubscriberQueue.offer`
// does NOT drop on overflow — `Queue.offerUnsafe` returning false sets `failed`
// and calls `Queue.failCauseUnsafe(SubscriberOverflowError)`, so an oversized
// replay fails the stream and a reconnect becomes a hard disconnect.
//
// Raising MAX_REPLAY_FRAMES without raising capacity is therefore a regression,
// not an improvement. The probe never drains past what was accepted: a failed
// queue can never produce another item, so `take(accepted + 1)` blocks forever —
// which is itself the symptom being guarded against.
/**
 * Assert the coupling against the EXPORTED constants rather than duplicated
 * literals. The capacity value is already correct; what matters is that a
 * future raise of MAX_REPLAY_FRAMES cannot silently reintroduce the bug.
 */
const probe = (capacity: number, replayFrames: number) =>
  Effect.gen(function* () {
    const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<{ sequence: number }>({
      capacity,
      maxBytes: 8 * 1024 * 1024,
      sizeOf: () => 1,
    })
    let offered = 0
    for (let i = 0; i < replayFrames; i++) {
      if (!subscriber.offer({ sequence: i })) break
      offered += 1
    }
    const drained = yield* Stream.runCollect(Stream.take(subscriber.stream, offered))
    return { offered, wanted: replayFrames, drained: drained.length }
  }).pipe(Effect.scoped)

describe("subscriber queue vs replay window", () => {
  it.effect("capacity exceeds the replay frame ceiling", () =>
    Effect.sync(() => {
      // The invariant that matters. Raising MAX_REPLAY_FRAMES without raising
      // the capacity fails here instead of in production.
      expect(SUBSCRIBER_CAPACITY).toBeGreaterThan(MAX_REPLAY_FRAMES)
      expect(SUBSCRIBER_CAPACITY).toBe(MAX_REPLAY_FRAMES + SUBSCRIBER_HEADROOM)
    }),
  )

  it.effect("offering past capacity fails the queue instead of dropping a frame", () =>
    Effect.gen(function* () {
      // The pre-raise configuration was incidentally safe: 128 < 256.
      const fits = yield* probe(256, 128)
      expect(fits.offered).toBe(128)

      // Past capacity: offer() refuses at the bound and has already failed the
      // queue. It does not drop the frame and carry on.
      const over = yield* probe(256, MAX_REPLAY_FRAMES)
      expect(over.offered).toBe(256)
      expect(over.offered).toBeLessThan(over.wanted)

      // The real handler's configuration: the whole ceiling fits and drains.
      const sized = yield* probe(SUBSCRIBER_CAPACITY, MAX_REPLAY_FRAMES)
      expect(sized.offered).toBe(MAX_REPLAY_FRAMES)
      expect(sized.drained).toBe(MAX_REPLAY_FRAMES)
    }),
  )
})
