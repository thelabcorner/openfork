import { describe, expect, test } from "bun:test"
import {
  coalesceEventBatch,
  createEventDeltaAccumulator,
  createEventCoalescer,
  eventDeltaKey,
  mergeEventDeltas,
} from "@opencode-ai/core/event-coalescer"

type TestEvent = {
  id: string
  type: string
  data: Record<string, unknown>
}

const delta = (value: string, id = value): TestEvent => ({
  id,
  type: "session.text.delta",
  data: { sessionID: "session", assistantMessageID: "message", ordinal: 0, delta: value },
})

describe("event coalescer", () => {
  test("coalesces live fragments and flushes them before a lifecycle barrier", () => {
    const output: TestEvent[] = []
    const coalescer = createEventCoalescer<TestEvent>((event) => {
      output.push(event)
    }, {
      keyOf: eventDeltaKey,
      merge: mergeEventDeltas,
    })

    coalescer.offer(delta("hello ", "one"))
    coalescer.offer(delta("world", "two"))
    expect(output).toHaveLength(0)
    coalescer.offer({ id: "end", type: "session.text.ended", data: { sessionID: "session" } })

    expect(output.map((event) => event.type)).toEqual(["session.text.delta", "session.text.ended"])
    expect(output[0]?.data.delta).toBe("hello world")
    coalescer.dispose()
  })

  test("keeps each merged fragment bounded without losing text", () => {
    const output: TestEvent[] = []
    const coalescer = createEventCoalescer<TestEvent>(
      (event) => {
        output.push(event)
      },
      { keyOf: eventDeltaKey, merge: mergeEventDeltas },
    )
    const fragment = "x".repeat(16 * 1024)
    for (let i = 0; i < 5; i++) coalescer.offer(delta(fragment, String(i)))
    coalescer.flush()

    expect(output.length).toBeGreaterThan(1)
    expect(output.every((event) => (event.data.delta as string).length <= 64 * 1024)).toBe(true)
    expect(output.map((event) => event.data.delta as string).join("")).toBe(fragment.repeat(5))
    coalescer.dispose()
  })

  test("stops scheduling after a failed subscriber", () => {
    const output: Array<unknown> = []
    const coalescer = createEventCoalescer(
      (event: unknown) => {
        output.push(event)
        return false
      },
      { keyOf: eventDeltaKey, merge: mergeEventDeltas },
    )
    coalescer.offer(delta("one"))
    coalescer.flush()
    coalescer.offer(delta("two"))
    coalescer.flush()
    expect(output).toHaveLength(1)
    coalescer.dispose()
  })

  test("treats unannotated event types as barriers", () => {
    const event = { type: "future.delta", data: { sessionID: "session", delta: "x" } }
    expect(eventDeltaKey(event)).toBeUndefined()
    expect(mergeEventDeltas(event, { ...event, data: { ...event.data, delta: "y" } })).toBeUndefined()
  })

  test("uses manifest metadata for current streaming deltas", () => {
    const event = {
      type: "session.next.text.delta",
      data: { sessionID: "session", assistantMessageID: "message", textID: "text", delta: "x" },
    }
    expect(eventDeltaKey(event)).toContain("session.next.text.delta")
    expect(mergeEventDeltas(event, { ...event, data: { ...event.data, delta: "y" } })?.data.delta).toBe("xy")
  })

  test("keeps sequenced output monotonic when independent keys merge", () => {
    type Sequenced = TestEvent & { sequence: number }
    const output: Sequenced[] = []
    const make = (sequence: number, assistantMessageID: string, value: string): Sequenced => ({
      sequence,
      id: String(sequence),
      type: "session.text.delta",
      data: { sessionID: "session", assistantMessageID, ordinal: 0, delta: value },
    })
    const coalescer = createEventCoalescer<Sequenced>(
      (event) => {
        output.push(event)
      },
      {
        keyOf: eventDeltaKey,
        orderBy: (event) => event.sequence,
        merge: (previous, next) => {
          const merged = mergeEventDeltas(previous, next)
          return merged ? { ...merged, sequence: next.sequence } : undefined
        },
      },
    )
    coalescer.offer(make(1, "a", "a1"))
    coalescer.offer(make(2, "b", "b1"))
    coalescer.offer(make(3, "a", "a2"))
    coalescer.flush()
    // a1 and a2 merge across the interleaved b1, so b1 is delivered first.
    expect(output.map((event) => event.data.delta)).toEqual(["b1", "a1a2"])
    // b1 is delivered while a1 (order 1) is still buffered, so the only safe
    // cursor for it is 0; the merged frame then completes the prefix.
    expect(output.map((event) => event.sequence)).toEqual([0, 3])
    expect(coalescer.ackWatermark).toBe(3)
    coalescer.dispose()
  })

  test("does not under-ack across successive flush boundaries", () => {
    type Sequenced = TestEvent & { sequence: number }
    const cursors: number[] = []
    const make = (sequence: number, sessionID: string): Sequenced => ({
      sequence,
      id: String(sequence),
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: "m", ordinal: 0, delta: "x" },
    })
    const coalescer = createEventCoalescer<Sequenced>(
      (event) => {
        cursors.push(event.sequence)
      },
      {
        keyOf: eventDeltaKey,
        orderBy: (event) => event.sequence,
        merge: (previous, next) => {
          const merged = mergeEventDeltas(previous, next)
          return merged ? { ...merged, sequence: next.sequence } : undefined
        },
      },
    )
    // Interleave, flush, then interleave again. The second flush must not
    // inherit a watermark pinned by the first one's retained runs.
    coalescer.offer(make(1, "a"))
    coalescer.offer(make(2, "b"))
    coalescer.offer(make(3, "a"))
    coalescer.flush()
    expect(coalescer.ackWatermark).toBe(3)
    coalescer.offer(make(4, "a"))
    coalescer.offer(make(5, "b"))
    coalescer.offer(make(6, "a"))
    coalescer.flush()
    expect(coalescer.ackWatermark).toBe(6)
    // A barrier after a flush is a safe cursor immediately.
    coalescer.offer({ sequence: 7, id: "7", type: "session.text.ended", data: { sessionID: "a" } })
    expect(cursors.at(-1)).toBe(7)
    expect(coalescer.ackWatermark).toBe(7)
    coalescer.dispose()
  })

  test("stamps the watermark onto the cursor field the SSE handlers read", () => {
    // Mirror of packages/server/src/handlers/event.ts: the coalescer's T is
    // {sequence, event}, the handler offers {sequence: item.sequence, ...} and
    // eventData() turns that sequence into the SSE `id`. Verifies the default
    // `withOrder` reaches the wire cursor without a handler change.
    type Payload = { id: string; type: string; data: Record<string, unknown> }
    type SequencedEvent = { sequence: number; event: Payload }
    type WireEvent = { sequence?: number; event: { id: string; type: string; data: Record<string, unknown> } }
    const wire: WireEvent[] = []
    const subscriber = {
      offer: (item: WireEvent) => {
        wire.push(item)
      },
    }
    const coalescer = createEventCoalescer<SequencedEvent>(
      (item) =>
        subscriber.offer({
          sequence: item.sequence,
          event: { id: item.event.id, type: item.event.type, data: item.event.data },
        }),
      {
        keyOf: (item) => eventDeltaKey(item.event),
        orderBy: (item) => item.sequence,
        merge: (previous, next) => {
          const event = mergeEventDeltas(previous.event, next.event)
          return event === undefined ? undefined : { sequence: next.sequence, event }
        },
      },
    )
    const make = (sequence: number, sessionID: string): SequencedEvent => ({
      sequence,
      event: {
        id: String(sequence),
        type: "session.text.delta",
        data: { sessionID, assistantMessageID: "m", ordinal: 0, delta: "x" },
      },
    })
    coalescer.offer(make(1, "a"))
    coalescer.offer(make(2, "b"))
    coalescer.offer(make(3, "a"))
    coalescer.flush()
    // b1 is delivered while a1 is still buffered, so its cursor is 0 -- not 2.
    expect(wire.map((item) => item.sequence)).toEqual([0, 3])
    expect(wire.map((item) => item.event.data.sessionID)).toEqual(["b", "a"])
    coalescer.dispose()
  })

  test("merges interleaved sessions instead of flushing on every new key", () => {
    type Sequenced = TestEvent & { sequence: number }
    const output: Sequenced[] = []
    const make = (sequence: number, sessionID: string, value: string): Sequenced => ({
      sequence,
      id: String(sequence),
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: "m", ordinal: 0, delta: value },
    })
    const coalescer = createEventCoalescer<Sequenced>(
      (event) => {
        output.push(event)
      },
      {
        keyOf: eventDeltaKey,
        orderBy: (event) => event.sequence,
        merge: (previous, next) => {
          const merged = mergeEventDeltas(previous, next)
          return merged ? { ...merged, sequence: next.sequence } : undefined
        },
      },
    )
    // 8 concurrent sessions round-robin, 6 rounds: consecutive frames never
    // share a key, which is the saturation case the coalescer exists for.
    let sequence = 0
    for (let round = 0; round < 6; round++) {
      for (let session = 0; session < 8; session++) {
        coalescer.offer(make(++sequence, `s${session}`, "x"))
      }
    }
    coalescer.flush()
    expect(sequence).toBe(48)
    // Before: every event flushed its predecessor -> 48 frames, no merging.
    expect(output).toHaveLength(8)
    expect(output.every((event) => (event.data.delta as string).length === 6)).toBe(true)
    expect(coalescer.ackWatermark).toBe(48)
    coalescer.dispose()
  })

  test("transport accumulator joins a long fragment run exactly at delivery", () => {
    const output: TestEvent[] = []
    const deltas = createEventDeltaAccumulator<TestEvent>()
    const coalescer = createEventCoalescer<TestEvent>((event) => {
      output.push(event)
    }, {
      keyOf: eventDeltaKey,
      merge: mergeEventDeltas,
      accumulator: deltas,
    })

    for (let index = 0; index < 32_768; index++) coalescer.offer(delta("x", String(index)))
    coalescer.flush()

    expect(output).toHaveLength(1)
    expect(output[0]?.data.delta).toBe("x".repeat(32_768))
    coalescer.dispose()
  })

  test("transport accumulator preserves interleaved cursor watermark semantics", () => {
    type Payload = TestEvent
    type Sequenced = { sequence: number; event: Payload }
    const deltas = createEventDeltaAccumulator<Payload>()
    const make = (sequence: number, sessionID: string, value: string): Sequenced => ({
      sequence,
      event: {
        id: String(sequence),
        type: "session.text.delta",
        data: { sessionID, assistantMessageID: "m", ordinal: 0, delta: value },
      },
    })
    const output = coalesceEventBatch<Sequenced>([make(1, "a", "a1"), make(2, "b", "b1"), make(3, "a", "a2")], {
      keyOf: (item) => eventDeltaKey(item.event),
      orderBy: (item) => item.sequence,
      merge: (previous, next) => {
        const event = mergeEventDeltas(previous.event, next.event)
        return event ? { sequence: next.sequence, event } : undefined
      },
      accumulator: {
        create: (item) => deltas.create(item.event),
        push: (state, item) => deltas.push(state, item.event),
        finalize: (state, item) => ({ ...item, event: deltas.finalize(state, item.event) }),
      },
    })

    expect(output.map((item) => item.event.data.delta)).toEqual(["b1", "a1a2"])
    expect(output.map((item) => item.sequence)).toEqual([0, 3])
  })

  test("flushes the maximum pending-key window with monotonic safe cursors", () => {
    type Sequenced = TestEvent & { sequence: number }
    const output: Sequenced[] = []
    const coalescer = createEventCoalescer<Sequenced>(
      (event) => {
        output.push(event)
      },
      {
        keyOf: eventDeltaKey,
        orderBy: (event) => event.sequence,
        merge: (previous, next) => {
          const merged = mergeEventDeltas(previous, next)
          return merged ? { ...merged, sequence: next.sequence } : undefined
        },
        maxPendingKeys: 256,
      },
    )
    for (let index = 0; index < 256; index++) {
      coalescer.offer({
        sequence: index + 1,
        id: String(index + 1),
        type: "session.text.delta",
        data: { sessionID: `s${index}`, assistantMessageID: "m", ordinal: 0, delta: "x" },
      })
    }
    coalescer.flush()

    expect(output).toHaveLength(256)
    expect(output.at(-1)?.sequence).toBe(256)
    for (let index = 1; index < output.length; index++) {
      expect(output[index]!.sequence).toBeGreaterThanOrEqual(output[index - 1]!.sequence)
    }
    expect(coalescer.ackWatermark).toBe(256)
    coalescer.dispose()
  })

  test("never acknowledges a prefix beyond what has been delivered", () => {
    type Sequenced = TestEvent & { sequence: number }
    const make = (sequence: number, sessionID: string, value: string): Sequenced => ({
      sequence,
      id: String(sequence),
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: "m", ordinal: 0, delta: value },
    })
    const check = (sessionCount: number, rounds: number, seed: number) => {
      // Deterministic PRNG so a failure is reproducible.
      let state = seed
      const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
      /**
       * Orders whose text has actually reached the subscriber, reconstructed
       * without trusting the coalescer: a frame for session S carrying L chars
       * accounts for the oldest L orders still pending for S.
       */
      const visible = new Set<number>()
      const queues = new Map<string, number[]>()
      let sequence = 0
      const coalescer = createEventCoalescer<Sequenced>(
        (event) => {
          const sessionID = event.data.sessionID as string
          const length = (event.data.delta as string).length
          const queue = queues.get(sessionID) ?? []
          for (let i = 0; i < length; i++) {
            const order = queue.shift()
            if (order === undefined) throw new Error("frame claims more fragments than were offered")
            visible.add(order)
          }
          queues.set(sessionID, queue)
          // Replaying from the published cursor must never skip content.
          for (let order = 1; order <= event.sequence; order++) {
            if (!visible.has(order)) throw new Error(`cursor ${event.sequence} acknowledges undelivered ${order}`)
          }
        },
        {
          keyOf: eventDeltaKey,
          orderBy: (event) => event.sequence,
          merge: (previous, next) => {
            const merged = mergeEventDeltas(previous, next)
            return merged ? { ...merged, sequence: next.sequence } : undefined
          },
          flushMs: 1,
        },
      )
      for (let round = 0; round < rounds; round++) {
        for (let i = 0; i < sessionCount; i++) {
          // Shuffle the session order each round so keys interleave hard.
          const order = [...Array(sessionCount).keys()].sort(() => next() - 0.5)
          for (const session of order) {
            sequence++
            const id = `s${session}`
            coalescer.offer(make(sequence, id, "x"))
            const queue = queues.get(id) ?? []
            queue.push(sequence)
            queues.set(id, queue)
          }
        }
        // Barriers at random points force mid-stream flushes.
        if (next() < 0.3) coalescer.flush()
      }
      coalescer.flush()
      expect(coalescer.ackWatermark).toBe(sequence)
      // Everything was delivered, so the final cursor covers every order.
      expect(visible.size).toBe(sequence)
      coalescer.dispose()
    }
    for (const seed of [1, 7, 42, 1234, 98765]) check(8, 6, seed)
    check(1, 20, 3)
    check(32, 4, 11)
  })

  test("finite replay batches use the same cursor watermarks without a live queue", () => {
    type Sequenced = TestEvent & { sequence: number }
    const make = (sequence: number, sessionID: string, value: string): Sequenced => ({
      sequence,
      id: String(sequence),
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: "m", ordinal: 0, delta: value },
    })
    const output = coalesceEventBatch<Sequenced>(
      [make(1, "a", "a1"), make(2, "b", "b1"), make(3, "a", "a2")],
      {
        keyOf: eventDeltaKey,
        orderBy: (event) => event.sequence,
        merge: (previous, next) => {
          const merged = mergeEventDeltas(previous, next)
          return merged ? { ...merged, sequence: next.sequence } : undefined
        },
      },
    )

    expect(output.map((event) => event.data.delta)).toEqual(["b1", "a1a2"])
    // Identical to the live coalescer's safe acknowledgements above: replay can
    // be streamed directly without changing Last-Event-ID semantics.
    expect(output.map((event) => event.sequence)).toEqual([0, 3])
  })
})
