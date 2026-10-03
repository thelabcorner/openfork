import { describe, expect, test } from "bun:test"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { OxpError } from "@/oxp/error"
import { OxpRouteIntent } from "@/oxp/route-intent"

const publicIntent: ProviderRouteIntent.Info = { kind: "public" }
const autoIntent: ProviderRouteIntent.Info = { kind: "auto" }
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
    expect(OxpRouteIntent.normalize({})).toEqual({ kind: "auto" })
    expect(OxpRouteIntent.normalize({ legacyAccountID: "acct-a" })).toEqual({
      kind: "account",
      accountID: "acct-a",
      pin: "hard",
    })
    expect(OxpRouteIntent.normalize({ routeIntent: publicIntent })).toEqual({ kind: "public" })
    expect(OxpRouteIntent.normalize({ routeIntent: autoIntent })).toEqual({ kind: "auto" })
    expect(OxpRouteIntent.normalize({ routeIntent: accountIntent("acct-a", "soft") })).toEqual({
      kind: "account",
      accountID: "acct-a",
      pin: "soft",
    })
  })

  test("preserves explicit Public as a first-class route, never as Auto", () => {
    expect(OxpRouteIntent.normalize({ routeIntent: publicIntent })).not.toEqual({ kind: "auto" })
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

    const autoConflict = failure(() =>
      OxpRouteIntent.normalize({ routeIntent: autoIntent, legacyAccountID: "acct-a" }),
    )
    expect(autoConflict._tag).toBe("OXP_CONFLICT")

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
    expect(OxpRouteIntent.accountRouteID(autoIntent)).toBeUndefined()
    expect(OxpRouteIntent.accountRouteID(accountIntent("acct-a"))).toBe("acct-a")
    const resolved = OxpRouteIntent.normalize({ routeIntent: publicIntent })
    expect(resolved).toEqual({ kind: "public" })
    expect(Object.hasOwn(resolved, "accountID")).toBe(false)
    expect(JSON.stringify(resolved)).not.toContain("accountID")
  })

  test("reports account mode from route intent rather than from a missing account", () => {
    expect(OxpRouteIntent.accountMode(autoIntent)).toBe("automatic")
    expect(OxpRouteIntent.accountMode(publicIntent)).toBe("public")
    expect(OxpRouteIntent.accountMode(accountIntent("acct-a"))).toBe("explicit")
  })
})
