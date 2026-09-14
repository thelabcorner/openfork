import { describe, expect, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { EventV2 } from "../src/event"
import { EventTrace } from "../src/event-trace"

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

  test("can reserve one legal large frame outside the ordinary backlog budget", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* EventV2.makeByteBoundedSubscriberQueue<string>({
            capacity: 8,
            maxBytes: 8,
            maxSingleFrameBytes: 10,
            sizeOf: (value) => value.length,
          })

          // The 10-byte authoritative frame does not consume the 8-byte
          // ordinary backlog budget. A second frame can therefore coexist with
          // it without turning one legal snapshot into an immediate disconnect.
          expect(queue.offer("0123456789")).toBe(true)
          expect(queue.offer("abcdefgh")).toBe(true)
          expect(queue.pendingBytes()).toBe(18)
          // Excluding the largest retained frame, backlog is now exactly 8.
          expect(queue.offer("x")).toBe(false)
        }),
      ),
    )
  })

  test("single-frame reserve still rejects an actually oversized frame", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* EventV2.makeByteBoundedSubscriberQueue<string>({
            capacity: 4,
            maxBytes: 8,
            maxSingleFrameBytes: 10,
            sizeOf: (value) => value.length,
          })
          expect(queue.offer("01234567890")).toBe(false)
        }),
      ),
    )
  })

  test("recomputes the reserved largest frame after it drains", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* EventV2.makeByteBoundedSubscriberQueue<string>({
            capacity: 8,
            maxBytes: 8,
            maxSingleFrameBytes: 10,
            sizeOf: (value) => value.length,
          })
          expect(queue.offer("0123456789")).toBe(true)
          expect(queue.offer("abcdefgh")).toBe(true)
          expect(yield* queue.take).toBe("0123456789")
          expect(queue.pendingBytes()).toBe(8)
          // The remaining 8-byte frame becomes the new reserved largest item,
          // so another 8 bytes of ordinary backlog can be admitted.
          expect(queue.offer("ABCDEFGH")).toBe(true)
          expect(queue.pendingBytes()).toBe(16)
        }),
      ),
    )
  })

  test("traces the event type, overflow branch and pending bytes", async () => {
    EventTrace.configure({
      directory: `${process.env.TMPDIR ?? "/tmp"}/opencode-event-trace-queue-test`,
      enabled: true,
    })
    EventTrace.reset()
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const oversize = yield* EventV2.makeByteBoundedSubscriberQueue<{ type: string; size: number }>({
              capacity: 2,
              maxBytes: 2,
              sizeOf: (value) => value.size,
              typeOf: (value) => value.type,
            })
            expect(oversize.offer({ type: "event.oversize", size: 3 })).toBe(false)

            const backpressure = yield* EventV2.makeByteBoundedSubscriberQueue<{ type: string }>({
              capacity: 1,
              maxBytes: 10,
              sizeOf: () => 1,
              typeOf: (value) => value.type,
            })
            expect(backpressure.offer({ type: "event.backpressure" })).toBe(true)
            expect(backpressure.offer({ type: "event.backpressure" })).toBe(false)
          }),
        ),
      )

      expect(EventTrace.state().recent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "queue.overflow",
            type: "event.oversize",
            branch: "oversize",
            size: 3,
            pendingBytes: 0,
          }),
          expect.objectContaining({
            phase: "queue.overflow",
            type: "event.backpressure",
            branch: "backpressure",
            size: 1,
            pendingBytes: 1,
          }),
        ]),
      )
    } finally {
      EventTrace.configure({ enabled: true })
      EventTrace.reset()
    }
  })
})
