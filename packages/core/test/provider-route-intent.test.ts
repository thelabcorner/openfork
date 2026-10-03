import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderRouteIntentRuntime } from "@opencode-ai/core/provider-route-intent"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"

const normalize = (input: ProviderRouteIntentRuntime.NormalizeInput) =>
  Effect.runSync(
    ProviderRouteIntentRuntime.normalize(input).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    ),
  )

const right = (input: ProviderRouteIntentRuntime.NormalizeInput) => {
  const result = normalize(input)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("expected route intent normalization to succeed")
  return result.value
}

const left = (input: ProviderRouteIntentRuntime.NormalizeInput) => {
  const result = normalize(input)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("expected route intent normalization to fail")
  return result.error
}

describe("ProviderRouteIntentRuntime.normalize", () => {
  test("maps an entirely legacy-empty selection to Auto", () => {
    expect(right({})).toEqual({ kind: "auto" })
  })

  test("maps a legacy account selection to an explicit hard account pin", () => {
    expect(right({ legacyAccountID: "acct-a" })).toEqual({
      kind: "account",
      accountID: "acct-a",
      pin: "hard",
    })
  })

  test("preserves explicit Auto and Public when no legacy account is present", () => {
    expect(right({ routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }) })).toEqual({ kind: "auto" })
    expect(right({ routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }) })).toEqual({ kind: "public" })
  })

  test("preserves explicit account intent and its pin when legacy identity agrees", () => {
    const soft = ProviderRouteIntent.Info.make({
      kind: "account",
      accountID: "acct-a",
      pin: "soft",
    })
    expect(right({ routeIntent: soft })).toEqual(soft)
    expect(right({ routeIntent: soft, legacyAccountID: "acct-a" })).toEqual(soft)

    const unpinned = ProviderRouteIntent.Info.make({
      kind: "account",
      accountID: "acct-a",
    })
    expect(right({ routeIntent: unpinned, legacyAccountID: "acct-a" })).toEqual(unpinned)
  })

  test("rejects legacy account identity alongside explicit Auto or Public", () => {
    const auto = left({
      routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
      legacyAccountID: "acct-a",
    })
    expect(auto._tag).toBe("ProviderRouteIntent.Conflict")
    if (auto._tag === "ProviderRouteIntent.Conflict") {
      expect(auto.legacyAccountID).toBe("acct-a")
      expect(auto.routeKind).toBe("auto")
      expect(auto.routeAccountID).toBeUndefined()
    }

    const publicRoute = left({
      routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
      legacyAccountID: "acct-a",
    })
    expect(publicRoute._tag).toBe("ProviderRouteIntent.Conflict")
    if (publicRoute._tag === "ProviderRouteIntent.Conflict") {
      expect(publicRoute.routeKind).toBe("public")
      expect(publicRoute.routeAccountID).toBeUndefined()
    }
  })

  test("rejects conflicting explicit and legacy account identities", () => {
    const error = left({
      routeIntent: ProviderRouteIntent.Info.make({
        kind: "account",
        accountID: "acct-b",
        pin: "hard",
      }),
      legacyAccountID: "acct-a",
    })

    expect(error._tag).toBe("ProviderRouteIntent.Conflict")
    if (error._tag === "ProviderRouteIntent.Conflict") {
      expect(error.legacyAccountID).toBe("acct-a")
      expect(error.routeKind).toBe("account")
      expect(error.routeAccountID).toBe("acct-b")
    }
  })

  test("rejects invalid legacy account IDs instead of fabricating a route", () => {
    const empty = left({ legacyAccountID: "" })
    expect(empty._tag).toBe("ProviderRouteIntent.InvalidLegacyAccount")

    const oversized = left({ legacyAccountID: "x".repeat(257) })
    expect(oversized._tag).toBe("ProviderRouteIntent.InvalidLegacyAccount")
  })

  test("never fabricates a magic public account identity", () => {
    const result = right({
      routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
    })
    expect(result).toEqual({ kind: "public" })
    expect("accountID" in result).toBe(false)
  })
})
