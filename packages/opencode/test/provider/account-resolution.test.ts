import { describe, expect, test } from "bun:test"
import { resolveProviderAccountSelector } from "@/provider/account-resolution"

describe("provider account selector resolution", () => {
  const accounts = [
    { id: "zen-111", label: "key1", aliases: ["primary@example.com"] },
    { id: "zen-222", label: "Migrated Key", aliases: ["secondary@example.com", "legacy-key2"] },
  ] as const

  test("stable internal ids are authoritative", () => {
    expect(resolveProviderAccountSelector("zen-222", accounts)).toEqual({
      kind: "resolved",
      accountID: "zen-222",
      matchedBy: "id",
    })
  })

  test("human labels resolve case-insensitively after Unicode/whitespace normalization", () => {
    expect(resolveProviderAccountSelector("  migrated key  ", accounts)).toEqual({
      kind: "resolved",
      accountID: "zen-222",
      matchedBy: "label",
    })
    expect(resolveProviderAccountSelector("MIGRATED KEY", accounts)).toEqual({
      kind: "resolved",
      accountID: "zen-222",
      matchedBy: "label",
    })
  })

  test("explicit provider aliases such as email or legacy names resolve to the stable id", () => {
    expect(resolveProviderAccountSelector("SECONDARY@EXAMPLE.COM", accounts)).toEqual({
      kind: "resolved",
      accountID: "zen-222",
      matchedBy: "alias",
    })
    expect(resolveProviderAccountSelector("legacy-key2", accounts)).toEqual({
      kind: "resolved",
      accountID: "zen-222",
      matchedBy: "alias",
    })
  })

  test("never fuzzy-matches a credential", () => {
    expect(resolveProviderAccountSelector("migrated", accounts)).toEqual({
      kind: "not-found",
      candidates: accounts,
    })
  })

  test("fails closed on duplicate human labels", () => {
    const duplicate = [
      { id: "wb-a", label: "work", aliases: ["same@example.com"] },
      { id: "wb-b", label: "WORK", aliases: ["other@example.com"] },
    ] as const
    expect(resolveProviderAccountSelector("work", duplicate)).toEqual({
      kind: "ambiguous",
      matches: duplicate,
    })
  })

  test("fails closed on duplicate aliases", () => {
    const duplicate = [
      { id: "vd-a", label: "Dana #1111", aliases: ["dana@example.com"] },
      { id: "vd-b", label: "Dana #2222", aliases: ["DANA@example.com"] },
    ] as const
    expect(resolveProviderAccountSelector("dana@example.com", duplicate)).toEqual({
      kind: "ambiguous",
      matches: duplicate,
    })
  })

  test("an exact stable id wins even when another account has the same text as a label", () => {
    const collision = [
      { id: "zen-stable", label: "first" },
      { id: "zen-other", label: "zen-stable" },
    ] as const
    expect(resolveProviderAccountSelector("zen-stable", collision)).toEqual({
      kind: "resolved",
      accountID: "zen-stable",
      matchedBy: "id",
    })
  })
})
