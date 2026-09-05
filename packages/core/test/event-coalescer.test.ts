import { describe, expect, test } from "bun:test"
import { createEventCoalescer, eventDeltaKey, mergeEventDeltas } from "@opencode-ai/core/event-coalescer"

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
    expect(output.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(output.map((event) => event.data.delta)).toEqual(["a1", "b1", "a2"])
    coalescer.dispose()
  })
})
