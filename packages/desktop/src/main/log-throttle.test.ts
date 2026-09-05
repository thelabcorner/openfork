import { describe, expect, test } from "bun:test"
import { createLogThrottle } from "./log-throttle"

describe("log throttle", () => {
  test("admits a burst then sheds sustained overflow", () => {
    const throttle = createLogThrottle({ burst: 3, ratePerSec: 10 })
    const now = 1_000_000
    expect(throttle.guard("info", now)).toEqual({ pass: true, suppressed: 0 })
    expect(throttle.guard("info", now)).toEqual({ pass: true, suppressed: 0 })
    expect(throttle.guard("info", now)).toEqual({ pass: true, suppressed: 0 })
    expect(throttle.guard("info", now)).toEqual({ pass: false, suppressed: 0 })
    expect(throttle.guard("info", now)).toEqual({ pass: false, suppressed: 0 })
  })

  test("refills over time and reports exact suppression count once", () => {
    const throttle = createLogThrottle({ burst: 1, ratePerSec: 10 })
    const now = 1_000_000
    expect(throttle.guard("info", now).pass).toBe(true)
    expect(throttle.guard("info", now).pass).toBe(false)
    expect(throttle.guard("info", now).pass).toBe(false)
    // 200ms at 10/sec refills 2 tokens, capped at burst 1.
    const verdict = throttle.guard("info", now + 200)
    expect(verdict).toEqual({ pass: true, suppressed: 2 })
    // Counter resets after being reported.
    expect(throttle.guard("info", now + 200)).toEqual({ pass: false, suppressed: 0 })
  })

  test("error and warn always pass, even on an empty bucket", () => {
    const throttle = createLogThrottle({ burst: 1, ratePerSec: 0 })
    const now = 1_000_000
    expect(throttle.guard("info", now).pass).toBe(true)
    expect(throttle.guard("info", now).pass).toBe(false)
    expect(throttle.guard("error", now)).toEqual({ pass: true, suppressed: 1 })
    expect(throttle.guard("warn", now)).toEqual({ pass: true, suppressed: 0 })
  })

  test("a passing error flushes pending suppression accounting", () => {
    const throttle = createLogThrottle({ burst: 1, ratePerSec: 1000 })
    const now = 1_000_000
    expect(throttle.guard("info", now).pass).toBe(true)
    expect(throttle.guard("info", now).pass).toBe(false)
    expect(throttle.guard("info", now).pass).toBe(false)
    expect(throttle.guard("error", now + 5)).toEqual({ pass: true, suppressed: 2 })
  })

  test("clamped refill never exceeds the burst", () => {
    const throttle = createLogThrottle({ burst: 2, ratePerSec: 1000 })
    const now = 1_000_000
    expect(throttle.guard("info", now).pass).toBe(true)
    expect(throttle.guard("info", now).pass).toBe(true)
    // Long idle refills to burst (2), not beyond: third line still drops.
    expect(throttle.guard("info", now + 60_000).pass).toBe(true)
    expect(throttle.guard("info", now + 60_000).pass).toBe(true)
    expect(throttle.guard("info", now + 60_000).pass).toBe(false)
  })

  test("rejects non-numeric configuration", () => {
    expect(() => createLogThrottle({ burst: -1, ratePerSec: 10 })).toThrow()
    expect(() => createLogThrottle({ burst: 10, ratePerSec: -1 })).toThrow()
    expect(() => createLogThrottle({ burst: Number.NaN, ratePerSec: 10 })).toThrow()
  })
})
