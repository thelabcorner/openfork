import { describe, test, expect } from "bun:test"
import { buildFuzzyPricingFallbackMap, buildPricingFallbackMap, type CheapnessModel } from "./model-cost"
import { computeSubsidy, priceTokens, subsidyRatePerMillion, subsidyShare, type SubsidyUsageRow } from "./usage-subsidy"

const tokens = (over: Partial<SubsidyUsageRow["tokens"]> = {}) => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  ...over,
})

const row = (over: Partial<SubsidyUsageRow>): SubsidyUsageRow => ({
  providerID: "workbuddy",
  modelID: "hy4-preview",
  variant: null,
  messages: 10,
  cost: 0,
  estimatedCost: 0,
  unpricedRecords: 10,
  tokens: tokens({ input: 1_000_000, output: 100_000 }),
  ...over,
})

describe("priceTokens", () => {
  test("bills reasoning at the output rate and falls back to input for unpublished cache rates", () => {
    const cost = { input: 3, output: 15, cache: { read: 0, write: 0 } }
    // 1M input @3 + 1M cacheRead @3 (falls back to input) + 1M cacheWrite @3
    // + (1M output + 1M reasoning) @15 = 9 + 30 = 39
    const value = priceTokens(
      tokens({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000, reasoning: 1_000_000 }),
      cost,
    )
    expect(value).toBeCloseTo(39, 6)
  })

  test("uses a published cache read rate when there is one", () => {
    const cost = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }
    expect(priceTokens(tokens({ cacheRead: 1_000_000 }), cost)).toBeCloseTo(0.3, 6)
    expect(priceTokens(tokens({ cacheWrite: 1_000_000 }), cost)).toBeCloseTo(3.75, 6)
  })
})

describe("computeSubsidy", () => {
  // The motivating case: a free variant served by one provider whose paid
  // sibling only matches by NAME (different id), so only the fuzzy fallback
  // can price it.
  const paidSibling: CheapnessModel = {
    id: "openai/hy4-preview",
    name: "Hy4 Preview",
    provider: { id: "openrouter" },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  }
  const freeVariant: CheapnessModel = {
    id: "hy4-preview",
    name: "Hy4 Preview (Free)",
    provider: { id: "workbuddy" },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  }
  const catalog = [paidSibling, freeVariant]
  const catalogByKey = new Map(catalog.map((m) => [`${m.provider.id}:${m.id}`, m]))
  const exact = buildPricingFallbackMap(catalog)
  const fuzzy = buildFuzzyPricingFallbackMap(catalog)

  test("values $0 usage at a fuzzy-inferred sibling rate", () => {
    const report = computeSubsidy({
      rows: [row({ tokens: tokens({ input: 1_000_000, output: 100_000 }) })],
      catalogByKey,
      exactFallback: exact,
      fuzzyFallback: fuzzy,
    })
    expect(report.rows).toHaveLength(1)
    // 1M input @$3 + 100k output @$15 = 3 + 1.5
    expect(report.total).toBeCloseTo(4.5, 6)
    expect(report.rows[0].source).toBe("inferred")
    expect(report.rows[0].confidence).toBeGreaterThanOrEqual(0.75)
    expect(report.rows[0].approximate).toBe(false)
    expect(report.unvalued.models).toBe(0)
    // 1.1M free tokens worth $4.50 => ~$4.09/M blended
    expect(subsidyRatePerMillion(report)).toBeCloseTo(4.5 / 1.1, 4)
  })

  test("counts unpriceable free usage separately instead of reporting it as $0 of value", () => {
    const report = computeSubsidy({
      rows: [row({ providerID: "mystery", modelID: "unknown-model", tokens: tokens({ input: 500_000 }) })],
      catalogByKey,
      exactFallback: exact,
      fuzzyFallback: fuzzy,
    })
    expect(report.rows).toHaveLength(0)
    expect(report.total).toBe(0)
    expect(report.unvalued).toEqual({ models: 1, messages: 10, tokens: 500_000 })
  })

  test("pro-rates a partially-priced row by its unpriced message share and flags it approximate", () => {
    const report = computeSubsidy({
      // Half the messages recorded no price; tokens are only aggregated for
      // the row as a whole, so the free half is estimated by message share.
      rows: [row({ messages: 10, unpricedRecords: 5, cost: 2, tokens: tokens({ input: 2_000_000 }) })],
      catalogByKey,
      exactFallback: exact,
      fuzzyFallback: fuzzy,
    })
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].approximate).toBe(true)
    expect(report.rows[0].freeMessages).toBe(5)
    // half of 2M input @$3 = $3
    expect(report.total).toBeCloseTo(3, 6)
    expect(report.spend).toBeCloseTo(2, 6)
    expect(subsidyShare(report)).toBeCloseTo(3 / 5, 6)
  })

  test("ignores rows that were actually billed in full", () => {
    const report = computeSubsidy({
      rows: [row({ providerID: "openrouter", modelID: "openai/hy4-preview", cost: 12, unpricedRecords: 0 })],
      catalogByKey,
      exactFallback: exact,
      fuzzyFallback: fuzzy,
    })
    expect(report.rows).toHaveLength(0)
    expect(report.spend).toBeCloseTo(12, 6)
    expect(subsidyShare(report)).toBe(0)
  })

  test("values a $0 row whose model publishes its own pricing without marking it inferred", () => {
    const report = computeSubsidy({
      rows: [
        row({
          providerID: "openrouter",
          modelID: "openai/hy4-preview",
          tokens: tokens({ output: 1_000_000 }),
        }),
      ],
      catalogByKey,
      exactFallback: exact,
      fuzzyFallback: fuzzy,
    })
    expect(report.rows[0].source).toBe("self")
    expect(report.total).toBeCloseTo(15, 6)
  })
})
