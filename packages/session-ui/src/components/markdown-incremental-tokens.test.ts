import { describe, expect, test } from "bun:test"
import { createMarkdownParser } from "@opencode-ai/ui/context/marked-parser"
import { appendPlainMarkdownTokens } from "./markdown-incremental-tokens"

const parser = createMarkdownParser((code, language) => `<pre data-language="${language}">${code}</pre>`)

async function incremental(base: string, suffix: string) {
  const tokens = parser.lexer(base)
  const accepted = appendPlainMarkdownTokens(tokens, suffix)
  return {
    accepted,
    incremental: accepted ? await parser.parser(tokens) : undefined,
    full: await parser.parse(base + suffix),
  }
}

describe("incremental markdown tokens", () => {
  test.each([
    ["plain paragraph", "plain text", " continues, safely."],
    ["closed emphasis", "**bold**", " ordinary tail."],
    ["closed inline code", "`file.ts`", " exists here."],
    ["heading", "## Heading", " continued"],
    ["blockquote", "> quoted text", " continues"],
    ["unordered list", "- one\n- two", " continues"],
    ["ordered list", "1. one\n2. two", " continues"],
    ["nested list", "- parent\n  - child", " continues"],
    ["task list", "- [ ] todo", " continues"],
    ["loose list", "- first\n\n- second", " continues"],
    ["explicit link", "[docs](https://example.com)", " are useful"],
  ])("matches a full parse for %s", async (_name, base, suffix) => {
    const result = await incremental(base, suffix)
    // Explicit links intentionally take the conservative fallback because GFM
    // autolinks share the same token type.
    if (_name === "explicit link") {
      expect(result.accepted).toBe(false)
      return
    }
    expect(result.accepted).toBe(true)
    expect(result.incremental).toBe(result.full)
  })

  test.each([
    ["newline", "plain", "\nnext"],
    ["emphasis delimiter", "plain", " **bold**"],
    ["inline code", "plain", " `code`"],
    ["HTML/entity", "entity &amp", ";"],
    ["email autolink", "mail foo@bar", ".com"],
    ["www autolink", "visit www", ".example.com"],
    ["protocol autolink", "http", "://example.com"],
    ["table", "| a | b |\n|---|---|\n| 1 | 2 |", " more"],
    ["raw html", "<span>value</span>", " tail"],
    ["code block", "```ts\nconst x = 1\n```", " tail"],
  ])("falls back for %s", async (_name, base, suffix) => {
    const result = await incremental(base, suffix)
    expect(result.accepted).toBe(false)
  })

  test("stays equivalent across a long sequence of accepted appends", async () => {
    let text = "- first item\n- second item"
    const tokens = parser.lexer(text)
    for (const suffix of [" grows", " with", " many", " ordinary", " words", "."]) {
      expect(appendPlainMarkdownTokens(tokens, suffix, text)).toBe(true)
      text += suffix
      expect(await parser.parser(tokens)).toBe(await parser.parse(text))
    }
  })

  test("differential-fuzzes accepted appends against a fresh configured lexer", async () => {
    const bases = [
      "plain prose",
      "## Heading",
      "> quoted prose",
      "- first\n- second",
      "1. first\n2. second",
      "- parent\n  - child",
      "- [x] completed task",
      "**closed emphasis** tail",
      "`closed-code` tail",
    ]
    const alphabet = " abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?;='\"+-=%^"
    let seed = 0x51f15e
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 0x100000000
    }

    for (const base of bases) {
      let text = base
      let tokens = parser.lexer(text)
      for (let step = 0; step < 120; step++) {
        const length = 1 + Math.floor(random() * 12)
        let suffix = ""
        for (let index = 0; index < length; index++) suffix += alphabet[Math.floor(random() * alphabet.length)]!
        const accepted = appendPlainMarkdownTokens(tokens, suffix, text)
        text += suffix
        if (!accepted) {
          tokens = parser.lexer(text)
          continue
        }
        expect(await parser.parser(tokens)).toBe(await parser.parse(text))
      }
    }
  })
})
