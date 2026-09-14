import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { it } from "../lib/effect"
import {
  MAX_REPLAY_FRAMES,
  SUBSCRIBER_CAPACITY,
  SUBSCRIBER_HEADROOM,
} from "../../src/server/routes/instance/httpapi/handlers/event"

// The queue is intentionally fail-fast for LIVE backlog. Replay no longer enters
// it; handlers emit replay as a pull-driven prefix before concatenating live.
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

describe("live subscriber queue", () => {
  it.effect("keeps conservative live headroom without depending on replay preload", () =>
    Effect.sync(() => {
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

      // The real handler remains generously sized for live bursts. This no
      // longer proves anything about replay, because replay bypasses the queue.
      const sized = yield* probe(SUBSCRIBER_CAPACITY, MAX_REPLAY_FRAMES)
      expect(sized.offered).toBe(MAX_REPLAY_FRAMES)
      expect(sized.drained).toBe(MAX_REPLAY_FRAMES)
    }),
  )
})
