import { describe, test, expect } from "bun:test"
import {
  buildFuzzyPricingFallbackMap,
  buildPersonalFallbackMap,
  buildPricingFallbackMap,
  compareByCheapness,
  mergePricingFallbacks,
  sortByCheapness,
  type CheapnessModel,
} from "./model-cost"
import { normalizeModelName, similarity } from "./string-similarity"

const published = (input = 1) => ({ input, output: input * 2, cache: { read: input / 10, write: 0 } })
const unpriced = () => ({ input: 0, output: 0, cache: { read: 0, write: 0 } })

function bruteFuzzy(models: CheapnessModel[], threshold = 0.75) {
  const paid = models.filter((model) => model.cost.input > 0 || model.cost.output > 0)
  const free = models.filter((model) => !(model.cost.input > 0 || model.cost.output > 0))
  const donorByKey = new Map<string, CheapnessModel>()
  for (const model of paid) {
    const key = normalizeModelName(model.name || model.id)
    if (!key) continue
    const existing = donorByKey.get(key)
    if (!existing || (existing.provider.id === "openrouter" && model.provider.id !== "openrouter")) donorByKey.set(key, model)
  }
  const donors = [...donorByKey].map(([key, model]) => ({ key, model }))
  const groups = new Map<string, CheapnessModel[]>()
  for (const model of free) {
    const key = normalizeModelName(model.name || model.id)
    if (!key) continue
    const group = groups.get(key)
    if (group) group.push(model)
    else groups.set(key, [model])
  }
  const out = new Map<string, { cost: CheapnessModel["cost"]; score: number; donorId: string }>()
  for (const [query, group] of groups) {
    let best: { model: CheapnessModel; score: number } | undefined
    for (const donor of donors) {
      const score = similarity(query, donor.key)
      if (score < threshold) continue
      if (
        !best ||
        score > best.score ||
        (score === best.score && best.model.provider.id === "openrouter" && donor.model.provider.id !== "openrouter")
      ) {
        best = { model: donor.model, score }
      }
    }
    if (!best) continue
    for (const model of group) {
      if (!out.has(model.id)) out.set(model.id, { cost: best.model.cost, score: best.score, donorId: best.model.id })
    }
  }
  return out
}

describe("model-cost fallback", () => {
  test("pricing fallback prefers non-openrouter and shares across providers", () => {
    const models = [
      { id: "claude-sonnet", name: "Claude Sonnet", provider: { id: "anthropic" }, cost: { input: 3, output: 15, cache: { read: 0.3, write: 0 } } },
      { id: "claude-sonnet", name: "Claude Sonnet", provider: { id: "openrouter" }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
      { id: "gpt-4o", name: "GPT-4o", provider: { id: "openai" }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
    ] as never
    const map = buildPricingFallbackMap(models)
    expect(map.get("claude-sonnet")?.input).toBe(3)
    expect(map.has("gpt-4o")).toBe(false)
    // Unpriced claude-sonnet on openrouter should sort as if priced via fallback, not last
    const a = { id: "claude-sonnet", name: "Claude Sonnet", provider: { id: "openrouter" }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }
    const b = { id: "expensive", name: "Expensive", provider: { id: "anthropic" }, cost: { input: 100, output: 100, cache: { read: 10, write: 0 } } }
    // Without fallback, a is unpriced and sorts last
    expect(compareByCheapness(a as never, b as never)).toBeGreaterThan(0)
    // With fallback, a should be considered priced and outrank expensive
    expect(compareByCheapness(a as never, b as never, undefined, undefined, undefined, map as never)).toBeLessThan(0)
  })

  test("personal fallback shares usage across providers for same model", () => {
    const personal = new Map<string, { cost: number; count: number }>([
      ["anthropic:claude-sonnet", { cost: 0.001, count: 20 }],
    ])
    const personalFallback = buildPersonalFallbackMap(personal)
    expect(personalFallback.get("claude-sonnet")?.cost).toBeCloseTo(0.001)
    const a = { id: "claude-sonnet", name: "Claude Sonnet", provider: { id: "openrouter" }, cost: { input: 3, output: 15, cache: { read: 0.3, write: 0 } } }
    const b = { id: "claude-sonnet", name: "Claude Sonnet", provider: { id: "anthropic" }, cost: { input: 3, output: 15, cache: { read: 0.3, write: 0 } } }
    // Direct personal for openrouter missing, but fallback should make it comparable
    // Create a cheap vs expensive scenario where personal makes a cheaper than b's corpus
    const cheap = { id: "cheap-model", name: "Cheap", provider: { id: "openrouter" }, cost: { input: 10, output: 10, cache: { read: 1, write: 0 } } }
    const expensiveCorpusButCheapPersonal = { id: "claude-sonnet", name: "Claude Sonnet", provider: { id: "openrouter" }, cost: { input: 10, output: 10, cache: { read: 1, write: 0 } } }
    // Without fallback, cheap-model would be similar, but with personal fallback, claude-sonnet should be cheaper due to personal cheap cost
    const resultWithoutFallback = compareByCheapness(expensiveCorpusButCheapPersonal as never, cheap as never, undefined, undefined, personal as never)
    // Both have same corpus cost (10/10/1), so without fallback they'd tie and then sort by name
    // With fallback, expensiveCorpusButCheapPersonal has personal fallback (0.001) which is cheap, so it should outrank
    const withFallback = compareByCheapness(expensiveCorpusButCheapPersonal as never, cheap as never, undefined, undefined, personal as never, undefined, personalFallback as never)
    expect(withFallback).toBeLessThan(0)
  })

  test("a free-tier model with fuzzy-inferred pricing ranks by that value within its tier, not just alphabetically", () => {
    // Regression for: classifyMonetaryClass runs on the model's own $0 cost
    // BEFORE any pricing-fallback lookup, so a model that tier-classifies as
    // free (openrouter ":free" suffix here) used to short-circuit straight to
    // `a.name.localeCompare(b.name)` and never consult the fallback map at
    // all — meaning fuzzy/exact-inferred pricing was computed but silently
    // never used for ranking any free-tier model.
    const hy3Paid: CheapnessModel = { id: "hy3", name: "Hy3", provider: { id: "vendor-x" }, cost: { input: 3, output: 15, cache: { read: 0.3, write: 0 } } }
    const hy3Free: CheapnessModel = {
      id: "openrouter/hy3:free",
      name: "Hy3 (Free)",
      provider: { id: "openrouter" },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    }
    // Alphabetically first ("Aaa" < "Hy3") but has no paid sibling to infer from.
    const otherFree: CheapnessModel = {
      id: "openrouter/aaa:free",
      name: "Aaa (Free)",
      provider: { id: "openrouter" },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    }
    const paidModel: CheapnessModel = { id: "mid", name: "Mid", provider: { id: "vendor-y" }, cost: { input: 1, output: 1, cache: { read: 0, write: 0 } } }

    const fuzzy = buildFuzzyPricingFallbackMap([hy3Paid, hy3Free, otherFree, paidModel])
    const merged = mergePricingFallbacks(undefined, fuzzy)
    expect(merged?.get("openrouter/hy3:free")?.input).toBe(3)
    expect(merged?.has("openrouter/aaa:free")).toBe(false)

    const sorted = sortByCheapness([otherFree, hy3Free, paidModel], undefined, undefined, undefined, merged)
    expect(sorted.map((m) => m.id)).toEqual(["openrouter/hy3:free", "openrouter/aaa:free", "mid"])

    // compareByCheapness (the O(n log n) comparator path) must agree.
    expect(compareByCheapness(hy3Free as never, otherFree as never, undefined, undefined, undefined, merged as never)).toBeLessThan(0)
    // Free tier still always outranks paid regardless of inferred value (§19 intact).
    expect(compareByCheapness(otherFree as never, paidModel as never, undefined, undefined, undefined, merged as never)).toBeLessThan(0)
  })

  test("indexed fuzzy pricing is exactly equivalent to the exhaustive donor scan", () => {
    const models: CheapnessModel[] = []
    for (let i = 0; i < 80; i++) {
      const suffix = i.toString().padStart(2, "0")
      models.push({
        id: `atlas-${suffix}`,
        name: `Atlas ${suffix} Standard`,
        provider: { id: i % 7 === 0 ? "openrouter" : "vendor" },
        cost: published(1 + i / 10),
      })
      models.push({
        id: `atlas-${suffix}-community`,
        name: `Atlas ${suffix} Standrd Community`,
        provider: { id: "community" },
        cost: unpriced(),
      })
      if (i % 5 === 0) {
        models.push({
          id: `atlas-${suffix}-replica`,
          name: `Atlas ${suffix} Standard`,
          provider: { id: "vendor-replica" },
          cost: published(2 + i / 10),
        })
      }
    }
    models.push({ id: "single-a", name: "A", provider: { id: "community" }, cost: unpriced() })
    models.push({ id: "single-b", name: "B", provider: { id: "vendor" }, cost: published() })
    models.push({ id: "unrelated", name: "Quantum Zebra", provider: { id: "community" }, cost: unpriced() })

    const expected = bruteFuzzy(models)
    const actual = buildFuzzyPricingFallbackMap(models)
    expect([...actual.entries()]).toEqual([...expected.entries()])
  })
})
