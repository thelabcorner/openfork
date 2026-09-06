import { describe, expect, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { EventV2 } from "../src/event"
import { estimateEventBytes, EventReplayBuffer } from "../src/event-replay"

describe("oversized frame eviction is incremental, not a ring nuke", () => {
  test("one oversized payload drops only itself and keeps the retained window", () => {
    const buffer = new EventReplayBuffer<string>(8, { maxBytes: 10, sizeOf: (value) => value.length })
    buffer.append("a")
    buffer.append("b")
    buffer.append("c")
    buffer.append("d")

    const sequence = buffer.append("X".repeat(20))

    // The regression: this used to clear every frame, so size became 0.
    expect(buffer.size).toBe(4)
    expect(sequence).toBe(5)
    expect(buffer.latest()).toBe(5)
    // A cursor that has not reached the dropped sequence reports a gap for
    // that one position instead of being told it is fully up to date. The
    // dropped frame is undeliverable, so "up to date" would be a lie.
    expect(buffer.since(0)).toMatchObject({ kind: "gap", latest: 5, oldest: 5, requested: 0 })
    expect(buffer.since(4)).toMatchObject({ kind: "gap", latest: 5, oldest: 5, requested: 4 })
    // A cursor already at the dropped sequence replays normally -- the
    // retained window was never destroyed, which is the whole point.
    expect(buffer.since(5)).toMatchObject({ kind: "ok", latest: 5, frames: [] })
    // And the ring still holds the frames that predate the drop.
    buffer.append("e")
    expect(buffer.since(5)).toMatchObject({ kind: "ok", frames: [{ sequence: 6, event: "e" }] })
    expect(buffer.size).toBe(5)
  })

  test("a cursor before the dropped sequence is a gap, a cursor at or past it is not", () => {
    const buffer = new EventReplayBuffer<string>(8, { maxBytes: 10, sizeOf: (value) => value.length })
    buffer.append("a")
    buffer.append("b")
    buffer.append("X".repeat(20)) // sequence 3, dropped
    buffer.append("c") // sequence 4, retained

    // A client that has not seen sequence 3 can never receive it.
    expect(buffer.since(0)).toMatchObject({ kind: "gap", latest: 4, oldest: 3, requested: 0 })
    expect(buffer.since(1)).toMatchObject({ kind: "gap", latest: 4, oldest: 3, requested: 1 })
    expect(buffer.since(2)).toMatchObject({ kind: "gap", latest: 4, oldest: 3, requested: 2 })
    // A client already at 3 has seen the gap and replays normally.
    expect(buffer.since(3)).toMatchObject({ kind: "ok", frames: [{ sequence: 4, event: "c" }] })
  })

  test("one oversized payload cannot strand every connected client", () => {
    const buffer = new EventReplayBuffer<string>(64, { maxBytes: 1000, sizeOf: (value) => value.length })
    for (let index = 0; index < 50; index++) buffer.append(`event-${index}`)
    const before = buffer.size

    // The regression: this cleared the ring, so size became 0 and every
    // cursor -- including fully caught-up ones -- was unresumable.
    const dropped = buffer.append("Y".repeat(5000))
    expect(buffer.size).toBe(before)
    expect(buffer.size).toBeGreaterThan(0)

    // Clients already past the dropped sequence replay normally, which is
    // exactly what the nuke made impossible for them.
    expect(buffer.since(dropped)).toMatchObject({ kind: "ok" })
    // And the window keeps absorbing new events instead of being rebuilt.
    buffer.append("after")
    expect(buffer.since(dropped)).toMatchObject({ kind: "ok", frames: [{ sequence: dropped + 1 }] })
    expect(buffer.since(dropped)).toMatchObject({ kind: "ok", frames: [{ event: "after" }] })
  })

  test("hole markers do not accumulate once the window moves past them", () => {
    const buffer = new EventReplayBuffer<string>(4, { maxBytes: 10, sizeOf: (value) => value.length })
    buffer.append("a")
    buffer.append("Z".repeat(50)) // dropped, sequence 2
    buffer.append("b")
    buffer.append("c")
    buffer.append("d")
    // Capacity 4 evicted sequence 1..2, so the hole at 2 is behind the window
    // and the ordinary oldest-cursor check governs instead.
    expect(buffer.since(0)).toMatchObject({ kind: "gap", latest: 5, oldest: 2 })
  })
})

describe("replay result carries the byte total without re-estimating", () => {
  test("bytes sums the sizes recorded at append time", () => {
    const buffer = new EventReplayBuffer<string>(8, { maxBytes: 100, sizeOf: (value) => value.length })
    buffer.append("abc")
    buffer.append("de")
    const result = buffer.since(0)
    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") throw new Error("expected ok")
    expect(result.bytes).toBe(5)
    expect(buffer.byteSize).toBe(5)
  })

  test("bytes counts only the frames actually returned, after the filter", () => {
    const buffer = new EventReplayBuffer<string>(8, { maxBytes: 100, sizeOf: (value) => value.length })
    buffer.append("keep1")
    buffer.append("skip!")
    buffer.append("keep2")
    const all = buffer.since(0)
    const filtered = buffer.since(0, (event) => !event.startsWith("skip"))
    if (all.kind !== "ok" || filtered.kind !== "ok") throw new Error("expected ok")
    expect(all.bytes).toBe(15)
    expect(filtered.bytes).toBe(10)
    expect(filtered.frames.length).toBe(2)
  })

  test("the estimator is never called on the replay path", () => {
    let calls = 0
    const buffer = new EventReplayBuffer<string>(4096, {
      maxBytes: 1_000_000,
      sizeOf: (value) => {
        calls++
        return value.length
      },
    })
    for (let index = 0; index < 500; index++) buffer.append(`event-${index}`)
    const afterAppend = calls
    expect(afterAppend).toBe(500)

    // A transport replay decision must not re-estimate any frame. Before the
    // fix the handler called estimateEventBytes once per returned frame on a
    // freshly allocated wrapper object, so this count grew by frames.length.
    const result = buffer.since(100)
    if (result.kind !== "ok") throw new Error("expected ok")
    expect(result.frames.length).toBe(400)
    expect(result.bytes).toBeGreaterThan(0)
    expect(calls).toBe(afterAppend)

    buffer.since(0)
    buffer.since(250)
    expect(calls).toBe(afterAppend)
  })
})

describe("utf-8 byte accounting", () => {
  test("ascii is counted at one byte per character, not four", () => {
    const twoMiB = "x".repeat(2 * 1024 * 1024)
    expect(estimateEventBytes(twoMiB)).toBeLessThan(3 * 1024 * 1024)
    // The old 4x overcount billed this as 8 MiB and wiped the 8 MiB ring.
    expect(estimateEventBytes(twoMiB)).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  test("a 2 MiB tool result no longer trips an 8 MiB ring", () => {
    const buffer = new EventReplayBuffer<{ output: string }>(64, {
      maxBytes: 8 * 1024 * 1024,
      sizeOf: estimateEventBytes,
    })
    buffer.append({ output: "line of tool output\n".repeat(100_000) })
    buffer.append({ output: "another" })
    expect(buffer.size).toBe(2)
  })

  test("multi-byte characters are still counted at their encoded width", () => {
    const ascii = estimateEventBytes("a".repeat(1000))
    const cjk = estimateEventBytes("中".repeat(1000))
    const emoji = estimateEventBytes("😀".repeat(1000))
    expect(ascii).toBeLessThan(cjk)
    expect(cjk).toBeLessThan(emoji)
    expect(cjk).toBeGreaterThanOrEqual(3000)
    expect(emoji).toBeGreaterThanOrEqual(4000)
  })

  test("a genuinely oversized payload still saturates above the budget", () => {
    expect(estimateEventBytes("x".repeat(9 * 1024 * 1024))).toBeGreaterThan(8 * 1024 * 1024)
    const nested = { data: { properties: { output: { chunks: [{ text: "x".repeat(9 * 1024 * 1024) }] } } } }
    expect(estimateEventBytes(nested)).toBeGreaterThan(8 * 1024 * 1024)
  })
})

describe("replay window must fit the subscriber queue", () => {
  // A full replay is enqueued SYNCHRONOUSLY, before the response body stream is
  // pulled. offer() does NOT drop on overflow: Queue.offerUnsafe returning
  // false sets `failed` and fails the queue with SubscriberOverflowError, so an
  // over-capacity replay becomes a HARD DISCONNECT rather than a short replay
  // or a gap. Raising a MAX_REPLAY_FRAMES ceiling therefore requires raising
  // the subscriber queue capacity in the same change.
  //
  // This is the regression this file's author shipped and then caught: the
  // native route briefly had a 4096-frame ceiling over a 256-slot queue.
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
      // Drain EXACTLY the accepted prefix. A failed queue can never produce
      // another item, so taking accepted+1 blocks forever; and taking only the
      // accepted prefix SUCCEEDS even when the queue is already failed, so the
      // overflow is only detectable via `firstRefusal`. Assert on both: the
      // refusal index proves the bug, the drain proves the happy path works.
      const exit = yield* Stream.runCollect(Stream.take(subscriber.stream, accepted)).pipe(
        Effect.map((chunk) => `ok(${chunk.length})`),
        Effect.exit,
      )
      return { firstRefusal, accepted, result: Exit.isSuccess(exit) ? exit.value : "OVERFLOW" }
    }).pipe(Effect.scoped)

  test("offering a replay window past queue capacity fails the stream", async () => {
    // Pre-raise configuration: 128 frames into 256 slots was incidentally safe.
    const fits = await Effect.runPromise(attempt(256, 128))
    expect(fits.firstRefusal).toBe(-1)
    expect(fits.result).toBe("ok(128)")

    // The regression: a 4096-frame ceiling over a 256-slot queue. The 257th
    // offer is refused (firstRefusal), which is the observable proof -- offer()
    // does not drop and continue, it fails the queue.
    const overflow = await Effect.runPromise(attempt(256, 4096))
    expect(overflow.firstRefusal).toBe(256)
    expect(overflow.accepted).toBe(256)
    expect(overflow.accepted).toBeLessThan(4096)

    // The fix: capacity tracks the ceiling, with headroom for live events.
    const fixed = await Effect.runPromise(attempt(4096 + 256, 4096))
    expect(fixed.firstRefusal).toBe(-1)
    expect(fixed.result).toBe("ok(4096)")
  })
})
