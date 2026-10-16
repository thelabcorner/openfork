import { describe, expect, test } from "bun:test"
import { commonCodeTokenPrefix } from "./markdown-code-token-reuse"
type Token = [string, string]
const token = (text: string, style = "color:blue"): Token => [text, style]

describe("Shiki completion token DOM retention", () => {
  test("keeps every unchanged span when full tokenization matches the stream", () => {
    const prefix: Token[] = [token("const"), token(" "), token("x")]
    const unstable: Token[] = [token(" = "), token("1", "color:red")]
    const completed: Token[] = [...prefix, ...unstable]
    expect(commonCodeTokenPrefix(prefix, unstable, completed, [])).toBe(completed.length)
  })
  test("retains the stable prefix when the terminal grammar is retokenized", () => {
    const stable: Token[] = [token("const"), token(" "), token("x")]
    const unstable: Token[] = [token(" = 1", "color:red")]
    const completed: Token[] = [token("const"), token(" "), token("x"), token(" = "), token("1", "color:red")]
    expect(commonCodeTokenPrefix(stable, unstable, completed, [])).toBe(3)
  })
  test("changed colors prevent stale styles even when text matches", () => {
    expect(commonCodeTokenPrefix([token("const")], [token(" x", "color:blue")], [token("const"), token(" x", "color:green")], [])).toBe(1)
  })
  test("does not reuse stale characters after source replacement or truncation", () => {
    expect(commonCodeTokenPrefix([token("old")], [], [token("new")], [])).toBe(0)
    expect(commonCodeTokenPrefix([token("one"), token("two")], [], [token("one")], [])).toBe(1)
  })
  test("empty streams and completed outputs return zero without allocating", () => {
    expect(commonCodeTokenPrefix([], [], [], [])).toBe(0)
    expect(commonCodeTokenPrefix([], [], [token("x")], [])).toBe(0)
  })
})
