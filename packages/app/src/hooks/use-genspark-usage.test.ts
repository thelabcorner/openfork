import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { useGensparkUsage } from "./use-genspark-usage"
import type { LimitsState } from "./use-limits"

/**
 * Genspark bills in credits and publishes no token price for most models. The
 * tests below pin the one rule that matters: a real balance may be shown, a rate
 * nobody published may not. A missing price must produce `undefined`, never a
 * plausible-looking $/M. Request counts are intentionally outside this hook:
 * the server Capacity owner has the real workload/resource denominator.
 */

function limitsWith(valueLabel?: string): LimitsState {
  return {
    providers: () => [
      {
        result: {
          providerId: "genspark",
          ...(valueLabel
            ? { usage: { windows: { credits: { valueLabel } } } }
            : { usage: { windows: {} } }),
        },
      },
    ],
  } as unknown as LimitsState
}

function hookWith(valueLabel?: string) {
  const limits = limitsWith(valueLabel)
  return createRoot(() => useGensparkUsage({ limits }))
}

describe("useGensparkUsage rateFor", () => {
  test("converts a published dollar price into credits at 375 credits/$1", () => {
    const genspark = hookWith("10,270.85 credits")
    expect(genspark.rateFor(0.6)).toEqual({ creditsPerM: 225, dollarsPerM: 0.6 })
    expect(genspark.rateFor(2)).toEqual({ creditsPerM: 750, dollarsPerM: 2 })
  })

  test("reports no rate at all when Genspark publishes none", () => {
    const genspark = hookWith("10,270.85 credits")
    // An unpriced catalog entry is the normal Genspark case. Every shape of
    // "no published price" must fail closed.
    expect(genspark.rateFor(undefined)).toBeUndefined()
    expect(genspark.rateFor(null)).toBeUndefined()
    expect(genspark.rateFor(0)).toBeUndefined()
    expect(genspark.rateFor(Number.NaN)).toBeUndefined()
    expect(genspark.rateFor(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(genspark.rateFor(-1)).toBeUndefined()
  })

  test("an absent quota snapshot removes the balance but not the published-price conversion", () => {
    // No Genspark quota row at all: nothing measured, but a caller that DOES hold
    // a published price still gets the honest conversion rather than a fallback.
    const genspark = createRoot(() => useGensparkUsage({ limits: { providers: () => [] } as unknown as LimitsState }))
    expect(genspark.rateFor(0.6)).toEqual({ creditsPerM: 225, dollarsPerM: 0.6 })
    expect(genspark.forModel(0.6)).toBeUndefined()
    expect(genspark.forModel(undefined)).toBeUndefined()
  })
})

describe("useGensparkUsage forModel", () => {
  test("keeps the real balance and omits everything derived from a missing rate", () => {
    const genspark = hookWith("10,270.85 credits")
    const usage = genspark.forModel(undefined)
    // The balance is measured, so it survives.
    expect(usage?.remainingCredits).toBe(10_270.85)
    // The rate is absent because nobody published one.
    expect(usage?.rateCreditsPerM).toBeUndefined()
    expect(usage?.rateDollarsPerM).toBeUndefined()
    // No request-count field exists here at all.
    expect(Object.keys(usage ?? {})).toEqual(["remainingCredits"])
  })

  test("keeps a published credit rate but leaves request counts to server Capacity", () => {
    const genspark = hookWith("10,270.85 credits")
    const usage = genspark.forModel(0.6)
    expect(usage?.rateCreditsPerM).toBe(225)
    expect(usage?.rateDollarsPerM).toBe(0.6)
    expect(usage).toEqual({
      remainingCredits: 10_270.85,
      rateCreditsPerM: 225,
      rateDollarsPerM: 0.6,
    })
  })

  test("returns nothing when there is no observed balance", () => {
    const genspark = hookWith(undefined)
    expect(genspark.remainingCredits()).toBeUndefined()
    expect(genspark.forModel(0.6)).toBeUndefined()
  })
})