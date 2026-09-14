import { expect, test } from "bun:test"
import { hasTextPrefix } from "./text-prefix"

test("recognizes exact append-only text without accepting replacements", () => {
  expect(hasTextPrefix("hello world", "hello")).toBe(true)
  expect(hasTextPrefix("hello", "hello")).toBe(true)
  expect(hasTextPrefix("hello", "hello world")).toBe(false)
  expect(hasTextPrefix("hallo world", "hello")).toBe(false)
  expect(hasTextPrefix("hello worle", "hello world")).toBe(false)
})
