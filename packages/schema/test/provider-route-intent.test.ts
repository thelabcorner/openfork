import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderRouteIntent } from "../src/model-select/provider-route-intent"
import { ScheduledTask } from "../src/scheduled-task"

const decodeIntent = Schema.decodeUnknownSync(ProviderRouteIntent.Info)
const decodeAction = Schema.decodeUnknownSync(ScheduledTask.Action)

describe("ProviderRouteIntent", () => {
  test("decodes auto, public, and account without fabricating public account identity", () => {
    expect(decodeIntent({ kind: "auto" })).toEqual({ kind: "auto" })
    expect(decodeIntent({ kind: "public" })).toEqual({ kind: "public" })
    expect(decodeIntent({ kind: "account", accountID: "acct-a", pin: "soft" })).toEqual({
      kind: "account",
      accountID: "acct-a",
      pin: "soft",
    })
    expect("accountID" in decodeIntent({ kind: "public" })).toBe(false)
  })

  test("account pin is optional but account identity is required", () => {
    expect(decodeIntent({ kind: "account", accountID: "acct-a" })).toEqual({
      kind: "account",
      accountID: "acct-a",
    })
    expect(() => decodeIntent({ kind: "account", accountID: "" })).toThrow()
    expect(() => decodeIntent({ kind: "account" })).toThrow()
  })

  test("only Adaptive and Round Robin are valid automatic account-routing strategies", () => {
    expect(ProviderRouteIntent.effectiveStrategy(undefined)).toBe("adaptive")
    expect(ProviderRouteIntent.effectiveStrategy(decodeIntent({ kind: "auto" }))).toBe("adaptive")
    expect(ProviderRouteIntent.effectiveStrategy(decodeIntent({ kind: "auto", strategy: "adaptive" }))).toBe("adaptive")
    expect(ProviderRouteIntent.effectiveStrategy(decodeIntent({ kind: "auto", strategy: "round-robin" }))).toBe("round-robin")
    expect(ProviderRouteIntent.effectiveStrategy(decodeIntent({ kind: "account", accountID: "a" }))).toBeUndefined()
    expect(ProviderRouteIntent.effectiveStrategy(decodeIntent({ kind: "public" }))).toBeUndefined()
    expect(() => decodeIntent({ kind: "auto", strategy: "auto" })).toThrow()
    expect(() => decodeIntent({ kind: "auto", strategy: "concentrate" })).toThrow()
  })
})

describe("ScheduledTask.Action route intent", () => {
  test("persists explicit public separately from legacy model.accountID", () => {
    const action = decodeAction({
      prompt: "run",
      model: { providerID: "opencode", id: "space-bunny-free" },
      routeIntent: { kind: "public" },
    })
    expect(action.routeIntent).toEqual({ kind: "public" })
    expect(action.model?.accountID).toBeUndefined()
  })

  test("persists explicit account intent independently of model compatibility fields", () => {
    const action = decodeAction({
      prompt: "run",
      model: { providerID: "opencode", id: "model-a" },
      routeIntent: { kind: "account", accountID: "acct-a", pin: "hard" },
    })
    expect(action.routeIntent).toEqual({ kind: "account", accountID: "acct-a", pin: "hard" })
    expect(action.model?.accountID).toBeUndefined()
  })

  test("keeps legacy actions decodable for later Core normalization", () => {
    const action = decodeAction({
      prompt: "run",
      model: { providerID: "opencode", id: "model-a", accountID: "acct-a" },
    })
    expect(action.routeIntent).toBeUndefined()
    expect(action.model?.accountID).toBe("acct-a")
  })
})
