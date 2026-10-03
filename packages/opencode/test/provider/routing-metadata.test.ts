import { describe, expect, test } from "bun:test"
import { resolveRoutedAccount, routedAccountMismatch } from "@/provider/routing-metadata"

describe("resolveRoutedAccount", () => {
  test("uses explicit fallback when no routed account was observed", () => {
    expect(resolveRoutedAccount([], "zen-explicit")).toBe("zen-explicit")
  })

  test("uses the single authoritative routed account", () => {
    expect(resolveRoutedAccount(["zen-a"], "zen-explicit")).toBe("zen-a")
    expect(resolveRoutedAccount(["zen-a", "zen-a"])).toBe("zen-a")
  })

  test("fails closed when a turn spans multiple routed accounts", () => {
    expect(resolveRoutedAccount(["zen-a", "zen-b"], "zen-explicit")).toBeUndefined()
  })

  test("treats response account metadata as validation-only against committed Public", () => {
    expect(routedAccountMismatch([], { routeKind: "public" })).toBeUndefined()
    expect(routedAccountMismatch(["acct-b"], { routeKind: "public" })).toEqual({
      kind: "public-observed-account",
      observedAccountIDs: ["acct-b"],
    })
  })

  test("accepts only the exact committed account when response metadata is present", () => {
    expect(
      routedAccountMismatch(["acct-a"], {
        routeKind: "account",
        accountID: "acct-a",
      }),
    ).toBeUndefined()

    expect(
      routedAccountMismatch(["acct-b"], {
        routeKind: "account",
        accountID: "acct-a",
      }),
    ).toEqual({
      kind: "account-observed-different",
      expectedAccountID: "acct-a",
      observedAccountIDs: ["acct-b"],
    })

    expect(
      routedAccountMismatch(["acct-b", "acct-a", "acct-b"], {
        routeKind: "account",
        accountID: "acct-a",
      }),
    ).toEqual({
      kind: "account-observed-different",
      expectedAccountID: "acct-a",
      observedAccountIDs: ["acct-a", "acct-b"],
    })
  })
})
