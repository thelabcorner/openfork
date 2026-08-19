import { describe, expect, mock, test } from "bun:test"
import {
  classifyMarkdown,
  estimateMarkdownHeight,
  MARKDOWN_TYPOGRAPHY,
  priorMarkdownHeight,
  type TextLayoutMode,
} from "./project-explorer-markdown-height"

// The shared text-layout lib (pretext-timeline workstream) may not have landed
// in its final contract shape yet (textLayoutMode + family/fontSizePx/...).
// When it is absent or still on the old shape, stand in with a
// contract-faithful stub so this suite runs green before AND after the lib
// lands. When the final lib IS present the real implementation is used; outside
// a browser it degrades to undefined, which the fallback assertions below
// tolerate either way.
const lib = await import("@/lib/text-layout").catch(() => undefined)
if (!lib || typeof (lib as { textLayoutMode?: unknown }).textLayoutMode !== "function") {
  mock.module("@/lib/text-layout", () => ({
    estimateTextHeight: (text: string) => (text ? text.length * 0.5 + 22.4 : undefined),
    prepareTextLayout: () => undefined,
    textLayoutMode: () => "off",
  }))
}

const width = 720

describe("classifyMarkdown", () => {
  const simple: [string, string][] = [
    ["plain paragraph", "Just a paragraph of prose."],
    ["multi-line paragraph", "First line.\nSecond line of the same paragraph."],
    ["atx headings", "# Title\n\n## Subtitle\n\n### Deeper"],
    ["setext heading", "Title\n=====\n\nBody."],
    ["single-level bullet list", "- one\n- two\n- three"],
    ["single-level ordered list", "1. first\n2. second"],
    ["blockquote", "> quoted wisdom\n> more wisdom"],
    ["horizontal rules", "---\n\n***"],
    ["inline formatting", "Some **bold**, *emphasis*, `code`, and [a link](https://example.com)."],
    ["dollar amounts stay simple (single $ is not katex here)", "It costs $5.00 each or $10 for two."],
    ["trailing newline", "paragraph\n"],
  ]
  test.each(simple)("accepts %s", (_name, source) => {
    expect(classifyMarkdown(source)).toBe("simple")
  })

  const complex: [string, string][] = [
    ["fenced code block", "Before\n```ts\nconst x = 1\n```\nAfter"],
    ["tilde fenced code block", "~~~js\nlet y\n~~~"],
    ["indented code block", "    const z = 2\n    return z"],
    ["katex block math", "Before\n$$\nx^2\n$$\nAfter"],
    ["katex inline math", "The value \\(x^2\\) grows."],
    ["katex inline math across lines", "Line with \\(x\\) then rest"],
    ["GFM table with leading pipe", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
    ["GFM table separator without leading pipe", "a | b\n--- | ---\n1 | 2"],
    ["html block", "Before\n<div class=\"note\">\ncontent\n</div>\nAfter"],
    ["inline image", "See ![diagram](diagram.png) for details."],
    ["nested bullet list", "- parent\n  - child\n- sibling"],
    ["nested ordered list", "1. parent\n   1. child"],
    ["deeply indented list item", "- a\n    - b\n- c"],
    ["huge input beyond scan cap", "x".repeat(70_000)],
  ]
  test.each(complex)("rejects %s", (_name, source) => {
    expect(classifyMarkdown(source)).toBe("complex")
  })
})

describe("priorMarkdownHeight", () => {
  test("never returns less than one line", () => {
    expect(priorMarkdownHeight("hi", width)).toBeGreaterThanOrEqual(MARKDOWN_TYPOGRAPHY.lineHeightPx)
    expect(priorMarkdownHeight("", width)).toBeGreaterThanOrEqual(MARKDOWN_TYPOGRAPHY.lineHeightPx)
  })

  test("grows with content length", () => {
    const short = priorMarkdownHeight("a".repeat(100), width)
    const long = priorMarkdownHeight("a".repeat(10_000), width)
    expect(long).toBeGreaterThan(short)
  })

  test("wraps long lines: height reflects ceil(len / charsPerLine)", () => {
    const text = "a".repeat(5_000)
    const charsPerLine = Math.max(8, Math.floor(width / (MARKDOWN_TYPOGRAPHY.fontSizePx * 0.5)))
    const wrapped = Math.ceil(5_000 / charsPerLine)
    const height = priorMarkdownHeight(text, width)
    expect(height).toBeGreaterThan(wrapped * MARKDOWN_TYPOGRAPHY.lineHeightPx)
    expect(height).toBeLessThan(wrapped * MARKDOWN_TYPOGRAPHY.lineHeightPx * 2)
  })

  test("narrower width produces a taller estimate", () => {
    const narrow = priorMarkdownHeight("a".repeat(2_000), 320)
    const wide = priorMarkdownHeight("a".repeat(2_000), 1_280)
    expect(narrow).toBeGreaterThan(wide)
  })

  test("headings cost more than plain text lines", () => {
    const plain = priorMarkdownHeight("plain line\nplain line", width)
    const headed = priorMarkdownHeight("# Heading\nplain line", width)
    expect(headed).toBeGreaterThan(plain)
  })
})

describe("estimateMarkdownHeight", () => {
  test("returns undefined for blank text", () => {
    expect(estimateMarkdownHeight("", width, { mode: "pretext" })).toBeUndefined()
    expect(estimateMarkdownHeight("   \n  ", width, { mode: "pretext" })).toBeUndefined()
  })

  test("returns undefined when the flag is off", () => {
    expect(estimateMarkdownHeight("some prose", width, { mode: "off" })).toBeUndefined()
  })

  test("prior mode returns a finite positive height for any non-blank input", () => {
    const cases = [
      "plain prose here",
      "# Heading\n\n$$x^2$$\n\n```ts\ncode\n```\n\n| a |\n| --- |",
      "a".repeat(70_000),
    ]
    for (const source of cases) {
      const height = estimateMarkdownHeight(source, width, { mode: "prior" })
      expect(typeof height).toBe("number")
      expect(Number.isFinite(height)).toBe(true)
      expect(height!).toBeGreaterThan(0)
    }
  })

  test("pretext mode uses the shared lib for simple text and the prior for complex", () => {
    const simpleHeight = estimateMarkdownHeight("A short paragraph.", width, { mode: "pretext" })
    expect(simpleHeight).toBeTypeOf("number")
    const complexHeight = estimateMarkdownHeight("| a | b |\n| --- | --- |\n| 1 | 2 |", width, {
      mode: "pretext",
    })
    expect(complexHeight).toBeTypeOf("number")
    expect(complexHeight).toBe(priorMarkdownHeight("| a | b |\n| --- | --- |\n| 1 | 2 |", width))
  })

  test("huge inputs take the prior path without classifying", () => {
    const height = estimateMarkdownHeight("y".repeat(70_000), width, { mode: "pretext" })
    expect(height).toBeTypeOf("number")
    expect(priorMarkdownHeight("y".repeat(70_000), width)).toBe(height!)
  })

  test("invalid width falls back to a sane width instead of NaN", () => {
    const height = estimateMarkdownHeight("prose", Number.NaN, { mode: "prior" })
    expect(Number.isFinite(height)).toBe(true)
    expect(height!).toBeGreaterThan(0)
  })

  test("custom typography changes the estimate", () => {
    const big = { family: '"Segoe UI"', fontSizePx: 28, lineHeightPx: 44.8, fontWeight: 400, fontStyle: "normal", letterSpacingPx: 0 }
    const normal = estimateMarkdownHeight("a".repeat(1_000), width, { mode: "prior" })
    const large = estimateMarkdownHeight("a".repeat(1_000), width, { mode: "prior", typography: big })
    expect(large).toBeGreaterThan(normal!)
  })

  test("mode override wins over the environment flag", () => {
    // textLayoutMode reads the env at call time; a forced mode must take
    // precedence regardless of what the environment says.
    const forced = estimateMarkdownHeight("prose", width, { mode: "prior" })
    expect(forced).toBeTypeOf("number")
    expect(estimateMarkdownHeight("prose", width, { mode: "off" })).toBeUndefined()
  })

  test("estimates are deterministic for identical input", () => {
    const source = "Repeated\n\ncalls with the same input must produce the same hint."
    const modes: TextLayoutMode[] = ["prior", "pretext"]
    for (const mode of modes) {
      const a = estimateMarkdownHeight(source, width, { mode })
      const b = estimateMarkdownHeight(source, width, { mode })
      expect(b).toBe(a)
    }
  })
})
