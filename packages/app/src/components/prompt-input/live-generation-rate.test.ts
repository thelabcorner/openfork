import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2/client"
import {
  computeLiveGenerationRate,
  computeMeasuredRate,
  streamedChars,
  type Sample,
} from "./live-generation-rate-math"

const textPart = (
  text: string,
  args: { synthetic?: boolean; ignored?: boolean; time?: { start: number; end?: number } } = {},
) =>
  ({
    type: "text",
    text,
    synthetic: args.synthetic,
    ignored: args.ignored,
    time: args.time,
  }) as unknown as Part

const reasoningPart = (text: string, time?: { start: number; end?: number }) =>
  ({ type: "reasoning", text, time }) as unknown as Part

const toolPart = () => ({ type: "tool" }) as unknown as Part

describe("streamedChars", () => {
  test("sums text and reasoning characters", () => {
    const parts = [textPart("hello"), reasoningPart("thinking"), toolPart()]
    expect(streamedChars(parts)).toBe("hello".length + "thinking".length)
  })

  test("excludes synthetic and ignored text", () => {
    const parts = [textPart("real"), textPart("summary", { synthetic: true }), textPart("hidden", { ignored: true })]
    expect(streamedChars(parts)).toBe("real".length)
  })

  test("is 0 for undefined or empty parts", () => {
    expect(streamedChars(undefined)).toBe(0)
    expect(streamedChars([])).toBe(0)
  })
})

describe("computeMeasuredRate", () => {
  test("is null for undefined parts", () => {
    expect(computeMeasuredRate(undefined)).toBeNull()
  })

  test("is null for empty parts", () => {
    expect(computeMeasuredRate([])).toBeNull()
  })

  test("is null when parts have no timing data", () => {
    const parts = [textPart("hello")]
    expect(computeMeasuredRate(parts, 10000)).toBeNull()
  })

  test("is null when elapsed time is below minimum window", () => {
    const parts = [textPart("hello", { time: { start: 1000 } })]
    // Only 100ms elapsed — below MIN_WINDOW_MS (600)
    expect(computeMeasuredRate(parts, 1100)).toBeNull()
  })

  test("computes rate from a single open text part (streaming)", () => {
    // Part started at t=1000, now is t=2000 → 1s elapsed
    // 400 chars / 4 = 100 tokens / 1s = 100 tok/s
    const parts = [textPart("a".repeat(400), { time: { start: 1000 } })]
    const result = computeMeasuredRate(parts, 2000)
    expect(result).not.toBeNull()
    expect(result!.rate).toBeCloseTo(100, 0)
    expect(result!.source).toBe("measured")
  })

  test("computes rate from a closed text part", () => {
    // Part started at t=1000, ended at t=2000 → 1s elapsed
    // 800 chars / 4 = 200 tokens / 1s = 200 tok/s
    const parts = [textPart("b".repeat(800), { time: { start: 1000, end: 2000 } })]
    const result = computeMeasuredRate(parts, 3000)
    expect(result).not.toBeNull()
    expect(result!.rate).toBeCloseTo(200, 0)
    expect(result!.source).toBe("measured")
  })

  test("uses earliest start time across multiple parts", () => {
    // Part 1 started at t=500 (closed), part 2 started at t=1000 (open)
    // Earliest start = 500, now = 2000 → 1.5s elapsed
    // Total chars = 200 + 400 = 600 → 150 tokens / 1.5s = 100 tok/s
    const parts = [
      textPart("a".repeat(200), { time: { start: 500, end: 1000 } }),
      textPart("b".repeat(400), { time: { start: 1000 } }),
    ]
    const result = computeMeasuredRate(parts, 2000)
    expect(result).not.toBeNull()
    expect(result!.rate).toBeCloseTo(100, 0)
  })

  test("includes reasoning part timing", () => {
    // Reasoning started at t=0, now t=1000 → 1s
    // 400 chars of reasoning / 4 = 100 tokens / 1s = 100 tok/s
    const parts = [reasoningPart("thinking".repeat(50), { start: 0 })]
    const result = computeMeasuredRate(parts, 1000)
    expect(result).not.toBeNull()
    expect(result!.rate).toBeCloseTo(100, 0)
  })

  test("returns rate 0 when open part exists but no characters yet", () => {
    const parts = [textPart("", { time: { start: 1000 } })]
    const result = computeMeasuredRate(parts, 2000)
    expect(result).not.toBeNull()
    expect(result!.rate).toBe(0)
    expect(result!.source).toBe("measured")
  })

  test("returns null when no open part and no characters", () => {
    const parts = [textPart("", { time: { start: 1000, end: 2000 } })]
    expect(computeMeasuredRate(parts, 3000)).toBeNull()
  })

  test("excludes synthetic and ignored text from char count", () => {
    const parts = [
      textPart("real", { time: { start: 0 } }),
      textPart("synthetic", { synthetic: true, time: { start: 0 } }),
      textPart("ignored", { ignored: true, time: { start: 0 } }),
    ]
    const result = computeMeasuredRate(parts, 1000)
    expect(result).not.toBeNull()
    // Only "real" (4 chars) counts → 1 token / 1s = 1 tok/s
    expect(result!.rate).toBeCloseTo(1, 0)
  })
})

describe("computeLiveGenerationRate", () => {
  test("returns null with fewer than 3 samples (estimated fallback)", () => {
    expect(computeLiveGenerationRate([])).toEqual({ rate: null, source: "estimated" })
    expect(computeLiveGenerationRate([{ time: 0, chars: 0 }])).toEqual({ rate: null, source: "estimated" })
    expect(computeLiveGenerationRate([{ time: 0, chars: 0 }, { time: 500, chars: 200 }])).toEqual({
      rate: null,
      source: "estimated",
    })
  })

  test("prefers measured rate when parts have timing data", () => {
    const samples: Sample[] = [
      { time: 0, chars: 0 },
      { time: 1000, chars: 400 },
      { time: 2000, chars: 800 },
    ]
    const parts = [textPart("a".repeat(800), { time: { start: 0 } })]
    const result = computeLiveGenerationRate(samples, parts, 2000)
    expect(result.source).toBe("measured")
    // 800 chars / 4 = 200 tokens over 2s = 100 tok/s
    expect(result.rate).toBeCloseTo(100, 0)
  })

  test("falls back to estimated when parts lack timing data", () => {
    const samples: Sample[] = [
      { time: 0, chars: 0 },
      { time: 1000, chars: 400 },
      { time: 2000, chars: 800 },
    ]
    const parts = [textPart("hello")]
    const result = computeLiveGenerationRate(samples, parts, 2000)
    expect(result.source).toBe("estimated")
    expect(result.rate).toBeCloseTo(100, 0)
  })

  test("falls back to estimated when no parts provided", () => {
    const samples: Sample[] = [
      { time: 0, chars: 0 },
      { time: 1000, chars: 400 },
      { time: 2000, chars: 800 },
    ]
    const result = computeLiveGenerationRate(samples)
    expect(result.source).toBe("estimated")
    expect(result.rate).toBeCloseTo(100, 0)
  })

  test("smooths tokens/sec from consecutive sample pairs (EWMA)", () => {
    const samples: Sample[] = [
      { time: 0, chars: 0 },
      { time: 1000, chars: 400 },
      { time: 2000, chars: 800 },
    ]
    const result = computeLiveGenerationRate(samples)
    expect(result.source).toBe("estimated")
    expect(result.rate).toBeCloseTo(100, 0)
  })

  test("adapts to rate changes via smoothing", () => {
    const samples: Sample[] = [
      { time: 0, chars: 0 },
      { time: 1000, chars: 400 },
      { time: 1500, chars: 600 },
      { time: 2500, chars: 1400 },
    ]
    const result = computeLiveGenerationRate(samples)
    expect(result.source).toBe("estimated")
    expect(result.rate).toBeCloseTo(130, 0)
  })

  test("is 'paused' (not 0) when there is elapsed time but no character growth", () => {
    const samples: Sample[] = [
      { time: 0, chars: 120 },
      { time: 1000, chars: 120 },
      { time: 2000, chars: 120 },
    ]
    const result = computeLiveGenerationRate(samples)
    expect(result.source).toBe("estimated")
    expect(result.rate).toBe("paused")
  })

  test("clamps negative char deltas to 0 in instantaneous rate", () => {
    const samples: Sample[] = [
      { time: 0, chars: 500 },
      { time: 1000, chars: 100 },
      { time: 2000, chars: 500 },
    ]
    const result = computeLiveGenerationRate(samples)
    expect(result.source).toBe("estimated")
    expect(result.rate).toBeCloseTo(30, 0)
  })

  test("handles varying sample intervals gracefully", () => {
    const samples: Sample[] = [
      { time: 0, chars: 0 },
      { time: 200, chars: 80 },
      { time: 1000, chars: 400 },
      { time: 1500, chars: 600 },
    ]
    const result = computeLiveGenerationRate(samples)
    expect(result.source).toBe("estimated")
    expect(result.rate).toBeCloseTo(100, 0)
  })
})
