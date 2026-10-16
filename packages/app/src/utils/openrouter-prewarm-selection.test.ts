import { describe, expect, test } from "bun:test"
import { MAX_OPENROUTER_PREWARM_MODELS, selectOpenRouterPrewarmModels } from "./openrouter-prewarm-selection"

describe("OpenRouter speculative prewarm budget", () => {
  test("preserves priority, filters providers and deduplicates", () => {
    const selected = selectOpenRouterPrewarmModels(
      [{ providerID: "other", modelID: "ignored" }, { providerID: "openrouter", modelID: "recent" }],
      [
        { providerID: "openrouter", modelID: "recent", favorite: true },
        { providerID: "openrouter", modelID: "favorite", favorite: true },
        { providerID: "openrouter", modelID: "hidden", visibility: "hide" },
      ],
      { "openrouter:pinned": "upstream", "other:ignored": "upstream" },
      () => ["favorite", "catalog-a", "catalog-b"],
    )
    expect(selected).toEqual(["recent", "favorite", "pinned", "catalog-a", "catalog-b"])
  })

  test("never admits an entire large catalog or even evaluates it after filling the budget", () => {
    const favorites = Array.from({ length: MAX_OPENROUTER_PREWARM_MODELS }, (_, index) => ({
      providerID: "openrouter",
      modelID: `favorite-${index}`,
      favorite: true,
    }))
    let catalogTouched = false
    const selected = selectOpenRouterPrewarmModels([], favorites, undefined, () => {
      catalogTouched = true
      return Array.from({ length: 500 }, (_, index) => `catalog-${index}`)
    })
    expect(selected).toHaveLength(MAX_OPENROUTER_PREWARM_MODELS)
    expect(catalogTouched).toBe(false)
  })

  test("bounds low-priority catalog admission and leaves foreground lookups unaffected", () => {
    let examined = 0
    function* catalog() {
      for (let i = 0; i < 500; i++) {
        examined++
        yield `catalog-${i}`
      }
    }
    const result = selectOpenRouterPrewarmModels(
      [{ providerID: "openrouter", modelID: "recent" }],
      [],
      undefined,
      catalog,
      5,
    )
    expect(result).toEqual(["recent", "catalog-0", "catalog-1", "catalog-2", "catalog-3"])
    expect(examined).toBeLessThan(8)
  })
})