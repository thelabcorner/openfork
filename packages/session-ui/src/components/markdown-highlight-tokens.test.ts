import { expect, test } from "bun:test"
import type { ThemedToken } from "shiki"
import { convertHighlightTokens, flattenHighlightLines } from "./markdown-highlight-tokens"

const plain = (content: string) => ({ content, offset: 0 }) as ThemedToken
const convert = (token: ThemedToken): [string, string] => [token.content, ""]

test("full token conversion keeps exact line breaks including blank intermediate lines", () => {
  expect(flattenHighlightLines([[plain("a")], [], [plain("b"), plain("c")]], convert)).toEqual([
    ["a", ""], ["\n", ""], ["\n", ""], ["b", ""], ["c", ""],
  ])
  expect(flattenHighlightLines([], convert)).toEqual([])
  expect(flattenHighlightLines([[plain("")]], convert)).toEqual([["", ""]])
})

test("streaming conversion drops empty chunks but never changes order or text", () => {
  expect(convertHighlightTokens([plain("a"), plain(""), plain("b"), plain("\n")], convert)).toEqual([
    ["a", ""], ["b", ""], ["\n", ""],
  ])
})

test("complete highlighting preserves mixed CRLF and LF source verbatim", () => {
  const source = "const a = 1;\r\n\r\nconst b = '🍒';\nconst c = 3;\r\n"
  const lines = [
    [plain("const a = 1;")],
    [],
    [plain("const b = '🍒';")],
    [plain("const c = 3;")],
    [],
  ]
  expect(flattenHighlightLines(lines, convert, source).map((token) => token[0]).join("")).toBe(source)
})
