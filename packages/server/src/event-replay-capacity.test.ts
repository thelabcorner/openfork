import { describe, expect, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import {
  MAX_REPLAY_BYTES,
  MAX_REPLAY_FRAMES,
  ringCapacity,
  ringMaxBytes,
  subscriberCapacity,
  subscriberFrameMaxBytes,
} from "./handlers/event"
import { estimateEventBytes } from "@opencode-ai/core/event-replay"

/** The subscriber is now LIVE-only. Replay is a pull-driven stream prefix. */
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
  test("replay limits match the ring while live queue sizing is independent", () => {
    expect(MAX_REPLAY_FRAMES).toBe(ringCapacity)
    expect(MAX_REPLAY_BYTES).toBe(ringMaxBytes)
    // This value is deliberately conservative for live bursts, but replay no
    // longer depends on it being larger than MAX_REPLAY_FRAMES.
    expect(subscriberCapacity).toBe(ringCapacity + 256)
  })

  test("live backlog still fails fast instead of silently dropping", async () => {
    const overflow = await Effect.runPromise(attempt(256, MAX_REPLAY_FRAMES))
    expect(overflow.firstRefusal).toBe(256)
    expect(overflow.accepted).toBeLessThan(MAX_REPLAY_FRAMES)
  })

  test("replay history cannot consume bytes needed by a near-budget live frame", async () => {
    const live = {
      sequence: 5000,
      event: {
        id: "evt_jumbo",
        type: "message.part.updated",
        data: { output: "x".repeat(ringMaxBytes - 256 * 1024) },
      },
    }
    const size = estimateEventBytes(live)
    expect(size).toBeLessThan(ringMaxBytes)

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<typeof live>({
            capacity: subscriberCapacity,
            maxBytes: ringMaxBytes,
            sizeOf: estimateEventBytes,
          })
          // Hundreds of replay frames may exist, but the route emits them from
          // Stream.fromIterable(replayPrefix), never through this queue.
          const replayPrefix = Array.from({ length: 300 }, (_, sequence) => ({ sequence, event: { type: "replay" } }))
          expect(replayPrefix).toHaveLength(300)
          expect(subscriber.pendingBytes()).toBe(0)
          const accepted = subscriber.offer(live)
          return { accepted, pending: subscriber.pendingBytes() }
        }),
      ),
    )

    expect(result.accepted).toBe(true)
    expect(result.pending).toBe(size)
  })

  test("one near-ring-limit live frame does not consume ordinary backlog headroom", async () => {
    const backlog = 1024 * 1024
    const jumbo = ringMaxBytes - 64 * 1024
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const subscriber = yield* EventV2.makeByteBoundedSubscriberQueue<{ size: number }>({
            capacity: subscriberCapacity,
            maxBytes: ringMaxBytes,
            maxSingleFrameBytes: subscriberFrameMaxBytes,
            sizeOf: (item) => item.size,
          })
          expect(subscriber.offer({ size: backlog })).toBe(true)
          // Under the old single-budget rule this failed because 1 MiB + ~7.94
          // MiB exceeded 8 MiB even though the jumbo frame was individually
          // legal. The transport now reserves one frame independently.
          expect(subscriber.offer({ size: jumbo })).toBe(true)
          return subscriber.pendingBytes()
        }),
      ),
    )
    expect(result).toBe(backlog + jumbo)
  })
})
