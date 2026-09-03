import { describe, expect, test } from "bun:test"
import { createCatalogIdentify, type CatalogModel } from "./usage-model-identity"
import { groupModelsByName, type UsageModelRow } from "./usage-model-groups"

const row = (args: Partial<UsageModelRow> & { providerID: string; modelID: string }): UsageModelRow => ({
  providerID: args.providerID,
  modelID: args.modelID,
  variant: args.variant ?? "",
  messages: args.messages ?? 0,
  cost: args.cost ?? 0,
  estimatedCost: args.estimatedCost ?? 0,
  unpricedRecords: args.unpricedRecords ?? 0,
  tokens: args.tokens ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
  share: args.share ?? 0,
  cacheSavings: args.cacheSavings ?? 0,
  durationMs: args.durationMs ?? 0,
  durationRecords: args.durationRecords ?? 0,
})

describe("createCatalogIdentify", () => {
  test("merges two providers serving the same model under different id strings, via the catalog's shared name", () => {
    const catalog: CatalogModel[] = [
      { providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { providerID: "openrouter", modelID: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ]
    const identify = createCatalogIdentify(catalog)
    const models = [
      row({ providerID: "openai", modelID: "gpt-5.6-sol", cost: 3 }),
      row({ providerID: "openrouter", modelID: "openai/gpt-5.6-sol", cost: 7 }),
    ]
    const groups = groupModelsByName(models, identify)
    expect(groups).toHaveLength(1)
    expect(groups[0].modelID).toBe("GPT-5.6 Sol")
    expect(groups[0].cost).toBeCloseTo(10)
    expect(groups[0].providerCount).toBe(2)
    expect(groups[0].providers.map((p) => p.modelID).sort()).toEqual(["gpt-5.6-sol", "openai/gpt-5.6-sol"].sort())
  })

  test("does not merge two different models that happen to share a substring", () => {
    const catalog: CatalogModel[] = [
      { providerID: "openai", modelID: "gpt-5", name: "GPT-5" },
      { providerID: "openai", modelID: "gpt-5.6", name: "GPT-5.6" },
    ]
    const identify = createCatalogIdentify(catalog)
    const models = [row({ providerID: "openai", modelID: "gpt-5", cost: 1 }), row({ providerID: "openai", modelID: "gpt-5.6", cost: 2 })]
    const groups = groupModelsByName(models, identify)
    expect(groups).toHaveLength(2)
  })

  test("falls back to the literal modelID when a row isn't in the catalog (disconnected provider, retired model)", () => {
    const identify = createCatalogIdentify([{ providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT-5.6 Sol" }])
    const models = [
      row({ providerID: "openai", modelID: "gpt-5.6-sol", cost: 1 }),
      row({ providerID: "retired-vendor", modelID: "some-old-model", cost: 2 }),
    ]
    const groups = groupModelsByName(models, identify)
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.modelID).sort()).toEqual(["GPT-5.6 Sol", "some-old-model"].sort())
  })

  test("is case- and punctuation-insensitive when matching catalog names", () => {
    const catalog: CatalogModel[] = [
      { providerID: "a", modelID: "m1", name: "Claude Sonnet 4.5" },
      { providerID: "b", modelID: "m2", name: "claude-sonnet-4-5" },
    ]
    const identify = createCatalogIdentify(catalog)
    const models = [row({ providerID: "a", modelID: "m1", cost: 1 }), row({ providerID: "b", modelID: "m2", cost: 1 })]
    const groups = groupModelsByName(models, identify)
    expect(groups).toHaveLength(1)
  })

  test("falls back to family when the catalog entry has no name", () => {
    const catalog: CatalogModel[] = [
      { providerID: "a", modelID: "m1", name: "", family: "shared-family" },
      { providerID: "b", modelID: "m2", name: "", family: "shared-family" },
    ]
    const identify = createCatalogIdentify(catalog)
    const models = [row({ providerID: "a", modelID: "m1", cost: 1 }), row({ providerID: "b", modelID: "m2", cost: 1 })]
    const groups = groupModelsByName(models, identify)
    expect(groups).toHaveLength(1)
  })
})
