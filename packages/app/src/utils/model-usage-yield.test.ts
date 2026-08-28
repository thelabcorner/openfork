import { describe, test, expect } from "bun:test"
import {
  blendedCost,
  buildStandardWorkloadCorpus,
  evaluateModelUsageYield,
  rankPaidUsageYield,
  compareModelsByUsageYield,
  FALLBACK_WORKLOAD_CORPUS,
} from "./model-usage-yield"
import type { UsageProfile } from "./model-usage-profile"

describe("model-usage-yield", () => {
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
