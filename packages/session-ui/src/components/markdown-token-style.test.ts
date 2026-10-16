import { expect, test } from "bun:test"
import { getTokenStyleObject, stringifyTokenStyle, type ThemedToken } from "shiki"
import { createTokenStyleSerializer } from "./markdown-token-style"

test("cached styles match Shiki for foreground, background and all font flags", () => {
  const serialize = createTokenStyleSerializer(8)
  for (const color of [undefined, "#abcd12", "var(--code-color)"]) {
    for (const background of [undefined, "#13579b"]) {
      for (const flags of [0, 1, 2, 3, 4, 8, 12, 15]) {
        const token = { content: "text", offset: 0, color, bgColor: background, fontStyle: flags } as ThemedToken
        const original = stringifyTokenStyle(getTokenStyleObject(token))
        expect(serialize(token)).toBe(original)
        expect(serialize(token)).toBe(original)
      }
    }
  }
})

test("explicit htmlStyle takes precedence, even with a reused color and a full cache", () => {
  const serialize = createTokenStyleSerializer(1)
  const a = { content: "x", offset: 0, color: "#f00" } as ThemedToken
  const b = { content: "y", offset: 0, color: "#0f0" } as ThemedToken
  expect(serialize(a)).toBe(stringifyTokenStyle(getTokenStyleObject(a)))
  expect(serialize(b)).toBe(stringifyTokenStyle(getTokenStyleObject(b)))
  const styled = { ...a, htmlStyle: { color: "#000", "font-weight": "bold" } } as ThemedToken
  expect(serialize(styled)).toBe(stringifyTokenStyle(styled.htmlStyle!))
})
