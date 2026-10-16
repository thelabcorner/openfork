import { describe, test, expect } from "bun:test"
import {
  buildFuzzyPricingFallbackMap,
  buildPersonalFallbackMap,
  buildPricingFallbackMap,
  compareByCheapness,
  mergePricingFallbacks,
  medianCost,
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
  test("median selection agrees with full numeric sort for odd/even, duplicate and extreme corpora", () => {
    const reference = (values: number[]) => {
      if (values.length === 0) return 0
      const sorted = [...values].sort((a, b) => a - b)
      const m = sorted.length >> 1
      return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2
    }
    let state = 0x71e7c0de
    const next = () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return state >>> 0
    }
    for (const count of [0, 1, 2, 3, 4, 15, 16, 17, 63, 64, 65, 100]) {
      for (let iteration = 0; iteration < 150; iteration++) {
        const input = Array.from({ length: count }, () => {
          const bits = next()
          return bits % 43 === 0 ? Number.POSITIVE_INFINITY : bits % 23 === 0 ? 0 : (bits % 101) / 17
        })
        expect(medianCost(input.slice())).toBe(reference(input))
      }
    }
    expect(medianCost([Number.NaN, 2, 10])).toBe(reference([Number.NaN, 2, 10]))
    expect(medianCost([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY])).toBe(Number.POSITIVE_INFINITY)
  })

  test("legacy pricing without a cache object stays rankable", () => {
    const legacy = {
      id: "legacy",
      name: "Legacy",
      provider: { id: "legacy-provider" },
      cost: { input: 1, output: 2 },
    }
    const expensive = {
      id: "expensive",
      name: "Expensive",
      provider: { id: "legacy-provider" },
      cost: { input: 10, output: 20 },
    }

    expect(() => compareByCheapness(legacy as never, expensive as never)).not.toThrow()
    expect(compareByCheapness(legacy as never, expensive as never)).toBeLessThan(0)
  })

  test("legacy native context tiers use input prices when a cache discount is missing", () => {
    const legacy = {
      id: "legacy-tier",
      name: "Legacy Tier",
      provider: { id: "vendor" },
      cost: {
        input: 2,
        output: 4,
        tiers: [{ tier: { type: "context" as const, size: 32_000 }, input: 3, output: 6 }],
        experimentalOver200K: { input: 5, output: 10 },
      },
    }
    const baseline = {
      id: "expensive",
      name: "Expensive",
      provider: { id: "vendor" },
      cost: { input: 100, output: 200 },
    }
    expect(() => sortByCheapness([legacy, baseline] as never)).not.toThrow()
    expect(sortByCheapness([legacy, baseline] as never)[0]?.id).toBe("legacy-tier")
  })

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

  test("merged fuzzy preparation skips exact-covered IDs without losing any inferred price", () => {
    const models: CheapnessModel[] = [
      { id: "same-id", name: "Orion", provider: { id: "vendor" }, cost: published(3) },
      { id: "same-id", name: "Orion (Free)", provider: { id: "openrouter" }, cost: unpriced() },
      { id: "fuzzy-donor", name: "Atlas", provider: { id: "vendor" }, cost: published(5) },
      { id: "atlas:free", name: "Atlas (Free)", provider: { id: "openrouter" }, cost: unpriced() },
    ]
    const exact = buildPricingFallbackMap(models)
    const complete = mergePricingFallbacks(exact, buildFuzzyPricingFallbackMap(models))
    const selective = mergePricingFallbacks(exact, buildFuzzyPricingFallbackMap(models, 0.75, exact))
    expect([...selective!.entries()]).toEqual([...complete!.entries()])
    expect(selective?.get("same-id")?.input).toBe(3)
    expect(selective?.get("atlas:free")?.input).toBe(5)
    expect(buildFuzzyPricingFallbackMap(models).has("same-id")).toBe(true)
    expect(buildFuzzyPricingFallbackMap(models, 0.75, exact).has("same-id")).toBe(false)
  })

  test("exact-covered pruning preserves the full merged result on randomized provider replicas", () => {
    let seed = 0xabcdef01
    const random = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return seed >>> 0
    }
    for (let trial = 0; trial < 48; trial++) {
      const entries: CheapnessModel[] = []
      for (let i = 0; i < 140; i++) {
        const group = random() % 45
        const suffix = random() % 4
        entries.push({
          id: `candidate-${group}`,
          name: `Catalog ${group} ${suffix === 0 ? "Pro" : suffix === 1 ? "Preview" : "Free"}`,
          provider: { id: random() % 3 === 0 ? "openrouter" : "vendor" },
          cost: random() % 3 === 0 ? published(1 + (random() % 7)) : unpriced(),
        })
      }
      const exact = buildPricingFallbackMap(entries)
      const all = mergePricingFallbacks(exact, buildFuzzyPricingFallbackMap(entries))
      const pruned = mergePricingFallbacks(exact, buildFuzzyPricingFallbackMap(entries, 0.75, exact))
      expect([...pruned?.entries() ?? []]).toEqual([...all?.entries() ?? []])
    }
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

  test("inverted-overlap fuzzy matching preserves exhaustive scores and donor ties across thresholds", () => {
    let seed = 0x31415926
    const random = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return seed >>> 0
    }
    const alphabet = ["Alpha", "Alph", "Alpha-", "Atlas", "Atlass", "Beta", "Bett", "Gamma", "Gama", "X", "Y"]
    for (let attempt = 0; attempt < 12; attempt++) {
      const models: CheapnessModel[] = []
      for (let i = 0; i < 110; i++) {
        const marker = random() % 14
        const prefix = alphabet[random() % alphabet.length]!
        const name = `${prefix}${marker}${random() % 4 ? " Pro" : " Preview"}`
        const isPaid = random() % 3 === 0
        models.push({
          id: `sample-${attempt}-${i}`,
          name,
          provider: { id: random() % 3 === 0 ? "openrouter" : "vendor" },
          cost: isPaid ? published(1 + (random() % 8)) : unpriced(),
        })
      }
      for (const threshold of [0, 0.25, 0.5, 0.75, 0.9, 1, 1.25]) {
        const actual = buildFuzzyPricingFallbackMap(models, threshold)
        const expected = bruteFuzzy(models, threshold)
        expect([...actual.entries()]).toEqual([...expected.entries()])
      }
    }
  })

  test("perfect-name fast path preserves Dice-anagram and provider-preference tie breaking", () => {
    const openingDonor: CheapnessModel = {
      id: "first-anagram",
      name: "Babab",
      provider: { id: "openrouter" },
      cost: published(3),
    }
    const exactDonor: CheapnessModel = {
      id: "exact",
      name: "Ababa",
      provider: { id: "vendor" },
      cost: published(5),
    }
    const free: CheapnessModel = {
      id: "free-variant",
      name: "Ababa (Free)",
      provider: { id: "openrouter" },
      cost: unpriced(),
    }
    expect(buildFuzzyPricingFallbackMap([openingDonor, exactDonor, free]).get(free.id)?.donorId).toBe("exact")
    const sameProvider = { ...openingDonor, provider: { id: "vendor" } }
    expect(buildFuzzyPricingFallbackMap([sameProvider, exactDonor, free]).get(free.id)?.donorId).toBe(
      "first-anagram",
    )
    expect(buildFuzzyPricingFallbackMap([openingDonor, free]).get(free.id)?.donorId).toBe("first-anagram")
  })
})
