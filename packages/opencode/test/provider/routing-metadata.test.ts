import { describe, expect, test } from "bun:test"
import { resolveRoutedAccount } from "@/provider/routing-metadata"

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
})
