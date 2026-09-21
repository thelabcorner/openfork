import { expect, test } from "bun:test"
import * as Utf8 from "../../src/util/utf8"

test("UTF-8 truncation is byte-exact and never splits a code point", () => {
  const value = "A🙂你好é🚀Z"
  expect(Utf8.byteLength(value)).toBe(Buffer.byteLength(value, "utf8"))

  for (let budget = 0; budget <= Buffer.byteLength(value, "utf8"); budget++) {
    const result = Utf8.truncate(value, budget)
    expect(Buffer.byteLength(result.text, "utf8")).toBe(result.bytes)
    expect(result.bytes).toBeLessThanOrEqual(budget)
    expect(new TextDecoder().decode(new TextEncoder().encode(result.text))).toBe(result.text)
    expect(value.startsWith(result.text)).toBe(true)
  }
})

test("UTF-8 truncation reports exact-fit and overflow semantics", () => {
  const value = "hello-🙂"
  const bytes = Buffer.byteLength(value, "utf8")
  expect(Utf8.truncate(value, bytes)).toEqual({ text: value, bytes, truncated: false })
  const cut = Utf8.truncate(value, bytes - 1)
  expect(cut.truncated).toBe(true)
  expect(cut.text).toBe("hello-")
})

test("UTF-8 byte windows return exact continuation offsets and never split code points", () => {
  const value = "A🙂你好é🚀Z"
  const first = Utf8.window(value, 0, 5)
  expect(first.text).toBe("A🙂")
  expect(first.nextOffset).toBe(5)

  const second = Utf8.window(value, first.nextOffset, 6)
  expect(second.text).toBe("你好")
  expect(second.offset).toBe(first.nextOffset)
  expect(Buffer.byteLength(second.text, "utf8")).toBe(6)

  const middle = Utf8.window(value, 2, 20)
  expect(middle.offset).toBe(5)
  expect(middle.text.startsWith("你")).toBe(true)
  expect(new TextDecoder().decode(new TextEncoder().encode(middle.text))).toBe(middle.text)
})

