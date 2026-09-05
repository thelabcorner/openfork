import { describe, expect, test } from "bun:test"
import { estimateEventBytes, EventReplayBuffer, parseEventSequence } from "../src/event-replay"

describe("event replay buffer", () => {
  test("assigns monotonic cursors and replays only the requested suffix", () => {
    const buffer = new EventReplayBuffer<string>(3)
    expect(buffer.append("a")).toBe(1)
    expect(buffer.append("b")).toBe(2)
    expect(buffer.append("c")).toBe(3)
    expect(buffer.since(1)).toMatchObject({
      kind: "ok",
      latest: 3,
      frames: [
        { sequence: 2, event: "b" },
        { sequence: 3, event: "c" },
      ],
    })
  })

  test("reports a gap once the cursor falls outside the bounded window", () => {
    const buffer = new EventReplayBuffer<string>(2)
    buffer.append("a")
    buffer.append("b")
    buffer.append("c")
    expect(buffer.since(0)).toEqual({ kind: "gap", latest: 3, oldest: 2, requested: 0 })
  })

  test("enforces a byte window without shifting the hot ring", () => {
    const buffer = new EventReplayBuffer<string>(4, { maxBytes: 3, sizeOf: (value) => value.length })
    buffer.append("a")
    buffer.append("bb")
    buffer.append("c")
    expect(buffer.since(0)).toMatchObject({ kind: "gap", oldest: 2, latest: 3 })
    expect(buffer.since(1)).toMatchObject({
      kind: "ok",
      frames: [
        { sequence: 2, event: "bb" },
        { sequence: 3, event: "c" },
      ],
    })
  })

  test("reports a gap when an oversized frame leaves the ring empty", () => {
    const buffer = new EventReplayBuffer<string>(4, { maxBytes: 2, sizeOf: (value) => value.length })
    buffer.append("too-large")
    expect(buffer.since(0)).toEqual({ kind: "gap", latest: 1, oldest: 2, requested: 0 })
    expect(buffer.since(1)).toMatchObject({ kind: "ok", latest: 1, frames: [] })
  })

  test("estimates oversized payloads above the transport budget", () => {
    expect(estimateEventBytes("x".repeat(9 * 1024 * 1024))).toBeGreaterThan(8 * 1024 * 1024)
  })

  test("counts deeply nested payloads and terminates on cycles", () => {
    const nested = { data: { properties: { output: { chunks: [{ text: "x".repeat(9 * 1024 * 1024) }] } } } }
    expect(estimateEventBytes(nested)).toBeGreaterThan(8 * 1024 * 1024)
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(estimateEventBytes(cyclic)).toBeGreaterThan(0)
  })

  test("accepts only safe non-negative Last-Event-ID values", () => {
    expect(parseEventSequence(undefined)).toBeUndefined()
    expect(parseEventSequence("  ")).toBeUndefined()
    expect(parseEventSequence("12")).toBe(12)
    expect(parseEventSequence("-1")).toBeUndefined()
    expect(parseEventSequence("1.5")).toBeUndefined()
    expect(parseEventSequence("1e100")).toBeUndefined()
  })

  test("reports a gap for a cursor from a restarted server", () => {
    const buffer = new EventReplayBuffer<string>(2)
    expect(buffer.since(9)).toEqual({ kind: "gap", latest: 0, oldest: 1, requested: 9 })
    buffer.append("current")
    expect(buffer.since(9)).toEqual({ kind: "gap", latest: 1, oldest: 1, requested: 9 })
  })

  test("rejects a prior epoch even when its sequence exists in the new ring", () => {
    const old = new EventReplayBuffer<string>(4)
    const current = new EventReplayBuffer<string>(4)
    old.append("old")
    current.append("new")
    current.append("newer")
    expect(current.since(parseEventSequence(`${old.epoch}:1`, current.epoch)).kind).toBe("gap")
    expect(current.since(parseEventSequence(`${current.epoch}:1`, current.epoch)).kind).toBe("ok")
    expect(current.since(parseEventSequence("1", current.epoch)).kind).toBe("gap")
    expect(parseEventSequence(undefined, current.epoch)).toBeUndefined()
    expect(current.since(parseEventSequence(`${current.epoch}:junk`, current.epoch)).kind).toBe("gap")
  })
})
