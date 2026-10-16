import { describe, test, expect } from "bun:test"
import {
  blendedCost,
  buildStandardWorkloadCorpus,
  evaluateModelUsageYield,
  rankPaidUsageYield,
  compareModelsByUsageYield,
  FALLBACK_WORKLOAD_CORPUS,
  compilePricingRegimes,
  priceWorkload,
  priceWorkloadExpected,
} from "./model-usage-yield"
import type { UsageProfile } from "./model-usage-profile"

describe("model-usage-yield", () => {
  test("flat regime compilation skips native tier construction without bypassing explicit thresholds", () => {
    const model = { id: "vendor/model", provider: { id: "vendor" } }
    const base = { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }
    expect(compilePricingRegimes(model, base)).toEqual([{ kind: "flat", prices: base }])
    expect(compilePricingRegimes(model, { ...base, tiers: [] })).toEqual([{ kind: "flat", prices: { ...base, tiers: [] } }])
    const dual = [
      { thresholdTokens: 128_000, operator: "<=" as const, cost: base },
      { thresholdTokens: 128_000, operator: ">" as const, cost: { ...base, input: 5 } },
    ]
    expect(compilePricingRegimes(model, base, dual).map((r) => r.kind)).toEqual([
      "context-threshold",
      "context-threshold",
    ])
    expect(compilePricingRegimes(model, { ...base, experimentalOver200K: { ...base, input: 7 } })[0]?.kind).toBe("native-context")
    expect(compilePricingRegimes(model, {
      ...base,
      tiers: [{ tier: { type: "context" as const, size: 128_000 }, ...base }],
    })[0]?.kind).toBe("native-context")
  })

  test("expected-only ranking pricer exactly matches canonical pricing across flat and complex regimes", () => {
    const flatModel = { id: "vendor/model", provider: { id: "vendor" } }
    const flat = compilePricingRegimes(flatModel, { input: 2.21, output: 9.7, cache: { read: 0.13, write: 2.9 } })
    const legacy = compilePricingRegimes(flatModel, { input: 2.21, output: 9.7 } as never)
    const tiered = compilePricingRegimes(flatModel, {
      input: 2.21,
      output: 9.7,
      cache: { read: 0.13, write: 2.9 },
      tiers: [{ tier: { type: "context", size: 20_000 }, input: 5, output: 14, cache: { read: 0.5, write: 6 } }],
    })
    const deepSeek = compilePricingRegimes(
      { id: "deepseek-v4-flash", provider: { id: "opencode" } },
      { input: 2, output: 5, cache: { read: 0.12, write: 0 } },
    )
    const rates = [undefined, 0, 0.1, 0.75, 1, 1.5, 24, 100, 120, Number.NaN, Number.POSITIVE_INFINITY]
    let seed = 0xf0edbabe
    const next = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return seed >>> 0
    }
    for (let i = 0; i < 500; i++) {
      const freshInputTokens = next() % 150_000
      const cachedReadTokens = next() % 150_000
      const cacheWriteTokens = next() % 10_000
      const workload = {
        freshInputTokens,
        cachedReadTokens,
        cacheWriteTokens,
        outputTokens: next() % 15_000,
        contextTokens: freshInputTokens + cachedReadTokens + cacheWriteTokens,
      }
      for (const regimes of [flat, legacy, tiered, deepSeek]) {
        for (const rate of rates) {
          expect(priceWorkloadExpected(workload, regimes, rate)).toBe(priceWorkload(workload, regimes, rate).expected)
        }
      }
    }
  })

  test("bulk selector's single-regime pricing fast path preserves flat and native context semantics", () => {
    const workload = {
      freshInputTokens: 1_000,
      cachedReadTokens: 10_000,
      outputTokens: 100,
      contextTokens: 11_000,
    }
    const model = { id: "vendor/model", provider: { id: "vendor" } }
    const flat = { input: 2, output: 4, cache: { read: 1, write: 0 } }
    const flatPrice = priceWorkload(workload, compilePricingRegimes(model, flat))
    expect(flatPrice.expected).toBeCloseTo((1_000 * 2 + 10_000 * 1 + 100 * 4) / 1_000_000)
    expect(flatPrice.regimeLabel).toBeUndefined()

    const tiered = {
      ...flat,
      tiers: [{ tier: { type: "context" as const, size: 5_000 }, input: 4, output: 8, cache: { read: 2, write: 0 } }],
    }
    const nativePrice = priceWorkload(workload, compilePricingRegimes(model, tiered))
    expect(nativePrice.expected).toBeCloseTo((1_000 * 4 + 10_000 * 2 + 100 * 8) / 1_000_000)
    expect(nativePrice.regimeLabel).toBe("> 5,000")

    const legacy = { input: 2, output: 4, tiers: [{ tier: { type: "context" as const, size: 5_000 }, input: 4, output: 8 }] }
    const conservativePrice = priceWorkload(workload, compilePricingRegimes(model, legacy as never))
    expect(conservativePrice.expected).toBeCloseTo((1_000 * 4 + 10_000 * 4 + 100 * 8) / 1_000_000)
  })

  test("buildStandardWorkloadCorpus deduplicates", () => {
    const profiles: UsageProfile[] = [
      { input: 390, cached: 32_500, output: 120 },
      { input: 390, cached: 32_500, output: 120 }, // duplicate
      { input: 1000, cached: 55_000, output: 200 },
    ]
    const bands = buildStandardWorkloadCorpus(profiles)
    expect(bands.corpus.length).toBe(2)
    // sorted by context
    expect(bands.corpus[0].contextTokens).toBe(32_890)
  })

  test("fallback corpus has 16 tuples", () => {
    expect(FALLBACK_WORKLOAD_CORPUS.length).toBe(16)
  })

  test("ranks cheapest yield correctly (cache-heavy workload)", () => {
    const corpus = buildStandardWorkloadCorpus([
      { input: 800, cached: 65_000, output: 220 },
      { input: 800, cached: 65_000, output: 220 },
    ])
    // Two models with same input/output but different cache rates
    const cheapCache = evaluateModelUsageYield(
      { id: "cheap", name: "cheap", provider: { id: "openai" }, cost: { input: 3, output: 15, cache: { read: 0.03, write: 0 } } },
      corpus,
    )
    const expensiveCache = evaluateModelUsageYield(
      { id: "expensive", name: "expensive", provider: { id: "openai" }, cost: { input: 3, output: 15, cache: { read: 0.5, write: 0 } } },
      corpus,
    )
    expect(cheapCache.primary.equivalentRequestsPerDollar! > expensiveCache.primary.equivalentRequestsPerDollar!).toBe(true)
  })

  test("DeepSeek peak blending is between off-peak and peak", () => {
    const bands = buildStandardWorkloadCorpus([{ input: 800, cached: 65_000, output: 220 }])
    const deepFlash = evaluateModelUsageYield(
      { id: "deepseek-v4-flash", name: "DeepSeek Flash", provider: { id: "opencode" }, cost: { input: 0.22, output: 0.66, cache: { read: 0.007, write: 0 } } },
      bands,
    )
    const best = deepFlash.regimes.find((r) => r.label === "off-peak")!
    const worst = deepFlash.regimes.find((r) => r.label === "peak")!
    expect(best.requestsPerDollar! > worst.requestsPerDollar!).toBe(true)
    expect(deepFlash.primary.equivalentRequestsPerDollar! > worst.requestsPerDollar!).toBe(true)
    expect(deepFlash.primary.equivalentRequestsPerDollar! < best.requestsPerDollar!).toBe(true)
  })

  test("free taxonomy: quota-exempt sorts before paid", () => {
    const a = { id: "model-unlimited", name: "Model (Unlimited)", provider: { id: "opencode" }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }
    const b = { id: "cheap", name: "cheap", provider: { id: "openai" }, cost: { input: 0.1, output: 0.2, cache: { read: 0.01, write: 0 } } }
    expect(compareModelsByUsageYield(a as never, b as never) < 0).toBe(true)
  })

  test("unpriced sorts last", () => {
    const priced = { id: "priced", name: "priced", provider: { id: "openai" }, cost: { input: 1, output: 2, cache: { read: 0.1, write: 0 } } }
    const unpriced = { id: "unpriced-image", name: "unpriced", provider: { id: "openai" }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }
    expect(compareModelsByUsageYield(priced as never, unpriced as never) < 0).toBe(true)
  })

  test("rankPaidUsageYield competition ranking and fractionOfBest", () => {
    const bands = buildStandardWorkloadCorpus([{ input: 800, cached: 65_000, output: 220 }])
    const models = [
      { id: "a", name: "a", provider: { id: "openai" }, cost: { input: 0.1, output: 0.2, cache: { read: 0.01, write: 0 } } },
      { id: "b", name: "b", provider: { id: "openai" }, cost: { input: 1, output: 2, cache: { read: 0.1, write: 0 } } },
      { id: "c", name: "c", provider: { id: "openai" }, cost: { input: 1, output: 2, cache: { read: 0.1, write: 0 } } }, // tie with b
    ]
    const yields = models.map((m) => evaluateModelUsageYield(m as never, bands))
    const ranked = rankPaidUsageYield(yields)
    const ra = ranked.get("openai:a")!
    const rb = ranked.get("openai:b")!
    const rc = ranked.get("openai:c")!
    expect(ra.rank).toBe(1)
    // b and c tie
    expect(rb.rank).toBe(2)
    expect(rc.rank).toBe(2)
    expect(rb.primary.fractionOfBestPaid! < 1).toBe(true)
    expect(ra.primary.percentile).toBe(100)
  })

  test("blendedCost heavily weights personal over corpus", () => {
    const corpusCost = 0.01 // $0.01 per request
    const personalCost = 0.002 // user measures this model as 5x cheaper for their workload
    // No personal -> corpus
    expect(blendedCost(corpusCost, undefined, 0)).toBe(corpusCost)
    // Below threshold (<3) -> still corpus
    expect(blendedCost(corpusCost, personalCost, 2)).toBe(corpusCost)
    // With personal, blended should be much closer to personal than corpus
    const blended = blendedCost(corpusCost, personalCost, 10)
    // personal 70% weight => blended ≈ 0.7*0.002 + 0.3*0.01 = 0.0044, which is < 0.006 (midpoint)
    expect(blended).toBeLessThan(0.005)
    expect(blended).toBeGreaterThan(personalCost)
  })

  test("compareModelsByUsageYield respects personal measured yield", () => {
    const bands = buildStandardWorkloadCorpus([{ input: 800, cached: 65_000, output: 220 }])
    const a = { id: "a", name: "a", provider: { id: "openai" }, cost: { input: 1, output: 2, cache: { read: 0.1, write: 0 } } }
    const b = { id: "b", name: "b", provider: { id: "openai" }, cost: { input: 0.5, output: 1, cache: { read: 0.05, write: 0 } } }
    // Without personal, b is cheaper than a (corpus)
    expect(compareModelsByUsageYield(a as never, b as never, bands)).toBeGreaterThan(0)
    // With personal: a is measured as very cheap for this user (even though its published rates are higher)
    const personal = new Map<string, { cost: number; count: number }>([
      ["openai:a", { cost: 0.001, count: 20 }],
      ["openai:b", { cost: 0.02, count: 20 }],
    ])
    // Now a should outrank b because personal heavily weighted
    expect(compareModelsByUsageYield(a as never, b as never, bands, personal)).toBeLessThan(0)
  })
})
