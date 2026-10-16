import { describe, expect, test } from "bun:test"
import { estimateOxpApiCosts, formatOxpDollar, valueOxpApiUsage, OXP_API_MODELS } from "./oxp-api-equivalent"

const baseline = { surroundingOutputPercent: 10, cachedInputPercent: 0, contextTier: "short" } as const

describe("OXP counterfactual API valuation", () => {
  test("matches published Standard short-context model IDs and rates", () => {
    expect(OXP_API_MODELS.map((model) => [model.id, model.input, model.cachedInput, model.output])).toEqual([
      ["gpt-6-luna", 0.1, 0.01, 0.5],
      ["gpt-6-sol", 2, 0.2, 10],
      ["gpt-6-astra", 10, 1, 50],
      ["gpt-6.1-sol", 2, 0.1, 10],
    ])
  })

  test("prices both OXP request and result payloads as model input, never output", () => {
    const cost = valueOxpApiUsage(OXP_API_MODELS[2], { oxp: 1_000_000, surrounding: 0 }, baseline)
    expect(cost.oxp).toBe(10)
    expect(cost.surrounding).toBe(0)
    expect(cost.total).toBe(10)
  })

  test("keeps OXP, surrounding, combined additive with explicit output scenario", () => {
    const model = OXP_API_MODELS[1]
    const low = valueOxpApiUsage(model, { oxp: 1_000_000, surrounding: 1_000_000 }, {
      ...baseline, surroundingOutputPercent: 0,
    })
    const high = valueOxpApiUsage(model, { oxp: 1_000_000, surrounding: 1_000_000 }, {
      ...baseline, surroundingOutputPercent: 100,
    })
    const reference = valueOxpApiUsage(model, { oxp: 1_000_000, surrounding: 1_000_000 }, baseline)
    expect([low.oxp, low.surrounding, low.total]).toEqual([2, 2, 4])
    expect([high.oxp, high.surrounding, high.total]).toEqual([2, 10, 12])
    expect(reference.oxp).toBe(2)
    expect(reference.surrounding).toBeCloseTo(2.8, 10)
    expect(reference.total).toBeCloseTo(4.8, 10)
  })

  test("models input caching separately from output and distinguishes Sol generations", () => {
    const scenario = { ...baseline, cachedInputPercent: 100, surroundingOutputPercent: 100 }
    const oldSol = valueOxpApiUsage(OXP_API_MODELS[1], { oxp: 1_000_000, surrounding: 1_000_000 }, scenario)
    const newSol = valueOxpApiUsage(OXP_API_MODELS[3], { oxp: 1_000_000, surrounding: 1_000_000 }, scenario)
    expect([oldSol.oxp, oldSol.surrounding]).toEqual([2, 10])
    expect([newSol.oxp, newSol.surrounding]).toEqual([2, 10])
    // Prompt-level cached input is not evidence that *new OXP tool payloads*
    // were cached by the unseen upstream API. They have independent assumptions.
    expect(valueOxpApiUsage(OXP_API_MODELS[1], { oxp: 1_000_000, surrounding: 0 }, {
      ...scenario, oxpCachedInputPercent: 100,
    }).oxp).toBe(0.2)
  })

  test("long-context tier reprices the whole counterfactual request", () => {
    const model = OXP_API_MODELS[0]
    const cost = valueOxpApiUsage(model, { oxp: 1_000_000, surrounding: 1_000_000 }, {
      surroundingOutputPercent: 100, cachedInputPercent: 0, contextTier: "long",
    })
    expect(cost.inputRate).toBe(0.2)
    expect(cost.outputRate).toBe(0.75)
    expect(cost.total).toBeCloseTo(0.95, 10)
  })

  test("guards nonfinite input and assumption values; keeps the fixed comparison set", () => {
    expect(estimateOxpApiCosts({ oxp: Number.NaN, surrounding: -1 }, {
      surroundingOutputPercent: Number.NaN, cachedInputPercent: Infinity, contextTier: "short",
    }).map((entry) => entry.total)).toEqual([0, 0, 0, 0])
    expect(estimateOxpApiCosts({ oxp: 1000, surrounding: 100 }, baseline)).toHaveLength(4)
    expect(formatOxpDollar(0)).toBe("$0.00")
    expect(formatOxpDollar(0.00001)).toBe("<$0.0001")
  })
})
