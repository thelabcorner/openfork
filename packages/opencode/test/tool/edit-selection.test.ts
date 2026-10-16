import { describe, expect, test } from "bun:test"
import { resolveReplacement } from "../../src/tool/edit/match"
import { applySpans } from "../../src/tool/edit/span"
import { replaceConflictHint } from "../../src/tool/conflict"

const change = (
  source: string,
  needle: string,
  replacement: string,
  selection?: { mode: "one"; atLine: number } | { mode: "selected"; atLines: readonly number[] } | { mode: "all"; expectedMatches?: number },
) => applySpans(source, resolveReplacement(source, needle, replacement, false, selection).spans)

describe("AX exact edit selection", () => {
  test("legacy unique matches remain a zero-configuration fast path", () => {
    expect(change("a\nb\nc\n", "b", "B")).toBe("a\nB\nc\n")
  })

  test("legacy ambiguous edit still refuses rather than picking a line", () => {
    expect(() => change("x\na\na\nz\n", "a", "A")).toThrow(/multiple matches/i)
  })

  test("line selection disambiguates repeated identical code without replacing peers", () => {
    const source = "function a() {\n  const value = 1\n}\nfunction b() {\n  const value = 1\n}\n"
    expect(change(source, "  const value = 1", "  const value = 2", { mode: "one", atLine: 5 })).toBe(
      "function a() {\n  const value = 1\n}\nfunction b() {\n  const value = 2\n}\n",
    )
  })

  test("selected source lines replace an exact subset atomically in one plan", () => {
    const source = "head\nvalue\nignore\nvalue\nignore\nvalue\n"
    expect(change(source, "value", "new", { mode: "selected", atLines: [6, 2] })).toBe(
      "head\nnew\nignore\nvalue\nignore\nnew\n",
    )
  })

  test("a single missing selected line aborts the whole subset without a partial plan", () => {
    const source = "value\nignore\nvalue\n"
    expect(() => change(source, "value", "new", { mode: "selected", atLines: [1, 2] })).toThrow(/line 2/)
  })

  test("selected line arrays reject duplicates and empty selections", () => {
    expect(() => change("value\n", "value", "new", { mode: "selected", atLines: [1, 1] })).toThrow(/distinct/)
    expect(() => change("value\n", "value", "new", { mode: "selected", atLines: [] })).toThrow(/distinct/)
  })

  test("line selection fails closed when its verified location moves", () => {
    const source = "a\nx\nb\nx\n"
    expect(() => change(source, "x", "y", { mode: "one", atLine: 3 })).toThrow(/line 3/)
    expect(() => change(source, "x", "y", { mode: "one", atLine: 8 })).toThrow(/line 8/)
  })

  test("line selection refuses two identical matches on one line", () => {
    expect(() => change("xx\n", "x", "y", { mode: "one", atLine: 1 })).toThrow(/2 exact candidate/)
  })

  test("line selection is exact-only; no fuzzy fallback is permitted", () => {
    expect(() => change("  target  \n", "target\n", "changed\n", { mode: "one", atLine: 1 })).toThrow(/none|0 exact/i)
  })

  test("invalid source-line numbers are refused", () => {
    expect(() => change("x\n", "x", "y", { mode: "one", atLine: 0 })).toThrow(/positive safe integer/)
    expect(() => change("x\n", "x", "y", { mode: "one", atLine: 1.5 })).toThrow(/positive safe integer/)
  })

  test("all-occurrences selector enforces the expected count", () => {
    const content = "value\nvalue\nvalue\n"
    expect(() => change(content, "value", "updated", { mode: "all", expectedMatches: 2 })).toThrow(
      /expected 2 exact matches but found 3/,
    )
    expect(change(content, "value", "updated", { mode: "all", expectedMatches: 3 })).toBe(
      "updated\nupdated\nupdated\n",
    )
  })

  test("all-occurrences selection without count retains deliberate all semantics", () => {
    expect(change("a\na\n", "a", "b", { mode: "all" })).toBe("b\nb\n")
  })

  test("selection one cannot override replaceAll legacy intent", () => {
    expect(() =>
      resolveReplacement("x\nx", "x", "y", true, { mode: "one", atLine: 2 }),
    ).toThrow(/cannot be combined/)
  })

  test("logical CRLF matching uses source coordinates and preserves terminators", () => {
    expect(change("x\r\ny\r\nx\r\n", "x", "z", { mode: "one", atLine: 3 })).toBe("x\r\ny\r\nz\r\n")
  })

  test("ambiguous error includes distinguishing context for both candidates", () => {
    const source = "const beforeA = true\ntarget\nconst afterA = true\nconst beforeB = true\ntarget\nconst afterB = true\n"
    const hint = replaceConflictHint({ content: source, needle: "target" }) ?? ""
    expect(hint).toContain("beforeA")
    expect(hint).toContain("beforeB")
    expect(hint).toContain("afterA")
    expect(hint).toContain("afterB")
  })
})
