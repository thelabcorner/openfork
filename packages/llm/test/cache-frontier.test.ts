import { describe, expect, test } from "bun:test"
import { commonPrefixBytes, evaluateShadowPromotion, planCacheAdmission, type CacheForecast } from "../src/cache-frontier"

const rates = { ordinary: 1, write: 1.25, read: 0.1 }
const make = (overrides: Partial<CacheForecast> = {}): CacheForecast => ({
  initialTokens: 8000,
  candidateBoundaries: [2000, 4000, 8000],
  maxBreakpoints: 4,
  minimumCacheableTokens: 1024,
  rates,
  future: [{ probability: 1, totalTokens: 8500, sharedPrefixTokens: 8000, residencyProbability: 1 }],
  ...overrides,
})

describe("LACE v14.7 cache frontier", () => {
  test("exact byte prefix across different fragmentations", () => {
    const encode = new TextEncoder()
    const a = [encode.encode("abc"), encode.encode("def")]
    expect(commonPrefixBytes(a, [encode.encode("abcdef")])).toEqual({ bytes: 6, identical: true })
    expect(commonPrefixBytes(a, [encode.encode("abcdez")])).toEqual({ bytes: 5, identical: false })
    expect(commonPrefixBytes(a, [encode.encode("abcd")])).toEqual({ bytes: 4, identical: false })
    expect(commonPrefixBytes([encode.encode("hi😀")], [encode.encode("hi😁")])).toEqual({ bytes: 5, identical: false })
    expect(commonPrefixBytes([new Uint8Array()], [])).toEqual({ bytes: 0, identical: true })
  })

  test("amortizes one write against an actual warm read", () => {
    const plan = planCacheAdmission(make())
    expect(plan.uncachedCost).toBe(16500)
    expect(plan.boundaries).toEqual([8000])
    expect(plan.projectedCost).toBeCloseTo(11300)
    expect(plan.projectedSavings).toBeCloseTo(5200)
  })

  test("refuses speculative cache writes when no reuse is forecast", () => {
    expect(planCacheAdmission(make({ future: [] })).boundaries).toEqual([])
    expect(planCacheAdmission(make({ future: [
      { probability: 1, totalTokens: 8500, sharedPrefixTokens: 8000, residencyProbability: 0 },
    ] })).boundaries).toEqual([])
    expect(planCacheAdmission(make({ future: [
      { probability: 1, totalTokens: 8500, sharedPrefixTokens: 0, residencyProbability: 1 },
    ] })).boundaries).toEqual([])
  })

  test("finds both long and short reusable boundaries", () => {
    const result = planCacheAdmission(make({ future: [
      { probability: 1, totalTokens: 8500, sharedPrefixTokens: 4000, residencyProbability: 1 },
      { probability: 1, totalTokens: 8500, sharedPrefixTokens: 8000, residencyProbability: 1 },
    ] }))
    expect(result.boundaries).toEqual([4000, 8000])
  })

  test("does not select an economically fragile plan", () => {
    expect(planCacheAdmission(make({ minimumSavingsFraction: 0.99 })).boundaries).toEqual([])
    expect(planCacheAdmission(make({ minimumSavingsCost: 6000 })).boundaries).toEqual([])
    expect(planCacheAdmission(make({ future: [
      { probability: 0.05, totalTokens: 8500, sharedPrefixTokens: 8000, residencyProbability: 1 },
    ] })).boundaries).toEqual([])
  })

  test("fails closed on bad forecast data", () => {
    expect(() => planCacheAdmission(make({ rates: { ordinary: 1, write: -1, read: 0.1 } }))).toThrow(RangeError)
    expect(() => planCacheAdmission(make({ candidateBoundaries: [8001] }))).toThrow(RangeError)
    expect(() => planCacheAdmission(make({ future: [
      { probability: Number.NaN, totalTokens: 8500, sharedPrefixTokens: 8000, residencyProbability: 1 },
    ] }))).toThrow(RangeError)
  })

  test("does not promote a shadow without correctness authorization", () => {
    const args = { correctAndCompatible: true, warmExpectedCost: 100, shadowExpectedCost: 40, preparationCost: 20, transitionCost: 10 }
    expect(evaluateShadowPromotion(args).promote).toBe(true)
    expect(evaluateShadowPromotion({ ...args, correctAndCompatible: false }).promote).toBe(false)
    expect(evaluateShadowPromotion({ ...args, preparationCost: 100 }).promote).toBe(false)
  })
})
