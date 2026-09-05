import { describe, expect, test } from "bun:test"

import { rankModels, type CheapnessItem } from "./model-ranking"

/**
 * The PWA ranks models with the same usage-yield engine the desktop selector
 * uses. These cover the wiring — that the corpus, catalog and personal index
 * actually reach `sortByCheapness` — rather than re-testing the economics,
 * which are covered in `packages/app/src/utils/model-usage-yield.test.ts`.
 */

const model = (
  id: string,
  providerID: string,
  cost: { input: number; output: number },
  name = id,
): CheapnessItem => ({
  id,
  name,
  provider: { id: providerID, name: providerID },
  cost: { ...cost, cache: { read: cost.input / 10, write: cost.input } },
})

// One profile row is enough to build a corpus; the ranking only needs the
// workload tuples, not a match against any particular model name.
const tables = {
  profile: [{ names: ["any"], profile: { input: 800, cached: 65_000, output: 220 } }],
  pricing: [],
} as never

describe("rankModels", () => {
  test("sorts by name until the usage tables have loaded", () => {
    // Ranking against a fallback corpus and then visibly resorting once the
    // real tables land is worse than one stable order, so the pre-tables state
    // is deliberately name-sorted - the same thing the desktop shows.
    const models = [model("zeta", "a", { input: 1, output: 1 }), model("alpha", "a", { input: 90, output: 90 })]
    const ranked = rankModels(models, { catalog: models })
    expect(ranked.map((m) => m.id)).toEqual(["alpha", "zeta"])
  })

  test("puts cheaper models first once a corpus exists", () => {
    const cheap = model("cheap", "a", { input: 0.1, output: 0.4 })
    const dear = model("dear", "a", { input: 30, output: 90 })
    const models = [dear, cheap]
    const ranked = rankModels(models, { tables, catalog: models })
    expect(ranked.map((m) => m.id)).toEqual(["cheap", "dear"])
  })

  test("orders the free taxonomy ahead of paid, quota-exempt first", () => {
    // "Free" is a property of the provider's tier, not merely a $0 price: an
    // unpriced model on an ordinary provider is paid-but-unpriced and sorts
    // last. Use the shapes the classifier actually recognises.
    const unlimited = model("some-model", "a", { input: 0, output: 0 }, "Some Model (Unlimited)")
    const openrouterFree = model("vendor/model:free", "openrouter", { input: 0, output: 0 }, "Vendor Model")
    const cheapPaid = model("cheap", "a", { input: 0.01, output: 0.02 })
    const models = [cheapPaid, openrouterFree, unlimited]

    const ranked = rankModels(models, { tables, catalog: models })
    expect(ranked.map((m) => m.id)).toEqual(["some-model", "vendor/model:free", "cheap"])
  })

  test("borrows a sibling's price for a model unpriced on this provider", () => {
    // `openrouter` is excluded from the pricing fallback by design, so use two
    // ordinary providers: the unpriced copy must rank by the priced sibling's
    // cost rather than sorting last as unpriced.
    const unpricedCheap = model("cheap-model", "b", { input: 0, output: 0 }, "Cheap Model")
    const pricedCheap = model("cheap-model", "a", { input: 0.1, output: 0.2 }, "Cheap Model")
    const pricedDear = model("dear-model", "a", { input: 40, output: 80 }, "Dear Model")

    const ranked = rankModels([pricedDear, unpricedCheap], {
      tables,
      // The catalog is wider than the ranked list: the priced sibling is what
      // donates the price, and it is not itself being ranked here.
      catalog: [pricedDear, unpricedCheap, pricedCheap],
    })
    expect(ranked.map((m) => m.id)).toEqual(["cheap-model", "dear-model"])
  })

  test("blends the user's own measured cost into the ranking", () => {
    // Two models with identical published pricing: the one this device has
    // measured as far more expensive per request must rank second.
    const a = model("a-model", "p", { input: 1, output: 2 }, "A Model")
    const b = model("b-model", "p", { input: 1, output: 2 }, "B Model")
    const models = [a, b]

    const baseline = rankModels(models, { tables, catalog: models })
    expect(baseline.map((m) => m.id)).toEqual(["a-model", "b-model"])

    const ranked = rankModels(models, {
      tables,
      catalog: models,
      personal: {
        "p:a-model": { sum: 500, count: 10, input: 0, cacheRead: 0 },
        "p:b-model": { sum: 0.1, count: 10, input: 0, cacheRead: 0 },
      },
    })
    expect(ranked.map((m) => m.id)).toEqual(["b-model", "a-model"])
  })
})
