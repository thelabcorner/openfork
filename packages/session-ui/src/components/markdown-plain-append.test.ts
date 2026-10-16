import { describe, expect, test } from "bun:test"
import { provenPlainParagraphSuffix } from "./markdown-plain-append"

const block = (key: string, value: string, mode = "live", html = `<p>${value}</p>\n`) => ({
  key, mode, raw: value, src: value, html,
})

describe("proof-gated live paragraph DOM append", () => {
  test("identifies simple exact append without a DOM/parser rebuild", () => {
    expect(provenPlainParagraphSuffix(block("a", "Hello"), block("a", "Hello world"))).toBe(" world")
  })
  test("rejects replacements, incorrect keys, finalization, and structure changes", () => {
    const before = block("a", "Hello")
    expect(provenPlainParagraphSuffix(before, block("b", "Hello world"))).toBeUndefined()
    expect(provenPlainParagraphSuffix(before, block("a", "Goodbye"))).toBeUndefined()
    expect(provenPlainParagraphSuffix(before, block("a", "Hello", "full"))).toBeUndefined()
    expect(provenPlainParagraphSuffix(before, block("a", "Hello *world*", "live", "<p>Hello <em>world</em></p>\n"))).toBeUndefined()
  })
  test("rejects unsafe HTML transformations and new Markdown block boundaries", () => {
    const before = block("a", "Hello")
    expect(provenPlainParagraphSuffix(before, block("a", "Hello & me", "live", "<p>Hello &amp; me</p>\n"))).toBeUndefined()
    expect(provenPlainParagraphSuffix(before, block("a", "Hello\nnew"))).toBeUndefined()
    expect(provenPlainParagraphSuffix(before, block("a", "Hello\r\nnew"))).toBeUndefined()
    expect(provenPlainParagraphSuffix(block("a", "Hello", "live", "<p><strong>Hello</strong></p>\n"), block("a", "Hello world"))).toBeUndefined()
  })
  test("requires exact source/HTML parity (never appends a healing placeholder)", () => {
    const before = { ...block("a", "Hello"), src: "Hello\u200b" }
    expect(provenPlainParagraphSuffix(before, block("a", "Hello world"))).toBeUndefined()
    expect(provenPlainParagraphSuffix(block("a", "Hello"), { ...block("a", "Hello world"), raw: "Hello world!" })).toBeUndefined()
  })
})
