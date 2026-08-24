import { describe, expect, test } from "bun:test"
import { formatCountdownSeconds, toneForRemaining, colorForTone, formatPercent, displayWindowLabel, sortWindows, worstRemainingFromWindows, resolveTierGate, tierGateState, forkWindowToUsageWindow } from "../../src/utils/limits-format"

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
    expect(formatCountdownSeconds(90, t)).toBe("usage.duration.minutesSeconds")
    expect(formatCountdownSeconds(3661, t)).toBe("usage.duration.hoursMinutesSeconds")
    expect(formatCountdownSeconds(90_061, t)).toBe("usage.duration.daysHoursSeconds")
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

  test("fork windows map onto normalized usage windows", () => {
    const fromOfficial = forkWindowToUsageWindow({ label: "5h", spentUSD: 3, limitUSD: 12, estimatedPercent: 42, resetsAt: 123 })
    expect(fromOfficial.usedPercent).toBe(42)
    expect(fromOfficial.remainingPercent).toBe(58)
    expect(fromOfficial.windowSeconds).toBe(18_000)
    expect(fromOfficial.resetAt).toBe(123)

    const fromLocal = forkWindowToUsageWindow({ label: "week", spentUSD: 6, limitUSD: 30, resetsAt: 456 })
    expect(fromLocal.usedPercent).toBeCloseTo(20)
    expect(fromLocal.windowSeconds).toBe(604_800)

    const emptyLimit = forkWindowToUsageWindow({ label: "month", spentUSD: 0, limitUSD: 0, resetsAt: 789 })
    expect(emptyLimit.usedPercent).toBe(null)
    expect(emptyLimit.remainingPercent).toBe(null)
  })

  describe("tier gate", () => {
    const win = (used: number | null, windowSeconds: number | null = null) => ({
      usedPercent: used,
      remainingPercent: used === null ? null : 100 - used,
      windowSeconds,
      resetAt: 1,
      resetAfterSeconds: null,
      valueLabel: null,
    })

    test("empty weekly gates a fresh 5h; monthly empty blocks both", () => {
      const fresh5hEmptyWeek = resolveTierGate([
        ["weekly", win(100, 604_800)],
        ["5h", win(0, 18_000)],
      ])
      expect(fresh5hEmptyWeek.effectiveRemaining).toBe(0)
      expect(fresh5hEmptyWeek.bindingKey).toBe("weekly")

      const allBlocked = resolveTierGate([
        ["monthly", win(100)],
        ["weekly", win(40)],
        ["5h", win(10)],
      ])
      expect(allBlocked.effectiveRemaining).toBe(0)
      expect(allBlocked.bindingKey).toBe("monthly")
    })

    test("binding is the least-remaining tier; ties prefer the longer window", () => {
      const normal = resolveTierGate([
        ["weekly", win(80, 604_800)],
        ["5h", win(40, 18_000)],
        ["monthly", win(50)],
      ])
      expect(normal.bindingKey).toBe("weekly")
      expect(normal.effectiveRemaining).toBe(20)

      const tie = resolveTierGate([
        ["5h", win(70, 18_000)],
        ["weekly", win(70, 604_800)],
      ])
      expect(tie.bindingKey).toBe("weekly")
    })

    test("model-scoped windows never gate the provider", () => {
      const gated = resolveTierGate([
        ["weekly", win(90, 604_800)],
        ["5h", win(30, 18_000)],
        ["weekly:claude-opus", win(95)],
      ])
      expect(gated.bindingKey).toBe("weekly")
      expect(gated.effectiveRemaining).toBe(10)
    })

    test("balance-only rows never gate and unknown durations still count", () => {
      const creditsOnly = resolveTierGate([["credits", win(null)]])
      expect(creditsOnly.effectiveRemaining).toBe(null)
      expect(creditsOnly.bindingKey).toBe(null)

      const noDuration = resolveTierGate([
        ["billing_cycle", win(95)],
        ["5h", win(50, 18_000)],
      ])
      expect(noDuration.bindingKey).toBe("billing_cycle")
    })

    test("per-window states annotate binding vs capped rows", () => {
      const gate = resolveTierGate([
        ["weekly", win(90, 604_800)],
        ["5h", win(10, 18_000)],
      ])
      expect(tierGateState("weekly", 10, gate)).toBe("binding")
      expect(tierGateState("5h", 90, gate)).toBe("gated")

      // A sole window IS its own binding constraint.
      const solo = resolveTierGate([["5h", win(10, 18_000)]])
      expect(tierGateState("5h", 90, solo)).toBe("binding")
      expect(tierGateState("weekly", 90, solo)).toBe("normal")
    })
  })
})
