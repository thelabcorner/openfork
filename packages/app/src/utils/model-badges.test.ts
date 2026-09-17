import { describe, expect, test } from "bun:test"
import { hasPublishedPricing, isUnlimitedModel, stripUnlimitedSuffix } from "./model-badges"
import { classifyMonetaryClass, isFreeModel } from "./model-cost"

describe("free tier ownership", () => {
  // The badge (`isFreeModel`) and the yield ranking (`classifyMonetaryClass`)
  // must never disagree about whether a model is free: a model tagged "Free"
  // in a row that the ranking sorted into the paid tier is the exact class of
  // ownership mistake this suite exists to catch.
  const samples = [
    { id: "stealth/union-alpha", provider: { id: "openrouter" }, cost: { input: 0, output: 0 } },
    { id: "stealth/claude-opus-4.8", provider: { id: "openrouter" }, cost: { input: 4, output: 20 } },
    { id: "google/gemma-4-31b-it:free", provider: { id: "openrouter" }, cost: { input: 0, output: 0 } },
    { id: "openrouter/free", provider: { id: "openrouter" }, cost: { input: 0, output: 0 } },
    { id: "openrouter/auto", provider: { id: "openrouter" }, cost: { input: 0, output: 0 } },
    { id: "google/lyria-3-pro-preview", provider: { id: "openrouter" }, cost: { input: 0, output: 0 } },
    { id: "claude-sonnet", provider: { id: "openrouter" }, cost: { input: 0, output: 0 } },
    { id: "union-alpha", provider: { id: "opencode" }, cost: { input: 0, output: 0 } },
    { id: "union-alpha", provider: { id: "opencode-go" }, cost: { input: 0, output: 0 } },
    { id: "glm-5.3", provider: { id: "opencode-go" }, cost: { input: 0.5, output: 2 } },
    { id: "deepseek-v4-flash", provider: { id: "zenmux" }, cost: { input: 0, output: 0 } },
    { id: "glm-4.5-air", provider: { id: "qiniu-ai" }, cost: undefined },
  ]

  test("badge and ranking never disagree on any catalog shape", () => {
    const divergences = samples.filter((model) => {
      const rankedFree = classifyMonetaryClass(model) !== "paid"
      return rankedFree !== isFreeModel(model)
    })
    expect(divergences).toEqual([])
  })
})

describe("isUnlimitedModel", () => {
  test("matches unlimited models that publish $0 input cost", () => {
    expect(isUnlimitedModel({ id: "ox-alpha-free", name: "Ox Alpha Free (Unlimited)", cost: { input: 0 } })).toBe(true)
    expect(isUnlimitedModel({ id: "unlimited-pro", name: "Unlimited Pro", cost: { input: 0 } })).toBe(true)
  })

  test("rejects paid models even when marketed as unlimited", () => {
    expect(isUnlimitedModel({ id: "unlimited-plan", name: "Unlimited Plan", cost: { input: 3 } })).toBe(false)
    expect(isUnlimitedModel({ id: "gpt-x", name: "GPT X", cost: { input: 0 } })).toBe(false)
  })
})

describe("hasPublishedPricing", () => {
  test("treats absent or all-zero rates as unpriced", () => {
    expect(hasPublishedPricing(undefined)).toBe(false)
    expect(hasPublishedPricing({ input: 0, output: 0 })).toBe(false)
    expect(hasPublishedPricing({ input: 5, output: 30 })).toBe(true)
    expect(hasPublishedPricing({ input: 0, output: 1.2 })).toBe(true)
  })
})

describe("stripUnlimitedSuffix", () => {
  test("removes the trailing (Unlimited) suffix", () => {
    expect(stripUnlimitedSuffix("Ox Alpha Free (Unlimited)")).toBe("Ox Alpha Free")
    expect(stripUnlimitedSuffix("Ox Alpha Free")).toBe("Ox Alpha Free")
  })
})

describe("isFreeModel", () => {
  const zero = { input: 0, output: 0 }

  test("recognizes the OpenRouter :free family and free router", () => {
    expect(isFreeModel({ id: "google/gemma-4-31b-it:free", provider: { id: "openrouter" }, cost: zero })).toBe(true)
    expect(isFreeModel({ id: "openrouter/free", provider: { id: "openrouter" }, cost: zero })).toBe(true)
  })

  test("recognizes a zero-priced OpenRouter stealth model with no :free suffix", () => {
    // Regression: `stealth/union-alpha` publishes an explicit all-zero price but
    // ships without the suffix, so it was tagged and sorted as a paid model.
    expect(
      isFreeModel({
        id: "stealth/union-alpha",
        name: "Union Alpha",
        provider: { id: "openrouter" },
        cost: zero,
      }),
    ).toBe(true)
  })

  test("does not call a paid stealth model free", () => {
    // The stealth namespace is not free by itself; only an all-zero price is.
    expect(
      isFreeModel({ id: "stealth/claude-opus-4.8", provider: { id: "openrouter" }, cost: { input: 4, output: 20 } }),
    ).toBe(false)
  })

  test("does not call an unpriced media model free", () => {
    // A zero-priced audio/image model is unpriced, not a free text tier.
    expect(isFreeModel({ id: "google/lyria-3-pro-preview", provider: { id: "openrouter" }, cost: zero })).toBe(false)
  })

  test("leaves an unpriced OpenRouter model to its paid sibling fallback", () => {
    // `claude-sonnet` is all-zero on openrouter only because it is unpriced
    // there; it must borrow anthropic's published price, not become free.
    expect(isFreeModel({ id: "claude-sonnet", provider: { id: "openrouter" }, cost: zero })).toBe(false)
  })

  test("does not call OpenRouter meta-routers free", () => {
    // Their price is variable, not free, even though the catalog reads zero.
    expect(isFreeModel({ id: "openrouter/auto", provider: { id: "openrouter" }, cost: zero })).toBe(false)
    expect(isFreeModel({ id: "openrouter/pareto-code", provider: { id: "openrouter" }, cost: zero })).toBe(false)
  })

  test("treats an all-zero OpenCode Zen / Go entry as the free tier", () => {
    expect(isFreeModel({ id: "union-alpha", provider: { id: "opencode" }, cost: zero })).toBe(true)
    expect(isFreeModel({ id: "union-alpha", provider: { id: "opencode-go" }, cost: zero })).toBe(true)
    expect(
      isFreeModel({ id: "glm-5.3", provider: { id: "opencode-go" }, cost: { input: 0.5, output: 2 } }),
    ).toBe(false)
  })

  test("does not invent a free tier for providers whose zeros mean unpriced", () => {
    // Every other provider publishes real rates or nothing at all; an all-zero
    // entry there is a model we cannot price, not a free tier.
    expect(isFreeModel({ id: "deepseek-v4-flash", provider: { id: "zenmux" }, cost: zero })).toBe(false)
    expect(isFreeModel({ id: "glm-4.5-air", provider: { id: "qiniu-ai" }, cost: undefined })).toBe(false)
  })
})
