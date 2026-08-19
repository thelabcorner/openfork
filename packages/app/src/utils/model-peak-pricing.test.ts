import { describe, expect, it } from "bun:test"
import { deepSeekRatePeriod, isDeepSeekPeakPricedModel } from "./model-peak-pricing"

const utc = (hour: number, minute = 0) => new Date(Date.UTC(2026, 0, 1, hour, minute))

describe("deepSeekRatePeriod", () => {
  it("marks peak hours (01:00-04:00 and 06:00-10:00 UTC) as peak", () => {
    expect(deepSeekRatePeriod(utc(1))).toBe("peak")
    expect(deepSeekRatePeriod(utc(3, 59))).toBe("peak")
    expect(deepSeekRatePeriod(utc(6))).toBe("peak")
    expect(deepSeekRatePeriod(utc(9, 59))).toBe("peak")
  })

  it("marks all other hours as off-peak", () => {
    expect(deepSeekRatePeriod(utc(0))).toBe("off-peak")
    expect(deepSeekRatePeriod(utc(4))).toBe("off-peak")
    expect(deepSeekRatePeriod(utc(5, 59))).toBe("off-peak")
    expect(deepSeekRatePeriod(utc(10))).toBe("off-peak")
    expect(deepSeekRatePeriod(utc(23))).toBe("off-peak")
  })
})

describe("isDeepSeekPeakPricedModel", () => {
  it("matches DeepSeek V4 Flash/Pro on OpenCode providers", () => {
    expect(isDeepSeekPeakPricedModel({ id: "deepseek-v4-flash", provider: { id: "opencode" } })).toBe(true)
    expect(isDeepSeekPeakPricedModel({ id: "deepseek-v4-pro", provider: { id: "opencode-go" } })).toBe(true)
  })

  it("rejects other models and providers", () => {
    expect(isDeepSeekPeakPricedModel({ id: "gpt-5", provider: { id: "opencode" } })).toBe(false)
    expect(isDeepSeekPeakPricedModel({ id: "deepseek-v4-flash", provider: { id: "deepseek" } })).toBe(false)
    expect(isDeepSeekPeakPricedModel({ id: "deepseek-v4-flash", provider: { id: "anthropic" } })).toBe(false)
  })
})
