import { describe, expect, test } from "bun:test"
import { MAX_TITLE_BYTES, OxpSessionTitle } from "@/oxp/session-title"

describe("OxpSessionTitle.normalizeSessionTitle", () => {
  test("accepts a plain human title", () => {
    expect(OxpSessionTitle.normalizeSessionTitle("Design GitHub Tool")).toEqual({
      ok: true,
      title: "Design GitHub Tool",
    })
  })

  test("trims surrounding whitespace", () => {
    expect(OxpSessionTitle.normalizeSessionTitle("  OXP Session Isolation  ")).toEqual({
      ok: true,
      title: "OXP Session Isolation",
    })
  })

  test("rejects blank and whitespace-only titles", () => {
    expect(OxpSessionTitle.normalizeSessionTitle("")).toEqual({ ok: false, reason: "blank" })
    expect(OxpSessionTitle.normalizeSessionTitle("   \t\n  ")).toEqual({ ok: false, reason: "blank" })
  })

  test("rejects non-strings as blank", () => {
    expect(OxpSessionTitle.normalizeSessionTitle(undefined)).toEqual({ ok: false, reason: "blank" })
    expect(OxpSessionTitle.normalizeSessionTitle(42)).toEqual({ ok: false, reason: "blank" })
    expect(OxpSessionTitle.normalizeSessionTitle(null)).toEqual({ ok: false, reason: "blank" })
  })

  test("strips newline and control-character injection", () => {
    expect(OxpSessionTitle.normalizeSessionTitle("Design\nGitHub\tTool\r\n")).toEqual({
      ok: true,
      title: "DesignGitHubTool",
    })
    expect(OxpSessionTitle.normalizeSessionTitle("abcd")).toEqual({ ok: true, title: "abcd" })
  })

  test("a title of only control characters becomes blank", () => {
    expect(OxpSessionTitle.normalizeSessionTitle("\n\t\r")).toEqual({ ok: false, reason: "blank" })
  })

  test("preserves Unicode and emoji without slugifying", () => {
    expect(OxpSessionTitle.normalizeSessionTitle("GitHub Tool — CLI/API Architecture 🚀")).toEqual({
      ok: true,
      title: "GitHub Tool — CLI/API Architecture 🚀",
    })
    expect(OxpSessionTitle.normalizeSessionTitle("日本語のタイトル")).toEqual({ ok: true, title: "日本語のタイトル" })
  })

  test("accepts titles at the byte bound and rejects longer", () => {
    const exact = "a".repeat(MAX_TITLE_BYTES)
    expect(OxpSessionTitle.normalizeSessionTitle(exact)).toEqual({ ok: true, title: exact })
    const longer = "a".repeat(MAX_TITLE_BYTES + 1)
    expect(OxpSessionTitle.normalizeSessionTitle(longer)).toEqual({ ok: false, reason: "too_long" })
  })

  test("byte bound applies to UTF-8 so one emoji counts as four bytes", () => {
    const emojis = "🚀".repeat(64) // 256 bytes
    expect(OxpSessionTitle.normalizeSessionTitle(emojis)).toEqual({ ok: true, title: emojis })
    expect(OxpSessionTitle.normalizeSessionTitle(emojis + "🚀")).toEqual({ ok: false, reason: "too_long" })
  })
})
