import { describe, expect, test } from "bun:test"
import { hasPublishedPricing, isUnlimitedModel, stripUnlimitedSuffix } from "./model-badges"

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
