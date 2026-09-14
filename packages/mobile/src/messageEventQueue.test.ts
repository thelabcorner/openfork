import { describe, expect, test } from "bun:test"
import { MessageEventQueue } from "./messageEventQueue"

const delta = (text: string, sessionID = "s1", textID = "p1") => ({
  type: "session.next.text.delta",
  props: { sessionID, assistantMessageID: "m1", textID, delta: text },
})

describe("MessageEventQueue", () => {
  test("coalesces adjacent deltas for one stream", () => {
    const queue = new MessageEventQueue()
    queue.push(delta("Hel"))
    queue.push(delta("lo"))
    expect(queue.stats()).toMatchObject({ count: 1, coalesced: 1 })
    expect(queue.drain()[0]!.props.delta).toBe("Hello")
  })

  test("materializes a long adjacent stream once at drain", () => {
    const queue = new MessageEventQueue({ maxEvents: 1000, maxBytes: 1_000_000, maxChunkBytes: 200_000 })
    for (let i = 0; i < 1000; i++) queue.push(delta("abcdefgh"))
    expect(queue.stats()).toMatchObject({ count: 1, coalesced: 999 })
    expect(queue.drain()[0]!.props.delta).toBe("abcdefgh".repeat(1000))
  })

  test("does not reorder interleaved streams", () => {
    const queue = new MessageEventQueue()
    queue.push(delta("A", "s1", "p1"))
    queue.push(delta("B", "s2", "p2"))
    queue.push(delta("C", "s1", "p1"))
    expect(queue.drain().map((event) => event.props.delta)).toEqual(["A", "B", "C"])
  })

  test("drops locally at the event budget and names exact stale sessions", () => {
    const queue = new MessageEventQueue({ maxEvents: 2, maxBytes: 1_000_000, maxChunkBytes: 1 })
    queue.push(delta("a", "s1", "p1"))
    queue.push(delta("b", "s2", "p2"))
    const overflow = queue.push(delta("c", "s3", "p3"))
    expect(overflow.accepted).toBe(false)
    expect(new Set(overflow.staleSessions)).toEqual(new Set(["s1", "s2", "s3"]))
    expect(queue.stats()).toMatchObject({ count: 0, bytes: 0, dropped: 3 })
  })

  test("bounds retained bytes independently of event count", () => {
    const queue = new MessageEventQueue({ maxEvents: 100, maxBytes: 400, maxChunkBytes: 1 })
    const overflow = queue.push(delta("x".repeat(200)))
    expect(overflow).toEqual({ accepted: false, staleSessions: ["s1"] })
    expect(queue.stats().bytes).toBe(0)
  })
})
