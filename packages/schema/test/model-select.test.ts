import { describe, expect, test } from "bun:test"

import { mergePreferences } from "../src/model-select/preferences"
import {
  applyProviderRailOrder,
  PROVIDER_RAIL_ORDER_KEY,
  readRailOrder,
  sectionStorageKey,
} from "../src/model-select/rail-order"

/**
 * These two modules are the seam that lets the PWA render the desktop's
 * provider rail. Both sides import them, and the server persists what they
 * produce, so a change in either one silently reorders a paired phone.
 */

describe("rail order", () => {
  test("uses the section key the desktop model store already persists", () => {
    // Changing this orphans every order a user has already dragged.
    expect(PROVIDER_RAIL_ORDER_KEY).toBe("section:provider:rail")
    expect(sectionStorageKey("favorites")).toBe("section:favorites")
    expect(sectionStorageKey("anthropic")).toBe("section:provider:anthropic")
  })

  test("reads an order out of a preferences-shaped record", () => {
    expect(readRailOrder({ [PROVIDER_RAIL_ORDER_KEY]: ["openai", "anthropic"] })).toEqual(["openai", "anthropic"])
  })

  test("treats a malformed order as absent rather than throwing", () => {
    // A corrupt document must degrade to the computed order, never blow up
    // inside a render.
    expect(readRailOrder(undefined)).toEqual([])
    expect(readRailOrder({ [PROVIDER_RAIL_ORDER_KEY]: "openai" })).toEqual([])
    expect(readRailOrder({ [PROVIDER_RAIL_ORDER_KEY]: ["openai", 7] })).toEqual([])
  })

  test("orders providers by the stored snapshot", () => {
    const providers = [{ id: "anthropic" }, { id: "openai" }, { id: "google" }]
    expect(applyProviderRailOrder(providers, ["openai", "google", "anthropic"]).map((p) => p.id)).toEqual([
      "openai",
      "google",
      "anthropic",
    ])
  })

  test("leaves providers the snapshot never saw in their computed position", () => {
    // A provider added after the last reorder must not be shuffled into the
    // middle of the rail by a stale snapshot.
    const providers = [{ id: "anthropic" }, { id: "openai" }, { id: "newcomer" }]
    expect(applyProviderRailOrder(providers, ["openai", "anthropic"]).map((p) => p.id)).toEqual([
      "openai",
      "anthropic",
      "newcomer",
    ])
  })
})

describe("preferences merge", () => {
  const at = 1_700_000_000_000

  test("merges record fields per key instead of replacing them", () => {
    // The desktop reorders its rail; the phone, which never saw that write,
    // reorders one provider group. Neither may lose the other.
    const afterDesktop = mergePreferences({}, { order: { "section:provider:rail": ["openai"] } }, at)
    const afterPhone = mergePreferences(afterDesktop, { order: { "section:provider:openai": ["openai:gpt-5"] } }, at)

    expect(afterPhone.order).toEqual({
      "section:provider:rail": ["openai"],
      "section:provider:openai": ["openai:gpt-5"],
    })
  })

  test("replaces list fields, which are edited as a unit", () => {
    const base = mergePreferences({}, { favorite: ["a:1", "b:2"] }, at)
    expect(mergePreferences(base, { favorite: ["a:1"] }, at).favorite).toEqual(["a:1"])
  })

  test("leaves untouched fields alone", () => {
    const base = mergePreferences({}, { favorite: ["a:1"], subProvider: { "openrouter:m": "novita" } }, at)
    const next = mergePreferences(base, { recent: [{ providerID: "a", modelID: "1" }] }, at)
    expect(next.favorite).toEqual(["a:1"])
    expect(next.subProvider).toEqual({ "openrouter:m": "novita" })
  })

  test("drops keys named in remove", () => {
    const base = mergePreferences({}, { subProvider: { "openrouter:m": "novita", "openrouter:n": "groq" } }, at)
    const next = mergePreferences(base, { remove: { subProvider: ["openrouter:m"] } }, at)
    expect(next.subProvider).toEqual({ "openrouter:n": "groq" })
  })

  test("omits a record that has been emptied rather than storing {}", () => {
    const base = mergePreferences({}, { subProvider: { "openrouter:m": "novita" } }, at)
    const next = mergePreferences(base, { remove: { subProvider: ["openrouter:m"] } }, at)
    expect(next.subProvider).toBeUndefined()
  })

  test("stamps the write time", () => {
    expect(mergePreferences({}, { favorite: [] }, at).updatedAt).toBe(at)
  })
})
