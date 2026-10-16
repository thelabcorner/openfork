import { expect, test } from "bun:test"
import { compilePricingRegimes, FALLBACK_WORKLOAD_CORPUS, priceWorkload, priceWorkloadExpected } from "../../../src/utils/model-usage-yield"
import { buildFuzzyPricingFallbackMap, buildPricingFallbackMap, mergePricingFallbacks } from "../../../src/utils/model-cost"
import { pricingFallbackForCatalog } from "../../../src/components/dialog-select-model-sorting"

/**
 * Repeatable, synthetic in-process selector pricing benchmark. Run directly:
 * bun test e2e/performance/unit/model-selector-pricing-benchmark.test.ts
 *
 * These are scalar calculation timings, NOT dialog-open/Chromium frame timings.
 * The canonical diagnostic price path is the reference implementation.
 * Neither speedup nor an absolute millisecond target is a CI assertion.
 */
test("selector pricing projection preserves reference semantics with measurable timings", () => {
  const corpus = FALLBACK_WORKLOAD_CORPUS
  const benchmark = (fn: () => number) => {
    for (let i = 0; i < 3; i++) fn()
    const samples: number[] = []
    let checksum = 0
    for (let sample = 0; sample < 9; sample++) {
      const start = performance.now()
      checksum = fn()
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    return { ms: samples[4]!, checksum }
  }
  for (const count of [644, 2_000]) {
    for (const pricing of ["flat", "native-context"] as const) {
      const models = Array.from({ length: count }, (_, i) => {
        const base = { input: 0.5 + (i % 30) / 10, output: 2 + (i % 11) / 2, cache: { read: 0.05, write: 0.2 } }
        const cost = pricing === "flat"
          ? base
          : {
              ...base,
              tiers: [{
                tier: { type: "context" as const, size: 65_000 },
                input: base.input * 1.5,
                output: base.output * 1.5,
                cache: { read: 0.08, write: 0.4 },
              }],
            }
        return compilePricingRegimes({ id: `benchmark-model-${i}`, provider: { id: "benchmark" } }, cost)
      })
      const original = () => {
        let sum = 0
        for (let i = 0; i < models.length; i++) {
          const regimes = models[i]!
          const hit = i % 3 === 0 ? 0.68 : undefined
          for (const workload of corpus) sum += priceWorkload(workload, regimes, hit).expected
        }
        return sum
      }
      const optimized = () => {
        let sum = 0
        for (let i = 0; i < models.length; i++) {
          const regimes = models[i]!
          const hit = i % 3 === 0 ? 0.68 : undefined
          for (const workload of corpus) sum += priceWorkloadExpected(workload, regimes, hit)
        }
        return sum
      }
      const reference = benchmark(original)
      const measured = benchmark(optimized)
      expect(measured.checksum).toBe(reference.checksum)
      console.log("SELECTOR_PRICING_BENCHMARK", JSON.stringify({
        models: count,
        workloadCount: corpus.length,
        pricing,
        diagnosticMs: Number(reference.ms.toFixed(3)),
        expectedOnlyMs: Number(measured.ms.toFixed(3)),
        ratio: Number((reference.ms / Math.max(measured.ms, 1e-6)).toFixed(2)),
      }))
    }
  }
})

test("exact-ID coverage avoids redundant fuzzy preparation without changing merged prices", () => {
  for (const size of [1_000, 3_000]) {
    const models = Array.from({ length: size }, (_, index) => {
      const paid = index % 3 === 0
      return {
        id: `shared-model-${Math.floor(index / 3)}`,
        name: `Vendor Model ${Math.floor(index / 3)}${paid ? "" : " Free"}`,
        provider: { id: paid ? "vendor" : "openrouter" },
        cost: paid
          ? { input: 1, output: 3, cache: { read: 0.1, write: 0.2 } }
          : { input: 0, output: 0, cache: { read: 0, write: 0 } },
      }
    })
    const legacy = () => {
      const exact = buildPricingFallbackMap(models)
      return mergePricingFallbacks(exact, buildFuzzyPricingFallbackMap(models))
    }
    const optimized = () => pricingFallbackForCatalog(models)
    const reference = legacy()
    expect([...optimized()!.entries()]).toEqual([...reference!.entries()])
    const measure = (fn: () => unknown) => {
      fn()
      const samples: number[] = []
      for (let repeat = 0; repeat < 9; repeat++) {
        const start = performance.now()
        fn()
        samples.push(performance.now() - start)
      }
      samples.sort((a, b) => a - b)
      return samples[4]!
    }
    const before = measure(legacy)
    const after = measure(optimized)
    console.log("SELECTOR_FUZZY_COVERAGE_BENCHMARK", JSON.stringify({
      models: size,
      baselineMs: Number(before.toFixed(3)),
      optimizedMs: Number(after.toFixed(3)),
      ratio: Number((before / Math.max(after, 1e-6)).toFixed(2)),
    }))
  }
})