import { describe, expect, test } from "bun:test"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import { makeUsageRatesCache } from "./model-rates-cache"

const catalog = (price: number): Record<string, ModelsDev.Provider> => ({
  vendor: {
    id: "vendor",
    name: "Vendor",
    env: [],
    models: {
      model: {
        id: "model",
        name: "Model",
        family: "test",
        release_date: "2025-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 1000, output: 100 },
        cost: { input: price, output: price * 2 },
      },
    },
  },
})

describe("Usage immutable-model-catalog rates cache", () => {
  test("reuses rates for the exact same catalog snapshot", () => {
    const ratesFor = makeUsageRatesCache()
    const source = catalog(3)
    const first = ratesFor(source)
    expect(ratesFor(source)).toBe(first)
    expect(first.get("vendor/model")).toEqual({
      input: 3, output: 6, cacheRead: 3, cacheWrite: 3,
    })
  })

  test("refreshes all rates when ModelsDev publishes a different snapshot", () => {
    const ratesFor = makeUsageRatesCache()
    const initial = ratesFor(catalog(3))
    const replaced = ratesFor(catalog(9))
    expect(replaced).not.toBe(initial)
    expect(replaced.get("vendor/model")?.input).toBe(9)
    expect(initial.get("vendor/model")?.input).toBe(3)
    expect(ratesFor(catalog(3))).not.toBe(initial)
  })

  test("separates independent owning service instances", () => {
    const snapshot = catalog(3)
    expect(makeUsageRatesCache()(snapshot)).not.toBe(makeUsageRatesCache()(snapshot))
  })
})
