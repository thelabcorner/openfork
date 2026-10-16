import { describe, expect, test } from "bun:test"
import { oxpLocalDonorForModel, oxpLocalDonorProfile } from "./oxp-local-donor"

const row = (modelID: string, messages: number, input: number, cacheRead: number, output: number, reasoning = 0) => ({
  modelID, messages, tokens: { input, cacheRead, cacheWrite: 0, output, reasoning },
})

describe("OXP local donor proxy", () => {
  test("prefers sufficient GPT-6 observations and weights token mass, not average model percentages", () => {
    const result = oxpLocalDonorProfile([
      row("gpt-6-sol", 40, 90, 10, 20, 10),
      row("gpt-6-luna", 60, 50, 50, 10),
      row("claude-sonnet", 1000, 0, 9000, 10),
    ])
    expect(result?.cohort).toBe("gpt-6")
    expect(result?.messages).toBe(100)
    expect(result?.cachedInputPercent).toBe(30)
    expect(result?.surroundingOutputPercent).toBeCloseTo((40 / 240) * 100)
  })

  test("falls back to all locally observed models when GPT-6 sample is too small", () => {
    const result = oxpLocalDonorProfile([
      row("gpt-6-sol", 3, 10, 0, 1),
      row("claude-sonnet", 30, 10, 10, 10),
    ])
    expect(result?.cohort).toBe("all-models")
    expect(result?.messages).toBe(33)
  })

  test("never fabricates upstream split from absent, empty or malformed data", () => {
    expect(oxpLocalDonorProfile([])).toBeUndefined()
    expect(oxpLocalDonorProfile([row("gpt-6-luna", 0, 9, 4, 2)])).toBeUndefined()
    expect(oxpLocalDonorProfile([row("gpt-6-sol", 1, NaN, -10, 0)])).toBeUndefined()
  })

  test("uses exact model cache and output shares only with enough matching observed generations", () => {
    const rows = [
      row("gpt-6-sol", 40, 10, 90, 5),
      row("gpt-6-luna", 40, 90, 10, 80),
    ]
    const exact = oxpLocalDonorForModel(rows, "gpt-6-sol")
    expect(exact?.cohort).toBe("exact-model")
    expect(exact?.cachedInputPercent).toBe(90)
    const fallback = oxpLocalDonorForModel(rows, "gpt-6-astra")
    expect(fallback?.cohort).toBe("gpt-6")
    expect(fallback?.cachedInputPercent).toBe(50)
  })

  test("cached input denominator excludes output and cache write", () => {
    const result = oxpLocalDonorProfile([
      { modelID: "gpt-6-sol", messages: 25, tokens: { input: 100, cacheRead: 100, cacheWrite: 100, output: 100, reasoning: 100 } },
    ])
    expect(result?.cachedInputPercent).toBe(50)
    expect(result?.surroundingOutputPercent).toBe(40)
  })
})
