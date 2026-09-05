import { describe, expect, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { EventV2 } from "../src/event"

describe("byte-bounded subscriber queue", () => {
  test("fails the subscriber when retained bytes exceed the limit", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* EventV2.makeByteBoundedSubscriberQueue<string>({
            capacity: 4,
            maxBytes: 2,
            sizeOf: (value) => value.length,
          })
          expect(queue.offer("ab")).toBe(true)
          expect(queue.offer("c")).toBe(false)
          const first = yield* queue.take
          const second = yield* queue.take.pipe(Effect.exit)
          return { first, second }
        }),
      ),
    )

    expect(result.first).toBe("ab")
    expect(Exit.isFailure(result.second)).toBe(true)
  })

  test("releases byte accounting when consumed through the stream view", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* EventV2.makeByteBoundedSubscriberQueue<string>({
            capacity: 2,
            maxBytes: 2,
            sizeOf: (value) => value.length,
          })
          expect(queue.offer("ab")).toBe(true)
          expect(Array.from(yield* queue.stream.pipe(Stream.take(1), Stream.runCollect))).toEqual(["ab"])
          expect(queue.pendingBytes()).toBe(0)
          expect(queue.offer("ab")).toBe(true)
        }),
      ),
    )
  })
})
