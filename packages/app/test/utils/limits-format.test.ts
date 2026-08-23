import { describe, expect, test } from "bun:test"
import { formatAge, formatCountdownSeconds, toneForRemaining, colorForTone, formatPercent, displayWindowLabel, sortWindows, worstRemainingFromWindows } from "../../src/utils/limits-format"

describe("LimitsFormat", () => {
  test("tone and color mapping", () => {
    expect(toneForRemaining(5)).toBe("danger")
    expect(toneForRemaining(15)).toBe("warning")
    expect(toneForRemaining(50)).toBe("success")
    expect(toneForRemaining(null)).toBe("muted")
    expect(colorForTone("danger")).toBe("var(--v2-state-fg-danger)")
  })

  test("percent formatting", () => {
    expect(formatPercent(42)).toBe("42%")
    expect(formatPercent(42.5)).toBe("42.5%")
    expect(formatPercent(null)).toBe("—")
  })

  test("countdown formatting", () => {
    const t = (k: string, p?: Record<string, string | number | boolean>) => k
    expect(formatCountdownSeconds(0, t)).toBe("usage.duration.zero")
    expect(formatCountdownSeconds(90, t)).toContain("1m")
    expect(formatCountdownSeconds(3661, t)).toContain("1h")
    expect(formatCountdownSeconds(90061, t)).toContain("1d")
  })

  test("window label mapping", () => {
    const t = (k: string) => k
    expect(displayWindowLabel("5h", t)).toBe("limits.window.5h.short")
    expect(displayWindowLabel("weekly", t)).toBe("limits.window.weekly")
    expect(displayWindowLabel("credits", t)).toBe("limits.window.credits")
    expect(displayWindowLabel("billing_cycle", t)).toBe("limits.window.billingCycle")
  })

  test("window sorting by seconds ascending", () => {
    const entries = [
      ["monthly", { usedPercent: 10, remainingPercent: 90, windowSeconds: 2592000, resetAt: null, resetAfterSeconds: null, valueLabel: null }],
      ["5h", { usedPercent: 50, remainingPercent: 50, windowSeconds: 18000, resetAt: null, resetAfterSeconds: null, valueLabel: null }],
      ["weekly", { usedPercent: 20, remainingPercent: 80, windowSeconds: 604800, resetAt: null, resetAfterSeconds: null, valueLabel: null }],
    ] as [string, { usedPercent: number | null; remainingPercent: number | null; windowSeconds: number | null; resetAt: number | null; resetAfterSeconds: number | null; valueLabel: string | null }][]
    const sorted = sortWindows(entries)
    expect(sorted[0][0]).toBe("5h")
    expect(sorted[1][0]).toBe("weekly")
  })

  test("worst remaining picks minimum", () => {
    const windows = [
      ["5h", { usedPercent: 60, remainingPercent: 40, windowSeconds: 18000, resetAt: null, resetAfterSeconds: null, valueLabel: null }],
      ["weekly", { usedPercent: 10, remainingPercent: 90, windowSeconds: 604800, resetAt: null, resetAfterSeconds: null, valueLabel: null }],
    ] as [string, { usedPercent: number | null; remainingPercent: number | null; windowSeconds: number | null; resetAt: number | null; resetAfterSeconds: number | null; valueLabel: string | null }][]
    expect(worstRemainingFromWindows(windows)).toBe(40)
  })
})
