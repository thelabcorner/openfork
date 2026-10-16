import { describe, expect, test } from "bun:test"
import { isLiteralMarkdownParagraph, oversizedMarkdownProjection } from "./markdown-large-block"
import { MARKDOWN_RICH_BLOCK_MAX_BYTES } from "./markdown-stream"
import { MARKDOWN_WORKER_MAX_JOB_BYTES } from "./markdown-worker-admission"

describe("oversized Markdown source projection", () => {
  test("projects syntax-free oversized prose as its exact Markdown paragraph", () => {
    const source = "large prose ".repeat(MARKDOWN_RICH_BLOCK_MAX_BYTES / 2)
    const result = oversizedMarkdownProjection(source)
    expect(result?.text).toBe(source)
    expect(result?.blocks).toEqual([{ raw: source, src: source, mode: "full", plainParagraph: true }])
  })

  test("never labels Markdown syntax as a literal paragraph", () => {
    for (const source of ["**bold**", "# heading", "- item", "1. item", "a\n\nb", "[link](url)", "`code`", "https://example.com", "a &amp; b", "    code", "\tcode", "---", "$x$", "<b>html</b>"])
      expect(isLiteralMarkdownParagraph(source)).toBe(false)
    expect(isLiteralMarkdownParagraph("An ordinary paragraph with a hyphen-marker.")).toBe(true)
  })

  test("retains fenced code source, language, and blank lines", () => {
    const body = "first line\n\nsecond line\n".repeat(24_000)
    const source = `~~~JsOn\n${body}~~~`
    const result = oversizedMarkdownProjection(source)
    expect(result?.blocks).toHaveLength(1)
    expect(result?.blocks[0]?.mode).toBe("code")
    expect(result?.blocks[0]?.language).toBe("json")
    expect(result?.blocks[0]?.src).toBe(body)
  })

  test("leaves ordinary rich histories on the semantic worker path", () => {
    expect(oversizedMarkdownProjection("first block\n\nsecond block")).toBeUndefined()
  })

  test("fails closed for a multi-block source beyond worker input admission", () => {
    const source = `first block\n\n${"body ".repeat(MARKDOWN_WORKER_MAX_JOB_BYTES / 8)}`
    const result = oversizedMarkdownProjection(source)
    expect(result?.blocks).toEqual([{ raw: source, src: source, mode: "full" }])
  })
})
