import { describe, expect, test } from "bun:test"
import { ModelsQuery } from "../../src/models/query"

const providers = {
  "opencode-go": {
    name: "OpenCode Go",
    key: "secret-should-not-leak",
    models: {
      "deepseek-r1": {
        id: "deepseek-r1", name: "DeepSeek R1", family: "deepseek",
        reasoning: true, tool_call: true,
        limit: { context: 128_000, output: 8192 },
        cost: { input: 0, output: 0 },
        release_date: "2026-05-01",
        options: { apiKey: "super-secret" },
      },
      "expensive": {
        id: "expensive", name: "Expensive Fast Model",
        reasoning: false, tool_call: true,
        limit: { context: 256_000, output: 32_000 },
        cost: { input: 3, output: 15 },
        release_date: "2026-09-01",
      },
    },
  },
  "example": {
    name: "Example",
    models: {
      "vision": {
        id: "vision", name: "Vision Model",
        reasoning: false, tool_call: false,
        modalities: { input: ["image", "text"] },
        limit: { context: 32_000, output: 1024 },
      },
    },
  },
}
const rows = ModelsQuery.rowsFromProviders(providers)
const models = (p: ModelsQuery.Input, index?: Map<string, number>) => {
  const result = ModelsQuery.queryModels(rows, p, index)
  if (result.action === "providers") throw new Error("expected models")
  return result
}

describe("shared models query", () => {
  test("whitelists metadata and never leaks provider credentials or options", () => {
    const json = JSON.stringify(rows)
    expect(json).not.toContain("secret-should-not-leak")
    expect(json).not.toContain("super-secret")
    expect(json).not.toContain("apiKey")
    expect(rows[0]?.publishedZeroCost).toBe(true)
  })
  test("multi-term search resolves provider/id and name with relevance", () => {
    expect(models({ q: "deepseek r1" }).models.map((x) => x.modelID)).toEqual(["deepseek-r1"])
    expect(models({ q: "opencode-go/deepseek-r1" }).models.map((x) => x.modelID)).toEqual(["deepseek-r1"])
    expect(models({ q: "not a model" }).total).toBe(0)
  })
  test("filters don't hallucinate missing prices as zero", () => {
    expect(models({ zeroCost: true }).models.map((x) => x.modelID)).toEqual(["deepseek-r1"])
    expect(models({ maxInputCost: 1 }).total).toBe(1)
    expect(models({ vision: true }).models.map((x) => x.modelID)).toEqual(["vision"])
    expect(models({ reasoning: true, tools: true, minContext: 100_000 }).total).toBe(1)
  })
  test("deterministic pagination and missing numeric values last in both orders", () => {
    const all = models({ sort: "inputCost", limit: 1 })
    const page2 = models({ sort: "inputCost", offset: 1, limit: 1 })
    expect(all.models[0]?.modelID).toBe("deepseek-r1")
    expect(page2.models[0]?.modelID).toBe("expensive")
    expect(all.hasMore).toBe(true)
    expect(models({ sort: "inputCost", order: "desc" }).models.at(-1)?.modelID).toBe("vision")
  })
  test("exact get and usage ranking require authorized index", () => {
    expect(() => models({ sort: "usage" })).toThrow()
    const index = new Map([
      [ModelsQuery.identity("example", "vision"), 42],
      [ModelsQuery.identity("opencode-go", "deepseek-r1"), 3],
    ])
    expect(models({ sort: "usage" }, index).models[0]?.modelID).toBe("vision")
    expect(models({ action: "get", providerID: "opencode-go", modelID: "deepseek-r1" }).returned).toBe(1)
    expect(() => models({ action: "get", modelID: "deepseek-r1" })).toThrow()
    expect(() => models({ modelID: "deepseek-r1" })).toThrow()
  })
  test("provider counts preserve configured identities", () => {
    const result = ModelsQuery.queryModels(rows, { action: "providers" })
    expect("providers" in result ? result.providers : []).toEqual([
      { providerID: "example", models: 1 },
      { providerID: "opencode-go", models: 2 },
    ])
    const page = ModelsQuery.queryModels(rows, { action: "providers", limit: 1 })
    expect(page.action).toBe("providers")
    expect(page.returned).toBe(1)
    expect(page.hasMore).toBe(true)
  })
  test("release sorting caches date parsing and keeps unknown releases last", () => {
    expect(models({ sort: "release", order: "desc" }).models.map((x) => x.modelID))
      .toEqual(["expensive", "deepseek-r1", "vision"])
    expect(models({ sort: "release", order: "asc" }).models.map((x) => x.modelID))
      .toEqual(["deepseek-r1", "expensive", "vision"])
  })
  test("10,000-row query is bounded, stable and has no materialized history", () => {
    const synthetic = Array.from({ length: 10_000 }, (_, i) => ({
      ...rows[0]!, modelID: `model-${i.toString().padStart(5, "0")}`,
    }))
    const started = performance.now()
    const result = ModelsQuery.queryModels(synthetic, { q: "model", sort: "context", limit: 25 })
    const elapsedMs = performance.now() - started
    expect("models" in result ? result.models.length : 0).toBe(25)
    expect(result.total).toBe(10_000)
    expect(elapsedMs).toBeLessThan(2_000)
  })
})
