import { describe, expect, test } from "bun:test"
import {
  buildResult,
  computeUsedPercent,
  durationToLabel,
  durationToSeconds,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from "../../src/quota/format"

describe("QuotaFormat", () => {
  test("toNumber accepts finite numbers and numeric strings, rejects the rest", () => {
    expect(toNumber(5)).toBe(5)
    expect(toNumber("12.5")).toBe(12.5)
    expect(toNumber("  ")).toBe(null)
    expect(toNumber("abc")).toBe(null)
    expect(toNumber(Number.NaN)).toBe(null)
    expect(toNumber(null)).toBe(null)
  })

  test("toTimestamp normalizes seconds to milliseconds and parses ISO strings", () => {
    expect(toTimestamp(1_700_000_000)).toBe(1_700_000_000_000)
    expect(toTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(toTimestamp("2026-08-21T00:00:00.000Z")).toBe(Date.parse("2026-08-21T00:00:00.000Z"))
    expect(toTimestamp(0)).toBe(null)
    expect(toTimestamp(-5)).toBe(null)
  })

  test("toUsageWindow computes the remaining complement and reset countdown", () => {
    const resetAt = Date.now() + 90_000
    const window = toUsageWindow({ usedPercent: 68, windowSeconds: 5 * 60 * 60, resetAt })
    expect(window.usedPercent).toBe(68)
    expect(window.remainingPercent).toBe(32)
    expect(window.windowSeconds).toBe(18_000)
    expect(window.resetAfterSeconds).toBeLessThanOrEqual(90)
    expect(window.resetAfterSeconds).toBeGreaterThan(80)
  })

  test("toUsageWindow clamps and null-safes non-finite input", () => {
    const window = toUsageWindow({ usedPercent: Number.POSITIVE_INFINITY, resetAt: Number.NaN })
    expect(window.usedPercent).toBe(null)
    expect(window.remainingPercent).toBe(null)
    expect(window.resetAt).toBe(null)
    expect(window.resetAfterSeconds).toBe(null)
    const over = toUsageWindow({ usedPercent: 140 })
    expect(over.usedPercent).toBe(100)
    expect(over.remainingPercent).toBe(0)
  })

  test("buildResult fills the envelope defaults", () => {
    const result = buildResult({ providerId: "p", providerName: "P", ok: true, configured: true })
    expect(result.usage).toBe(null)
    expect(typeof result.fetchedAt).toBe("number")
    expect("error" in result).toBe(false)
    const pinned = buildResult({ providerId: "p", providerName: "P", ok: false, configured: true, error: "x", fetchedAt: 123 })
    expect(pinned.fetchedAt).toBe(123)
    expect(pinned.error).toBe("x")
  })

  test("computeUsedPercent follows the Kimi precedence rules", () => {
    expect(computeUsedPercent(100, 30, null)).toBe(30)
    expect(computeUsedPercent(100, null, 25)).toBe(75)
    expect(computeUsedPercent(100, 30, 25)).toBe(30)
    expect(computeUsedPercent(100, null, null)).toBe(null)
    expect(computeUsedPercent(0, 10, 10)).toBe(null)
    expect(computeUsedPercent(null, 10, 10)).toBe(null)
    expect(computeUsedPercent(100, 250, null)).toBe(100)
  })

  test("duration helpers map unit codes to labels and seconds", () => {
    expect(durationToSeconds(5, 3)).toBe(5 * 3600)
    expect(durationToSeconds(2, 6)).toBe(2 * 86400)
    expect(durationToSeconds(5, 1)).toBe(300)
    expect(durationToSeconds(5, 99)).toBe(null)
    expect(durationToSeconds(null, 3)).toBe(null)
    expect(durationToLabel(5, 3)).toBe("5h")
    expect(durationToLabel(30, 1)).toBe("30m")
    expect(durationToLabel(2, 6)).toBe("2d")
    expect(durationToLabel(5, 99)).toBe("limit")
  })
})
