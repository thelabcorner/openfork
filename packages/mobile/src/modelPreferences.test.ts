import { describe, expect, test } from "bun:test"
import { createModelPreferences, subProviderKeyFor } from "./modelPreferences"

/**
 * The rail-order parsing itself now lives in
 * `@opencode-ai/schema/model-select/rail-order` (shared with the desktop) and
 * is covered there. What remains worth testing here is the store's own
 * behaviour: optimistic local writes, and merge-patching that must not let one
 * client clobber another's keys.
 */

function stubStorage() {
  const map = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
  return map
}

const noClient = () => undefined

describe("model preferences store", () => {
  test("applies a locally stored rail order without a server", () => {
    stubStorage()
    const prefs = createModelPreferences({ client: noClient })
    prefs.setOrder("rail", ["openai", "anthropic"])

    const providers = [{ id: "anthropic" }, { id: "openai" }, { id: "openrouter" }]
    expect(prefs.applyRail(providers).map((p) => p.id)).toEqual(["openai", "anthropic", "openrouter"])
  })

  test("leaves providers the snapshot has never seen in their computed order", () => {
    stubStorage()
    const prefs = createModelPreferences({ client: noClient })
    prefs.setOrder("rail", ["openai"])

    // A single-entry snapshot cannot reorder anything - a partial write from an
    // older client must not shuffle providers it never saw.
    const providers = [{ id: "anthropic" }, { id: "openai" }]
    expect(prefs.applyRail(providers).map((p) => p.id)).toEqual(["anthropic", "openai"])
  })

  test("a section write does not clobber an unrelated section", () => {
    stubStorage()
    const prefs = createModelPreferences({ client: noClient })
    prefs.setOrder("rail", ["openai"])
    prefs.setFavorites(["openai:gpt-5"])

    expect(prefs.orderFor("rail")).toEqual(["openai"])
    expect(prefs.favorites()).toEqual(["openai:gpt-5"])
  })

  test("clearing a sub-provider pin sends null rather than the old value", () => {
    stubStorage()
    const prefs = createModelPreferences({ client: noClient })
    prefs.setSubProvider("openrouter:some/model", "novita")
    expect(prefs.subProviderFor("openrouter:some/model")).toBe("novita")

    prefs.setSubProvider("openrouter:some/model", undefined)
    expect(prefs.subProviderFor("openrouter:some/model")).toBeUndefined()
  })

  test("treats an empty stored pin as unpinned", () => {
    stubStorage()
    const prefs = createModelPreferences({ client: noClient })
    prefs.setSubProvider("openrouter:m", "")
    // Sending an empty `only: [""]` upstream would break every request.
    expect(prefs.subProviderFor("openrouter:m")).toBeUndefined()
  })

  test("notifies subscribers on mutation", () => {
    stubStorage()
    const prefs = createModelPreferences({ client: noClient })
    let calls = 0
    prefs.subscribe(() => calls++)
    prefs.setFavorites(["a:b"])
    expect(calls).toBeGreaterThan(0)
  })
})

describe("subProviderKeyFor", () => {
  test("keys a pin by the base model, not the account variant", () => {
    // The picker writes the pin while a specific account row is highlighted;
    // `send()` reads it back from whatever the session ended up storing. If the
    // two disagreed on the key, the pin would silently never be applied.
    expect(subProviderKeyFor("openrouter", "vendor/model")).toBe("openrouter:vendor/model")
    expect(subProviderKeyFor("workbuddy", "vendor/model@wb-abc")).toBe("workbuddy:vendor/model")
    expect(subProviderKeyFor("opencode", "vendor/model@zen-abc")).toBe("opencode:vendor/model")
  })

  test("leaves an unrelated @ in a model id alone", () => {
    // Only a known account prefix marks an account boundary - Verdent context
    // aliases legitimately contain "@".
    expect(subProviderKeyFor("openrouter", "vendor/model@2024")).toBe("openrouter:vendor/model@2024")
  })
})

describe("pin round-trip", () => {
  test("survives being read back through the same key the picker wrote", () => {
    stubStorage()
    const prefs = createModelPreferences({ client: noClient })
    prefs.setSubProvider(subProviderKeyFor("openrouter", "vendor/model"), "novita")
    expect(prefs.subProviderFor(subProviderKeyFor("openrouter", "vendor/model"))).toBe("novita")

    prefs.setSubProvider(subProviderKeyFor("openrouter", "vendor/model"), undefined)
    expect(prefs.subProviderFor(subProviderKeyFor("openrouter", "vendor/model"))).toBeUndefined()
  })
})
