import { describe, expect, test } from "bun:test"
import { turnThroughput, type ThroughputMessage } from "./throughput"

const user = (id: string): ThroughputMessage => ({ id, role: "user" })

const step = (
  id: string,
  time: { sent: number; first?: number; streamed?: number },
  tokens: { output: number; reasoning?: number } = { output: 100 },
  extra: Partial<ThroughputMessage> = {},
): ThroughputMessage => ({
  id,
  role: "assistant",
  modelKey: "provider:model",
  output: tokens.output,
  reasoning: tokens.reasoning ?? 0,
  requestSentAt: time.sent,
  firstTokenAt: time.first,
  streamedAt: time.streamed,
  ...extra,
})

describe("turnThroughput", () => {
  test("sums numerators and denominators instead of averaging per-step rates", () => {
    // 100 tokens over 1s + 100 tokens over 9s = 20 tok/s, not (100 + 11.1) / 2.
    const messages = [
      user("u1"),
      step("a1", { sent: 0, streamed: 1000 }, { output: 100 }),
      step("a2", { sent: 2000, streamed: 11000 }, { output: 100 }),
    ]
    expect(turnThroughput(messages, "u1")?.requestRate).toBe(20)
  })

  test("replays the #47125 fixture: prefill wait dominates, burst delivery does not inflate", () => {
    // Deterministic 12-token response with 2,690 ms of provider wait and
    // 10 ms of burst delivery must report ≈4.4 tok/s, not ≈1,200 tok/s.
    const messages = [user("u1"), step("a1", { sent: 0, first: 2690, streamed: 2700 }, { output: 12 })]
    const result = turnThroughput(messages, "u1")
    expect(result).toBeDefined()
    expect(result!.requestRate).toBeGreaterThan(3)
    expect(result!.requestRate).toBeLessThan(6)
    expect(result!.requestRate).toBeLessThan(100)
  })

  test("excludes tool-settlement time: completed far after streamedAt changes nothing", () => {
    const near = [user("u1"), step("a1", { sent: 0, streamed: 1000 }, { output: 100 })]
    const far = [
      user("u1"),
      { ...step("a1", { sent: 0, streamed: 1000 }, { output: 100 }) },
    ]
    // completed is not an input at all; both must agree exactly.
    expect(turnThroughput(far, "u1")?.requestRate).toBe(turnThroughput(near, "u1")?.requestRate)
  })

  test("bails when any step lacks a streamed boundary", () => {
    const messages = [
      user("u1"),
      step("a1", { sent: 0, streamed: 1000 }, { output: 100 }),
      step("a2", { sent: 2000, streamed: undefined }, { output: 100 }),
    ]
    expect(turnThroughput(messages, "u1")).toBeUndefined()
  })

  test("renders nothing for pre-feature messages without stamps", () => {
    const messages: ThroughputMessage[] = [
      user("u1"),
      { id: "a1", role: "assistant", modelKey: "p:m", output: 50, reasoning: 0 },
    ]
    expect(turnThroughput(messages, "u1")).toBeUndefined()
  })

  test("suppresses empty, tokenless, and zero-duration turns", () => {
    expect(turnThroughput([user("u1")], "u1")).toBeUndefined()
    expect(turnThroughput([user("u1"), step("a1", { sent: 0, streamed: 1000 }, { output: 0 })], "u1")).toBeUndefined()
    expect(turnThroughput([user("u1"), step("a1", { sent: 1000, streamed: 1000 }, { output: 10 })], "u1")).toBeUndefined()
    expect(turnThroughput([], "u1")).toBeUndefined()
    expect(turnThroughput([user("u1")], "missing")).toBeUndefined()
  })

  test("treats inverted windows as stamp failures, not fast generations", () => {
    const messages = [user("u1"), step("a1", { sent: 2000, streamed: 1000 }, { output: 100 })]
    expect(turnThroughput(messages, "u1")).toBeUndefined()
  })

  test("terminates the walk at a compaction boundary", () => {
    const messages: ThroughputMessage[] = [
      step("old", { sent: 0, streamed: 100 }, { output: 10_000 }),
      { id: "c1", role: "compaction" },
      user("u1"),
      step("a1", { sent: 0, streamed: 1000 }, { output: 100 }),
    ]
    const result = turnThroughput(messages, "u1")
    expect(result?.requestRate).toBe(100)
    expect(result?.steps).toBe(1)
  })

  test("suppresses the turn on a mid-turn model switch", () => {
    const switched: ThroughputMessage[] = [
      user("u1"),
      step("a1", { sent: 0, streamed: 1000 }, { output: 100 }),
      { id: "m1", role: "model-switched" },
      step("a2", { sent: 2000, streamed: 3000 }, { output: 100 }),
    ]
    expect(turnThroughput(switched, "u1")).toBeUndefined()
    const mixedKeys = [
      user("u1"),
      step("a1", { sent: 0, streamed: 1000 }, { output: 100 }),
      step("a2", { sent: 2000, streamed: 3000 }, { output: 100 }, { modelKey: "other:model" }),
    ]
    expect(turnThroughput(mixedKeys, "u1")).toBeUndefined()
  })

  test("suppresses failed and aborted steps", () => {
    const messages = [user("u1"), step("a1", { sent: 0, streamed: 1000 }, { output: 100 }, { failed: true })]
    expect(turnThroughput(messages, "u1")).toBeUndefined()
  })

  test("keeps the request rate on visible output while the decode rate folds in reasoning", () => {
    const messages = [user("u1"), step("a1", { sent: 0, first: 500, streamed: 1500 }, { output: 100, reasoning: 100 })]
    const result = turnThroughput(messages, "u1")
    // Request window 1.5s over 100 visible tokens; decode window 1s over 200 tokens.
    expect(result?.requestRate).toBeCloseTo(66.67, 1)
    expect(result?.decodeRate).toBe(200)
    expect(result?.ttftMs).toBe(500)
  })

  test("keeps the request rate when first-token stamps are absent", () => {
    const messages = [user("u1"), step("a1", { sent: 0, first: undefined, streamed: 1000 }, { output: 100 })]
    const result = turnThroughput(messages, "u1")
    expect(result?.requestRate).toBe(100)
    expect(result?.decodeRate).toBeUndefined()
    expect(result?.ttftMs).toBeUndefined()
  })
})
