import { describe, expect, test } from "bun:test"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { OxpError } from "@/oxp/error"
import { OxpRouteIntent } from "@/oxp/route-intent"

const publicIntent: ProviderRouteIntent.Info = { kind: "public" }
const adaptiveIntent: ProviderRouteIntent.Info = { kind: "strategy", strategy: "adaptive" }
const accountIntent = (accountID: string, pin?: "hard" | "soft"): ProviderRouteIntent.Info => ({
  kind: "account",
  accountID,
  ...(pin ? { pin } : {}),
})

function failure(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (OxpError.isError(error)) return error
    throw new Error(`expected a typed OXP failure, received ${String(error)}`, { cause: error })
  }
  throw new Error("expected route-intent normalization to fail closed")
}

describe("OxpRouteIntent.normalize", () => {
  test("reuses the Core migration-window rules instead of restating them", () => {
    expect(OxpRouteIntent.normalize({})).toEqual({ kind: "strategy" })
    expect(OxpRouteIntent.normalize({ legacyAccountID: "acct-a" })).toEqual({
      kind: "account",
      accountID: "acct-a",
      pin: "hard",
    })
    expect(OxpRouteIntent.normalize({ routeIntent: publicIntent })).toEqual({ kind: "public" })
    expect(OxpRouteIntent.normalize({ routeIntent: adaptiveIntent })).toEqual(adaptiveIntent)
    expect(OxpRouteIntent.normalize({ routeIntent: accountIntent("acct-a", "soft") })).toEqual({
      kind: "account",
      accountID: "acct-a",
      pin: "soft",
    })
  })

  test("preserves explicit Public as a first-class route, never as an account strategy", () => {
    expect(OxpRouteIntent.normalize({ routeIntent: publicIntent })).not.toEqual({ kind: "strategy" })
    expect(OxpRouteIntent.accountMode(OxpRouteIntent.normalize({ routeIntent: publicIntent }))).toBe("public")
  })

  test("keeps a legacy account selection a hard account pin", () => {
    const intent = OxpRouteIntent.normalize({ legacyAccountID: "acct-a" })
    expect(intent).toEqual({ kind: "account", accountID: "acct-a", pin: "hard" })
    expect(OxpRouteIntent.accountMode(intent)).toBe("explicit")
  })

  test("projects Core compatibility failures into the OXP error contract", () => {
    const publicConflict = failure(() =>
      OxpRouteIntent.normalize({ routeIntent: publicIntent, legacyAccountID: "acct-a" }),
    )
    expect(publicConflict._tag).toBe("OXP_CONFLICT")
    expect(publicConflict).toBeInstanceOf(OxpError.Conflict)
    expect(publicConflict.detail).toContain("acct-a")
    expect(publicConflict.detail).toContain("account-free")

    const strategyConflict = failure(() =>
      OxpRouteIntent.normalize({ routeIntent: adaptiveIntent, legacyAccountID: "acct-a" }),
    )
    expect(strategyConflict._tag).toBe("OXP_CONFLICT")

    const accountConflict = failure(() =>
      OxpRouteIntent.normalize({ routeIntent: accountIntent("acct-b"), legacyAccountID: "acct-a" }),
    )
    expect(accountConflict._tag).toBe("OXP_CONFLICT")
    expect(accountConflict.detail).toContain("acct-b")

    const invalidLegacy = failure(() => OxpRouteIntent.normalize({ legacyAccountID: "" }))
    expect(invalidLegacy._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(invalidLegacy).toBeInstanceOf(OxpError.InvalidArgument)
  })

  test("never derives an account identity from a non-account route", () => {
    expect(OxpRouteIntent.accountRouteID(publicIntent)).toBeUndefined()
    expect(OxpRouteIntent.accountRouteID(adaptiveIntent)).toBeUndefined()
    expect(OxpRouteIntent.accountRouteID(accountIntent("acct-a"))).toBe("acct-a")
    const resolved = OxpRouteIntent.normalize({ routeIntent: publicIntent })
    expect(resolved).toEqual({ kind: "public" })
    expect(Object.hasOwn(resolved, "accountID")).toBe(false)
    expect(JSON.stringify(resolved)).not.toContain("accountID")
  })

  test("reports account mode from route intent rather than from a missing account", () => {
    expect(OxpRouteIntent.accountMode(adaptiveIntent)).toBe("adaptive")
    expect(OxpRouteIntent.accountMode({ kind: "strategy", strategy: "round-robin" })).toBe("round-robin")
    expect(OxpRouteIntent.accountMode(publicIntent)).toBe("public")
    expect(OxpRouteIntent.accountMode(accountIntent("acct-a"))).toBe("explicit")
  })
})
