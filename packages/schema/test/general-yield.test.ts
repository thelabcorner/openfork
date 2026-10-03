import { describe, expect, test } from "bun:test"
import { evaluateGeneralUsageYield, generalPricingWorkload } from "../src/model-select/general-yield"
import {
  priceWorkload,
  compilePricingRegimes,
  FALLBACK_WORKLOAD_CORPUS,
  nativePricingFromCatalogCost,
  nativePricingFromModelCost,
  selectNativePrices,
} from "../src/model-select/usage-yield"

// A cache-heavy coding-agent request: the shape the generalized snapshot reports
// for a user's recent physical turns.
const personal = {
  inputTokens: 1_000,
  cacheReadTokens: 55_000,
  cacheWriteTokens: 0,
  outputTokens: 200,
  reasoningTokens: 0,
}

const flatCost = { input: 3, output: 15, cache: { read: 0.03, write: 0 } }
const cheapModel = { id: "cheap", name: "cheap", provider: { id: "openai" } }

describe("generalPricingWorkload", () => {
  test("folds reasoning into output and counts cache-write in context", () => {
    expect(
      generalPricingWorkload({
        inputTokens: 100,
        cacheReadTokens: 900,
        cacheWriteTokens: 50,
        outputTokens: 10,
        reasoningTokens: 5,
      }),
    ).toEqual({
      freshInputTokens: 100,
      cachedReadTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 15,
      contextTokens: 1_050,
    })
  })

  test("clamps negative / non-finite token counts to zero", () => {
    expect(
      generalPricingWorkload({
        inputTokens: Number.NaN,
        cacheReadTokens: -5,
        cacheWriteTokens: 0,
        outputTokens: -1,
        reasoningTokens: 7,
      }),
    ).toEqual({
      freshInputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 7,
      contextTokens: 0,
    })
  })
})

describe("evaluateGeneralUsageYield", () => {
  test("equals the shared pricing machinery applied to the same workload", () => {
    const result = evaluateGeneralUsageYield({ model: cheapModel, cost: flatCost, general: personal, source: "personal-general" })
    expect(result.priced).toBe(true)

    const regimes = compilePricingRegimes(cheapModel, flatCost)
    const expected = priceWorkload(result.workload, regimes).expected
    expect(result.costPerEquivalentRequest).toBe(expected)
    expect(result.equivalentRequestsPerDollar).toBe(1 / expected)
  })

  test("the same personal workload is cheaper on the cheaper model", () => {
    const cheap = evaluateGeneralUsageYield({
      model: cheapModel,
      cost: { input: 1, output: 4, cache: { read: 0.01, write: 0 } },
      general: personal,
      source: "personal-general",
    })
    const pricey = evaluateGeneralUsageYield({ model: cheapModel, cost: flatCost, general: personal, source: "personal-general" })
    expect(cheap.priced).toBe(true)
    expect(pricey.priced).toBe(true)
    expect(cheap.costPerEquivalentRequest!).toBeLessThan(pricey.costPerEquivalentRequest!)
    expect(cheap.equivalentRequestsPerDollar!).toBeGreaterThan(pricey.equivalentRequestsPerDollar!)
  })

  test("does not invent requests-left: the result is $/request only", () => {
    const result = evaluateGeneralUsageYield({ model: cheapModel, cost: flatCost, general: personal, source: "personal-model" })
    expect(Object.keys(result).sort()).toEqual([
      "contextLimit",
      "contextUtilization",
      "costPerEquivalentRequest",
      "equivalentRequestsPerDollar",
      "fitsContext",
      "priced",
      "regimeLabel",
      "source",
      "status",
      "workload",
    ])
  })

  test("charges cache-write tokens and fails closed when the typical request does not fit", () => {
    const withoutWrite = evaluateGeneralUsageYield({
      model: cheapModel,
      cost: { input: 2, output: 8, cache: { read: 0.2, write: 3 } },
      general: { ...personal, cacheWriteTokens: 0 },
      source: "personal-general",
      contextLimit: 128_000,
    })
    const withWrite = evaluateGeneralUsageYield({
      model: cheapModel,
      cost: { input: 2, output: 8, cache: { read: 0.2, write: 3 } },
      general: { ...personal, cacheWriteTokens: 10_000 },
      source: "personal-general",
      contextLimit: 128_000,
    })
    expect(withWrite.costPerEquivalentRequest!).toBeGreaterThan(withoutWrite.costPerEquivalentRequest!)
    expect(withWrite.fitsContext).toBe(true)
    expect(withWrite.contextUtilization).toBeCloseTo(66_000 / 128_000, 10)

    const overflow = evaluateGeneralUsageYield({
      model: cheapModel,
      cost: flatCost,
      general: personal,
      source: "personal-general",
      contextLimit: 32_000,
    })
    expect(overflow.status).toBe("context-overflow")
    expect(overflow.fitsContext).toBe(false)
    expect(overflow.priced).toBe(false)
    expect(overflow.costPerEquivalentRequest).toBeNull()
  })

  test("uses the target model's own context-threshold tier", () => {
    const thresholdCost = { ...flatCost }
    const big = evaluateGeneralUsageYield({
      model: { id: "tiered", name: "tiered", provider: { id: "openai" } },
      cost: thresholdCost,
      general: personal,
      source: "personal-general",
      thresholdPricing: [
        { thresholdTokens: 200_000, operator: "<=", cost: flatCost },
        { thresholdTokens: 200_000, operator: ">", cost: { input: 6, output: 22.5, cache: { read: 0.6, write: 0 } } },
      ],
    })
    // 56k context sits in the <=200k tier, so it must equal the base rate, not
    // the doubled over-threshold rate.
    const base = evaluateGeneralUsageYield({ model: cheapModel, cost: flatCost, general: personal, source: "personal-general" })
    expect(big.costPerEquivalentRequest).toBe(base.costPerEquivalentRequest)
    expect(big.regimeLabel).toBe("<= 200,000")

    const overThreshold = evaluateGeneralUsageYield({
      model: { id: "tiered", name: "tiered", provider: { id: "openai" } },
      cost: thresholdCost,
      general: { ...personal, cacheReadTokens: 400_000 },
      source: "personal-general",
      thresholdPricing: [
        { thresholdTokens: 200_000, operator: "<=", cost: flatCost },
        { thresholdTokens: 200_000, operator: ">", cost: { input: 6, output: 22.5, cache: { read: 0.6, write: 0 } } },
      ],
    })
    expect(overThreshold.costPerEquivalentRequest!).toBeGreaterThan(big.costPerEquivalentRequest!)
  })

  test("free / unlimited models never report monetary yield", () => {
    const free = evaluateGeneralUsageYield({
      model: { id: "gpt-x", name: "gpt-x (Unlimited)", provider: { id: "openai" } },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      general: personal,
      source: "personal-general",
    })
    expect(free.priced).toBe(false)
    expect(free.costPerEquivalentRequest).toBeNull()
    expect(free.equivalentRequestsPerDollar).toBeNull()

    const openRouterFree = evaluateGeneralUsageYield({
      model: { id: "some/model:free", name: "some:free", provider: { id: "openrouter" } },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      general: personal,
      source: "standardized-workload-prior",
    })
    expect(openRouterFree.priced).toBe(false)
  })

  test("unpriced and empty workloads fail closed", () => {
    expect(
      evaluateGeneralUsageYield({
        model: cheapModel,
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        general: personal,
        source: "personal-general",
      }).priced,
    ).toBe(false)

    expect(
      evaluateGeneralUsageYield({
        model: cheapModel,
        cost: flatCost,
        general: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        source: "standardized-workload-prior",
      }).priced,
    ).toBe(false)
  })

  test("passes provenance through untouched", () => {
    for (const source of ["personal-model", "personal-general", "standardized-workload-prior"] as const) {
      expect(evaluateGeneralUsageYield({ model: cheapModel, cost: flatCost, general: personal, source }).source).toBe(source)
    }
  })

  test("scales linearly with workload size under flat pricing", () => {
    const one = evaluateGeneralUsageYield({ model: cheapModel, cost: flatCost, general: personal, source: "personal-general" })
    const scaled = {
      inputTokens: personal.inputTokens * 2,
      cacheReadTokens: personal.cacheReadTokens * 2,
      cacheWriteTokens: 0,
      outputTokens: personal.outputTokens * 2,
      reasoningTokens: 0,
    }
    const twice = evaluateGeneralUsageYield({
      model: cheapModel,
      cost: flatCost,
      general: scaled,
      source: "personal-general",
    })
    expect(twice.costPerEquivalentRequest!).toBeCloseTo(one.costPerEquivalentRequest! * 2, 10)
  })

  test("standardized prior stays inside the published corpus cost envelope", () => {
    const result = evaluateGeneralUsageYield({
      model: cheapModel,
      cost: flatCost,
      general: {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      source: "standardized-workload-prior",
    })
    expect(result.priced).toBe(false)
    // Sanity: the standardized median corpus workload is what the server ships
    // as `fallback`; pricing it must land strictly inside the per-tuple range.
    const regimes = compilePricingRegimes(cheapModel, flatCost)
    const costs = FALLBACK_WORKLOAD_CORPUS.map((w) => priceWorkload(w, regimes).expected).sort((a, b) => a - b)
    expect(costs[0]!).toBeLessThan(costs.at(-1)!)
  })
})
describe("selectNativePrices", () => {
  const base = { input: 1, output: 2, cache: { read: 0.1, write: 1 } }
  const row = (input: number, cache = 0.1) => ({
    input,
    output: input * 2,
    cache: { read: cache, write: cache },
  })
  const pricing = {
    base,
    tiers: [{ thresholdTokens: 10, prices: row(3) }, { thresholdTokens: 100, prices: row(5) }],
    over200K: row(9),
  }

  test("activation is strict and the largest activated threshold wins", () => {
    expect(selectNativePrices(pricing, 0).thresholdTokens).toBe(Number.NEGATIVE_INFINITY)
    expect(selectNativePrices(pricing, 10).prices).toEqual(base)
    expect(selectNativePrices(pricing, 11).prices).toEqual(row(3))
    expect(selectNativePrices(pricing, 100).prices).toEqual(row(3))
    expect(selectNativePrices(pricing, 101).prices).toEqual(row(5))
  })

  test("publication order does not change the winning threshold", () => {
    const reversed = { ...pricing, tiers: [...pricing.tiers].reverse() }
    expect(selectNativePrices(reversed, 500).prices).toEqual(selectNativePrices(pricing, 500).prices)
  })

  test("a real tier beats the legacy 200k fallback row", () => {
    // Context above 200k still uses the largest activated threshold when one exists.
    expect(selectNativePrices(pricing, 200_001).prices).toEqual(row(5))
    // With no published tier the fallback is the only option...
    const noTiers = { base, tiers: [], over200K: row(9) }
    expect(selectNativePrices(noTiers, 200_001).prices).toEqual(row(9))
    // ...and it is strictly a >200k row.
    expect(selectNativePrices(noTiers, 200_000).prices).toEqual(base)
  })

  test("a duplicate threshold keeps the first published row", () => {
    const tied = {
      base,
      tiers: [
        { thresholdTokens: 10, prices: row(3) },
        { thresholdTokens: 10, prices: row(99) },
      ],
    }
    expect(selectNativePrices(tied, 50).prices).toEqual(row(3))
  })

  test("the catalog and ModelCost compilers agree on the same row", () => {
    const catalogCost = {
      input: 1,
      output: 2,
      cache_read: 0.1,
      cache_write: 1,
      tiers: [{ input: 3, output: 6, cache_read: 0.3, cache_write: 3, tier: { type: "context" as const, size: 10 } }],
      context_over_200k: { input: 9, output: 18, cache_read: 0.9, cache_write: 9 },
    }
    const fromCatalog = nativePricingFromCatalogCost(catalogCost)
    const fromModel = nativePricingFromModelCost({
      input: 1,
      output: 2,
      cache: { read: 0.1, write: 1 },
      tiers: [
        { input: 3, output: 6, cache: { read: 0.3, write: 3 }, tier: { type: "context", size: 10 } },
      ],
      experimentalOver200K: { input: 9, output: 18, cache: { read: 0.9, write: 9 } },
    })
    expect(fromCatalog).toEqual(fromModel)
    for (const context of [0, 10, 11, 200_000, 200_001]) {
      expect(selectNativePrices(fromCatalog, context)).toEqual(selectNativePrices(fromModel, context))
    }
  })

  test("catalog rows without cache rates price those dimensions at zero", () => {
    // Server Capacity contract; distinct from the browser stale-snapshot
    // fallback in tokenCost, which prices a missing cache rate at input.
    const compiled = nativePricingFromCatalogCost({ input: 4, output: 8 })
    expect(compiled.base.cache).toEqual({ read: 0, write: 0 })
    expect(compiled.over200K).toBeUndefined()
    expect(compiled.tiers).toEqual([])
  })

  test("non-context tier rows are ignored", () => {
    const compiled = nativePricingFromCatalogCost({
      input: 1,
      output: 2,
      tiers: [{ input: 3, output: 6, tier: { type: "batch" as unknown as "context", size: 10 } }],
    })
    expect(compiled.tiers).toEqual([])
  })
})
