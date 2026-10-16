import { describe, expect, test } from "bun:test"
import { planCacheAdmission, type CacheForecast } from "../src/cache-frontier"
import { planCacheAdmissionDP } from "../src/cache-frontier-dp"

let seed = 0x7baff216
function random() {
  seed = (Math.imul(seed, 22695477) + 1) >>> 0
  return seed / 0x100000000
}

describe("LACE v14.7 dynamic-programming optimizer differential proof", () => {
  test("matches exhaustive oracle across 500 generated price, retention and prefix traces", () => {
    for (let trial = 0; trial < 500; trial++) {
      const initialTokens = 6000 + Math.floor(random() * 4000)
      const n = 2 + Math.floor(random() * 7)
      const boundaries = Array.from({ length: n }, (_, i) => Math.floor((i + 1) * initialTokens / n))
      const forecast: CacheForecast = {
        initialTokens,
        candidateBoundaries: boundaries,
        rates: { ordinary: 1, write: 0.8 + random() * 1.0, read: random() * 0.7 },
        maxBreakpoints: 1 + Math.floor(random() * 4),
        minimumCacheableTokens: 1000,
        minimumSavingsFraction: random() * 0.1,
        future: Array.from({ length: Math.floor(random() * 12) }, () => {
          const totalTokens = Math.floor(random() * 18000)
          return {
            probability: random(),
            totalTokens,
            sharedPrefixTokens: Math.floor(random() * (Math.min(initialTokens, totalTokens) + 1)),
            residencyProbability: random(),
          }
        }),
      }
      const exhaustive = planCacheAdmission(forecast)
      const dp = planCacheAdmissionDP(forecast)
      expect(dp.uncachedCost).toBeCloseTo(exhaustive.uncachedCost, 7)
      expect(dp.projectedCost).toBeCloseTo(exhaustive.projectedCost, 7)
      expect(dp.projectedSavings).toBeCloseTo(exhaustive.projectedSavings, 7)
      expect(dp.boundaries.length).toBeLessThanOrEqual(forecast.maxBreakpoints)
      expect(dp.evaluatedTransitions).toBeLessThanOrEqual(exhaustive.evaluatedPlans)
    }
  })

  test("24 boundaries reduce search from 12,951 plans to fewer than 1,000 transitions", () => {
    const input: CacheForecast = {
      initialTokens: 24_000,
      candidateBoundaries: Array.from({ length: 24 }, (_, i) => (i + 1) * 1000),
      maxBreakpoints: 4,
      minimumCacheableTokens: 1000,
      rates: { ordinary: 1, write: 1.25, read: 0.1 },
      future: Array.from({ length: 8 }, (_, i) => ({
        probability: 1 - i * 0.1,
        totalTokens: 26000,
        sharedPrefixTokens: i % 2 ? 12000 : 24000,
        residencyProbability: 0.85,
      })),
    }
    const oracle = planCacheAdmission(input)
    const dp = planCacheAdmissionDP(input)
    expect(dp.projectedCost).toBeCloseTo(oracle.projectedCost, 7)
    expect(oracle.evaluatedPlans).toBe(12_951)
    expect(dp.evaluatedTransitions).toBeLessThan(1000)
  })

  test("rejects one-shot premium writes and respects compatibility guards", () => {
    const input: CacheForecast = {
      initialTokens: 10000,
      candidateBoundaries: [2000, 5000, 10000],
      maxBreakpoints: 4,
      rates: { ordinary: 1, write: 1.25, read: 0.1 },
      future: [],
    }
    expect(planCacheAdmissionDP(input).boundaries).toEqual([])
    expect(() => planCacheAdmissionDP({ ...input, maxBreakpoints: 5 })).toThrow(RangeError)
    expect(() => planCacheAdmissionDP({ ...input, future: [{ probability: 1, residencyProbability: -1, totalTokens: 12000, sharedPrefixTokens: 10000 }] })).toThrow(RangeError)
  })
})
