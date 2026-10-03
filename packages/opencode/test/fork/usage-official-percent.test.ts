import { describe, expect, test } from "bun:test"
import { officialUsedPercent } from "@/fork/usage"
import type { LocalWindow } from "@/fork/usage-cache"

const window = (input: Partial<LocalWindow>): LocalWindow => ({
  label: "week",
  spentUSD: 0,
  limitUSD: 0,
  resetsAt: 10_000,
  clearsAt: 10_000,
  callsInWindow: 0,
  source: "api",
  ...input,
})

describe("official per-window percentage", () => {
  test("prefers the provider's verbatim percentage over any dollar restatement", () => {
    const value = officialUsedPercent(
      // mergeOfficial wrote spentUSD from the official percentage, but a
      // consumer must not have to reconstruct it through the dollar budget.
      window({ spentUSD: 3, limitUSD: 30, officialPercent: 37.5 }),
    )
    expect(value).toBe(37.5)
  })

  test("falls back to the merge-written dollar restatement for older windows", () => {
    expect(officialUsedPercent(window({ spentUSD: 6, limitUSD: 30 }))).toBe(20)
  })

  test("never uses the locally refined legacy percentage", () => {
    const value = officialUsedPercent(window({ spentUSD: 6, limitUSD: 30, estimatedPercent: 19.87 }))
    expect(value).toBe(20)
  })

  test("reports nothing when there is no real denominator", () => {
    expect(officialUsedPercent(window({ spentUSD: 6, limitUSD: 0 }))).toBeUndefined()
  })

  test("clamps out-of-range provider percentages", () => {
    expect(officialUsedPercent(window({ officialPercent: 140 }))).toBe(100)
    expect(officialUsedPercent(window({ officialPercent: -4 }))).toBe(0)
  })
})
