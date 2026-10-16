import { describe, expect, test } from "bun:test"
import { isMarkdownPresentationReady } from "./markdown-presentation"

test("producer-proven presentation never inspects historical blocks on a streaming update", () => {
  const rendered = {
    text: "rich prefix", presentable: true,
    get blocks(): never { throw new Error("historical block scan") },
  }
  expect(isMarkdownPresentationReady(rendered, { text: "rich prefix plus live suffix" })).toBe(true)
  expect(isMarkdownPresentationReady(rendered, { text: "replacement" })).toBe(false)
  expect(isMarkdownPresentationReady({ text: rendered.text, presentable: false }, { text: "rich prefix" })).toBe(false)
})

describe("Markdown presentation readiness", () => {
  test("waits for a Markdown projection before publishing content", () => {
    expect(isMarkdownPresentationReady(undefined, undefined)).toBe(false)
    expect(isMarkdownPresentationReady({ text: "# title" }, undefined)).toBe(false)
  })

  test("retains the last rich render while the newer projection is pending", () => {
    expect(isMarkdownPresentationReady({ text: "# old" }, { text: "# new" })).toBe(false)
  })

  test("publishes completed rich prefixes during sustained streaming", () => {
    const result = { text: "## heading", blocks: [{ html: "<h2>heading</h2>" }] }
    expect(isMarkdownPresentationReady(result, { text: "## heading\n\nmore content" })).toBe(true)
  })

  test("rejects partial batch results and blank initial results", () => {
    expect(isMarkdownPresentationReady({ text: "source", complete: false }, { text: "source" })).toBe(false)
    expect(isMarkdownPresentationReady({ text: "" }, { text: "source" })).toBe(false)
  })

  test("admits producer-proven rich batches while later blocks are pending", () => {
    const result = { text: "# title\n\n**later**", complete: false, presentable: true, progressive: true, blocks: [{ html: "<h1>title</h1>" }] }
    expect(isMarkdownPresentationReady(result, { text: result.text })).toBe(true)
    expect(isMarkdownPresentationReady(result, { text: "replacement" })).toBe(false)
    expect(isMarkdownPresentationReady(result, { text: "# title" })).toBe(false)
    expect(isMarkdownPresentationReady({ ...result, blocks: [] }, { text: result.text })).toBe(false)
    expect(isMarkdownPresentationReady({ ...result, presentable: false }, { text: result.text })).toBe(false)
    expect(isMarkdownPresentationReady({ ...result, progressive: false }, { text: result.text })).toBe(false)
  })

  test("publishes the sanitized render matching the worker projection", () => {
    const result = { text: "## heading", blocks: [{ html: "<h2>heading</h2>" }] }
    expect(isMarkdownPresentationReady(result, { text: "## heading" })).toBe(true)
  })

  test("does not publish a raw-text fallback that can later turn into Markdown", () => {
    const fallback = { text: "**bold**", blocks: [{ mode: "live", plainText: "**bold**" }] }
    expect(isMarkdownPresentationReady(fallback, { text: "**bold**" })).toBe(false)
  })

  test("keeps intentional code fallbacks presentable", () => {
    const code = { text: "```ts\nconst x = 1\n```", blocks: [{ mode: "full", plainText: "const x = 1", plainCode: true }] }
    expect(isMarkdownPresentationReady(code, { text: code.text })).toBe(true)
  })
})
