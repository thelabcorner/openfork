import { describe, expect, test } from "bun:test"
import { roundWorkBuddyRate } from "./workbuddy-limits"

/**
 * Regression for the `x1.563970588235294` picker badge.
 *
 * WorkBuddy publishes per-request rates as short decimals (`x0.03`, `x1.33`),
 * but the picker can also show a rate measured from real usage, computed as
 * `creditsObserved / usedObserved`. That integer division produced a raw
 * full-precision float and leaked it straight into the `x<rate>` badge for the
 * two `hy4-preview` rows, while every catalog-priced row stayed clean.
 *
 * These cases pin the normalization rule the producer must apply, and prove the
 * previously-correct values are untouched.
 */

describe("roundWorkBuddyRate", () => {
  test("rounds the observed Hy4 average to two decimals", () => {
    // 266 / 170 = 1.5647058823529412 — the exact class of leaked value.
    const observed = 266 / 170
    expect(observed).not.toBe(1.56)
    expect(roundWorkBuddyRate(observed)).toBe(1.56)
    expect(`x${roundWorkBuddyRate(observed)}`).toBe("x1.56")
  })

  test("keeps already-rounded catalog-style rates exactly as published", () => {
    // These are the sane multipliers from the catalog; none may shift.
    expect(roundWorkBuddyRate(0.03)).toBe(0.03)
    expect(roundWorkBuddyRate(0.06)).toBe(0.06)
    expect(roundWorkBuddyRate(0.77)).toBe(0.77)
    expect(roundWorkBuddyRate(1.33)).toBe(1.33)
    expect(roundWorkBuddyRate(1.6)).toBe(1.6)
    expect(roundWorkBuddyRate(1.9)).toBe(1.9)
  })

  test("rounds at the third decimal to the nearest hundredth", () => {
    expect(roundWorkBuddyRate(0.125)).toBe(0.13)
    expect(roundWorkBuddyRate(2.999)).toBe(3)
    expect(roundWorkBuddyRate(0.071)).toBe(0.07)
  })

  test("passes non-finite and non-positive rates through unchanged", () => {
    // Callers rely on these to keep their own "unknown / free" handling.
    expect(roundWorkBuddyRate(0)).toBe(0)
    expect(roundWorkBuddyRate(-1)).toBe(-1)
    expect(Number.isNaN(roundWorkBuddyRate(Number.NaN))).toBe(true)
    expect(roundWorkBuddyRate(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })
})
