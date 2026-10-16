import { describe, expect, test } from "bun:test"
import { commonPrefixBytes, planCacheAdmission, type CacheForecast } from "../src/cache-frontier"

let seed = 0x253597b1
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0x100000000
}
function fragments(value: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = []
  for (let i = 0; i < value.length;) {
    const width = 1 + Math.floor(random() * 15)
    result.push(value.subarray(i, i + width))
    i += width
    if (random() < 0.15) result.push(new Uint8Array())
  }
  return result
}

describe("LACE v14.7 property/regression cases", () => {
  test("random byte witnesses agree with a naive flat oracle in 500 cases", () => {
    for (let n = 0; n < 500; n++) {
      const a = Uint8Array.from({ length: Math.floor(random() * 128) }, () => Math.floor(random() * 16))
      const b = Uint8Array.from({ length: Math.floor(random() * 128) }, (_, i) =>
        i < a.length && random() < 0.9 ? a[i]! : Math.floor(random() * 16))
      let count = 0
      while (count < a.length && count < b.length && a[count] === b[count]) count++
      expect(commonPrefixBytes(fragments(a), fragments(b))).toEqual({
        bytes: count,
        identical: count === a.length && count === b.length,
      })
    }
  })

  test("planner never selects a result worse than the uncached baseline in 200 seeded workloads", () => {
    const rates = { ordinary: 1, write: 1.25, read: 0.1 }
    for (let n = 0; n < 200; n++) {
      const input: CacheForecast = {
        initialTokens: 10000,
        candidateBoundaries: [1500, 3000, 5000, 7000, 10000],
        maxBreakpoints: 1 + Math.floor(random() * 4),
        rates,
        minimumCacheableTokens: 1024,
        minimumSavingsFraction: random() * 0.10,
        future: Array.from({ length: 1 + Math.floor(random() * 10) }, () => ({
          probability: random(),
          totalTokens: 10000 + Math.floor(random() * 5000),
          sharedPrefixTokens: Math.floor(random() * 10001),
          residencyProbability: random(),
        })),
      }
      const plan = planCacheAdmission(input)
      expect(plan.projectedCost).toBeLessThanOrEqual(plan.uncachedCost)
      expect(plan.boundaries.length).toBeLessThanOrEqual(input.maxBreakpoints)
      expect(plan.boundaries).toEqual([...plan.boundaries].sort((a, b) => a - b))
      expect(plan.projectedSavings).toBeGreaterThanOrEqual(0)
      expect(planCacheAdmission(input)).toEqual(plan)
    }
  })

  test("24 candidates and four markers have a finite exact exploration bound", () => {
    const plan = planCacheAdmission({
      initialTokens: 24000,
      candidateBoundaries: Array.from({ length: 24 }, (_, i) => (i + 1) * 1000),
      maxBreakpoints: 4,
      rates: { ordinary: 1, write: 1.25, read: 0.1 },
      future: [],
    })
    expect(plan.evaluatedPlans).toBe(12951)
    expect(plan.boundaries).toEqual([])
  })
})
