import { describe, expect, test } from "bun:test"
import { groupModelsByName, modelsForProvider, type UsageModelRow } from "./usage-model-groups"

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
})

describe("groupModelsByName", () => {
  test("merges the same modelID served by different providers into one group", () => {
    const models = [
      row({ providerID: "anthropic", modelID: "claude-sonnet-4-5", cost: 3, messages: 10, share: 0.3 }),
      row({ providerID: "opencode-go", modelID: "claude-sonnet-4-5", cost: 7, messages: 20, share: 0.7 }),
    ]
    const groups = groupModelsByName(models)
    expect(groups).toHaveLength(1)
    expect(groups[0].modelID).toBe("claude-sonnet-4-5")
    expect(groups[0].cost).toBeCloseTo(10)
    expect(groups[0].messages).toBe(30)
    expect(groups[0].share).toBeCloseTo(1)
    expect(groups[0].providerCount).toBe(2)
    expect(groups[0].providers).toHaveLength(2)
  })

  test("does not merge different modelIDs even from the same provider", () => {
    const models = [
      row({ providerID: "anthropic", modelID: "claude-sonnet-4-5", cost: 1 }),
      row({ providerID: "anthropic", modelID: "claude-opus-4-5", cost: 2 }),
    ]
    const groups = groupModelsByName(models)
    expect(groups).toHaveLength(2)
  })

  test("keeps distinct provider+variant rows separate within a group's providers list", () => {
    const models = [
      row({ providerID: "anthropic", modelID: "m", variant: "high", cost: 5 }),
      row({ providerID: "anthropic", modelID: "m", variant: "low", cost: 1 }),
    ]
    const groups = groupModelsByName(models)
    expect(groups).toHaveLength(1)
    expect(groups[0].providers).toHaveLength(2)
    expect(groups[0].providerCount).toBe(1) // same provider, different variant
  })

  test("sums cost from both recorded and estimated cost", () => {
    const models = [row({ providerID: "p", modelID: "m", cost: 2, estimatedCost: 1.5 })]
    const groups = groupModelsByName(models)
    expect(groups[0].cost).toBeCloseTo(3.5)
  })

  test("sums all token categories", () => {
    const models = [
      row({
        providerID: "p",
        modelID: "m",
        tokens: { input: 10, cacheRead: 20, cacheWrite: 5, output: 30, reasoning: 2 },
      }),
    ]
    const groups = groupModelsByName(models)
    expect(groups[0].tokens).toBe(67)
  })

  test("sorts groups by total cost descending", () => {
    const models = [
      row({ providerID: "p", modelID: "cheap", cost: 1 }),
      row({ providerID: "p", modelID: "expensive", cost: 100 }),
      row({ providerID: "p", modelID: "mid", cost: 10 }),
    ]
    const groups = groupModelsByName(models)
    expect(groups.map((g) => g.modelID)).toEqual(["expensive", "mid", "cheap"])
  })

  test("within a group, sorts providers by cost descending", () => {
    const models = [
      row({ providerID: "a", modelID: "m", cost: 1 }),
      row({ providerID: "b", modelID: "m", cost: 50 }),
      row({ providerID: "c", modelID: "m", cost: 10 }),
    ]
    const groups = groupModelsByName(models)
    expect(groups[0].providers.map((p) => p.providerID)).toEqual(["b", "c", "a"])
  })

  test("normalizes an empty-string variant to null", () => {
    const models = [row({ providerID: "p", modelID: "m", variant: "" })]
    const groups = groupModelsByName(models)
    expect(groups[0].providers[0].variant).toBeNull()
  })

  test("returns an empty list for no models, and never truncates a large list", () => {
    expect(groupModelsByName([])).toEqual([])
    const many = Array.from({ length: 200 }, (_, i) => row({ providerID: "p", modelID: `m${i}`, cost: i }))
    expect(groupModelsByName(many)).toHaveLength(200)
  })
})

describe("modelsForProvider", () => {
  test("returns only rows for the requested provider", () => {
    const models = [
      row({ providerID: "a", modelID: "m1", cost: 1 }),
      row({ providerID: "b", modelID: "m2", cost: 2 }),
      row({ providerID: "a", modelID: "m3", cost: 3 }),
    ]
    const rows = modelsForProvider(models, "a")
    expect(rows.map((r) => r.modelID)).toEqual(["m3", "m1"]) // sorted by cost desc
  })

  test("returns an empty list for a provider with no usage", () => {
    const models = [row({ providerID: "a", modelID: "m1" })]
    expect(modelsForProvider(models, "unused")).toEqual([])
  })

  test("does not truncate a provider with many models", () => {
    const models = Array.from({ length: 50 }, (_, i) => row({ providerID: "a", modelID: `m${i}` }))
    expect(modelsForProvider(models, "a")).toHaveLength(50)
  })
})
