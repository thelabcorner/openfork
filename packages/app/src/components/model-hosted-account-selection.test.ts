import { describe, expect, test } from "bun:test"
import {
  hostedAccountDisplayVariants,
  hostedAccountDisplayGroup,
  hostedAccountRosterRevision,
  hostedAccountStillVisible,
  hostedAccountRoutingStrategies,
  isHostedAccountProvider,
  pinnedHostedAccount,
  showAccountSubmenu,
} from "./model-hosted-account-selection"

describe("hosted account model selection", () => {
  test("empty live roster never resurrects old catalog-qualified account variants", () => {
    const model = { id: "model", name: "Model", provider: { id: "opencode-go", name: "OpenCode Go" } }
    const cachedCatalogGroup = {
      key: "opencode-go:model",
      canonical: model,
      label: "Model",
      variants: [{ accountID: "revoked-key", item: { ...model, id: "model@revoked-key" } }],
    }
    expect(cachedCatalogGroup.variants).toHaveLength(1)
    const visible = hostedAccountDisplayGroup(model, new Map(), cachedCatalogGroup)
    expect(visible).toMatchObject({
      key: "opencode-go:model",
      canonical: model,
      auto: model,
      label: "Model",
      variants: [],
    })
    expect(hostedAccountStillVisible("revoked-key", visible.variants)).toBe(false)
    expect(showAccountSubmenu("opencode-go", visible.variants.length, true)).toBe(true)
    expect(hostedAccountRoutingStrategies("opencode-go", true)).toEqual(["adaptive", "round-robin"])
  })

  test("after live roster reappears, it restores only current account identities", () => {
    const model = { id: "model", name: "Model", provider: { id: "opencode", name: "Zen" } }
    const visible = hostedAccountDisplayGroup(model, new Map([["current-key", { label: "Current" }]]))
    expect(visible.variants).toHaveLength(1)
    expect(visible.variants[0]).toMatchObject({
      accountID: "current-key",
      item: { id: "model", name: "Model (Current)" },
    })
    expect(hostedAccountStillVisible("previous-key", visible.variants)).toBe(false)
  })
  test("account-qualified search result uses the bare catalog model and never stacks labels", () => {
    const base = { id: "deepseek-flash", name: "DeepSeek Flash", provider: { id: "opencode-go", name: "Go" } }
    const legacy = { ...base, id: "deepseek-flash@zen-a", name: "DeepSeek Flash (Previous)" }
    const visible = hostedAccountDisplayGroup(
      legacy,
      new Map([["zen-b", { label: "Current" }]]),
      {
        key: "opencode-go:deepseek-flash",
        canonical: base,
        auto: base,
        label: base.name,
        variants: [{ accountID: "zen-a", item: legacy }],
      },
    )
    expect(visible.canonical).toEqual(base)
    expect(visible.auto).toEqual(base)
    expect(visible.key).toBe("opencode-go:deepseek-flash")
    expect(visible.variants).toEqual([{
      accountID: "zen-b",
      item: { ...base, name: "DeepSeek Flash (Current)" },
    }])
  })

  test("catalog with only qualified aliases never emits a qualified model selection", () => {
    const legacy = {
      id: "deepseek-flash@zen-a",
      name: "DeepSeek Flash (Previous)",
      provider: { id: "opencode", name: "Zen" },
    }
    const visible = hostedAccountDisplayGroup(legacy, new Map(), {
      key: "opencode:deepseek-flash",
      canonical: legacy,
      label: "DeepSeek Flash",
      variants: [{ accountID: "zen-a", item: legacy }],
    })
    expect(visible.auto?.id).toBe("deepseek-flash")
    expect(visible.canonical.name).toBe("DeepSeek Flash")
    expect(visible.variants).toEqual([])
  })

  test("a stale or mismatched catalog group cannot redirect a hosted model selection", () => {
    const model = { id: "target-model", name: "Target", provider: { id: "opencode", name: "Zen" } }
    const unrelated = { ...model, id: "other-model", name: "Other" }
    const mismatched = {
      key: "opencode:other-model",
      canonical: unrelated,
      auto: unrelated,
      label: unrelated.name,
      variants: [{ accountID: "stale", item: unrelated }],
    }
    const visible = hostedAccountDisplayGroup(model, new Map(), mismatched)
    expect(visible.key).toBe("opencode:target-model")
    expect(visible.canonical).toEqual(model)
    expect(visible.auto).toEqual(model)
    expect(visible.variants).toEqual([])
  })
  test("account roster rows preserve the canonical ID even when no account variant exists in the catalog", () => {
    const model = { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }
    const variants = hostedAccountDisplayVariants(model, new Map([
      ["zen-a", { label: "Go A" }],
      ["zen-b", { label: "Go B" }],
    ]))
    expect(variants.map((variant) => variant.accountID)).toEqual(["zen-a", "zen-b"])
    expect(variants.map((variant) => variant.item.id)).toEqual([model.id, model.id])
    expect(variants.map((variant) => variant.item.name)).toEqual(["DeepSeek V4.1 Flash (Go A)", "DeepSeek V4.1 Flash (Go B)"])
    expect(model).toEqual({ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" })
  })

  test("only hosted Zen and Go providers use explicit account-routing selection", () => {
    expect(isHostedAccountProvider("opencode-go")).toBe(true)
    expect(isHostedAccountProvider("opencode")).toBe(true)
    expect(isHostedAccountProvider("workbuddy")).toBe(false)
  })
  test("a single hosted account remains independently pinnable without changing other providers", () => {
    expect(showAccountSubmenu("opencode-go", 1)).toBe(true)
    expect(showAccountSubmenu("opencode", 1)).toBe(true)
    expect(showAccountSubmenu("opencode-go", 0)).toBe(true)
    expect(showAccountSubmenu("opencode", 0)).toBe(true)
    expect(showAccountSubmenu("workbuddy", 1)).toBe(false)
    expect(showAccountSubmenu("workbuddy", 2)).toBe(true)
  })
  test("model-only pickers cannot expose hosted route policies or pins", () => {
    for (const provider of ["opencode", "opencode-go"]) {
      for (const count of [0, 1, 4]) expect(showAccountSubmenu(provider, count, false)).toBe(false)
      expect(hostedAccountRoutingStrategies(provider, false)).toBeUndefined()
      expect(showAccountSubmenu(provider, 4, true)).toBe(true)
      expect(hostedAccountRoutingStrategies(provider, true)).toEqual(["adaptive", "round-robin"])
    }
    expect(showAccountSubmenu("workbuddy", 2, false)).toBe(true)
    expect(showAccountSubmenu("workbuddy", 1, false)).toBe(false)
    expect(hostedAccountRoutingStrategies("workbuddy", true)).toBeUndefined()
    expect(showAccountSubmenu("opencode-go", 0, true)).toBe(true)
    expect(hostedAccountRoutingStrategies("opencode-go", true)).toEqual(["adaptive", "round-robin"])
  })
  test("missing unqualified catalog alias never switches hosted routing back to a legacy Auto row", () => {
    // The strategy policy intentionally takes provider/capability, not group.auto.
    const group = { variants: [{ accountID: "zen-a" }, { accountID: "zen-b" }], auto: undefined }
    expect(group.auto).toBeUndefined()
    expect(showAccountSubmenu("opencode-go", group.variants.length, true)).toBe(true)
    expect(hostedAccountRoutingStrategies("opencode-go", true)).toEqual(["adaptive", "round-robin"])
  })
  test.each(["opencode", "opencode-go"])("pins %s independently of per-account catalog entries", (providerID) => {
    const model = { id: "deepseek-v4.1-flash", provider: { id: providerID } }
    expect(pinnedHostedAccount(model, "zen-account-b")).toEqual({
      providerID,
      modelID: "deepseek-v4.1-flash",
      routeIntent: { kind: "account", accountID: "zen-account-b", pin: "hard" },
    })
  })

  test("repinning strips the old account suffix rather than stacking identities", () => {
    expect(
      pinnedHostedAccount(
        { id: "deepseek-v4.1-flash@zen-account-a", provider: { id: "opencode-go" } },
        "zen-account-b",
      ),
    ).toMatchObject({
      modelID: "deepseek-v4.1-flash",
      routeIntent: { kind: "account", accountID: "zen-account-b", pin: "hard" },
    })
  })

  test("does not reinterpret WorkBuddy or unrelated provider model IDs", () => {
    expect(pinnedHostedAccount({ id: "model@wb-a", provider: { id: "workbuddy" } }, "wb-b")).toBeUndefined()
    expect(pinnedHostedAccount({ id: "model", provider: { id: "anthropic" } }, "zen-a")).toBeUndefined()
  })

  test("rejects invalid account identities instead of falling back to automatic routing", () => {
    const model = { id: "deepseek-v4.1-flash", provider: { id: "opencode-go" } }
    expect(pinnedHostedAccount(model, "")).toBeUndefined()
    expect(pinnedHostedAccount(model, " zen-a")).toBeUndefined()
    expect(pinnedHostedAccount(model, "a".repeat(257))).toBeUndefined()
  })

  test("revalidates the account submenu when a key is replaced without changing pool size", () => {
    const old = new Map([["zen-a", { label: "First" }]])
    const replaced = new Map([["zen-b", { label: "Second" }]])
    const relabeled = new Map([["zen-a", { label: "Renamed" }]])
    expect(hostedAccountRosterRevision(old)).not.toBe(hostedAccountRosterRevision(replaced))
    expect(hostedAccountRosterRevision(old)).not.toBe(hostedAccountRosterRevision(relabeled))
    expect(hostedAccountRosterRevision(old)).toBe(hostedAccountRosterRevision(new Map(old)))
  })

  test("equivalent account rosters have a stable revision and stable visual order despite poll reordering", () => {
    const model = { id: "model", name: "Model" }
    const first = new Map([["zen-z", { label: "Z" }], ["zen-a", { label: "A" }]])
    const second = new Map([["zen-a", { label: "A" }], ["zen-z", { label: "Z" }]])
    expect(hostedAccountRosterRevision(first)).toBe(hostedAccountRosterRevision(second))
    expect(hostedAccountDisplayVariants(model, first)).toEqual(hostedAccountDisplayVariants(model, second))
    expect(hostedAccountDisplayVariants(model, first).map((entry) => entry.accountID)).toEqual(["zen-a", "zen-z"])
  })

  test("stale account row clicks fail closed after a same-sized roster replacement", () => {
    const old = hostedAccountDisplayVariants({ id: "m", name: "M" }, new Map([
      ["zen-a", { label: "Previous key" }],
      ["zen-b", { label: "Another key" }],
    ]))
    const refreshed = hostedAccountDisplayVariants({ id: "m", name: "M" }, new Map([
      ["zen-b", { label: "Another key" }],
      ["zen-c", { label: "Replacement key" }],
    ]))
    expect(hostedAccountStillVisible("zen-a", old)).toBe(true)
    expect(hostedAccountStillVisible("zen-a", refreshed)).toBe(false)
    expect(hostedAccountStillVisible("zen-c", refreshed)).toBe(true)
    expect(hostedAccountStillVisible("zen-c", [])).toBe(false)
  })
})