import { describe, expect, test } from "bun:test"
import type { PromptInputV2Prompt } from "@opencode-ai/session-ui/v2/prompt-input/types"
import {
  promptRevisionClarifications,
  promptRevisionDraftContext,
  promptRevisionFingerprint,
  promptRevisionPrefix,
  promptRevisionRevealBoundaries,
  promptRevisionResponse,
  promptRevisionText,
  revisedPromptParts,
} from "./prompt-revision"

const question = (
  overrides: Partial<{
    question: string
    multiple: boolean
    custom: boolean
    options: { label: string; description: string }[]
  }> = {},
) => ({
  question: overrides.question ?? "Scope?",
  header: "Scope",
  options: overrides.options ?? [
    { label: "UI", description: "UI only" },
    { label: "Core", description: "Core only" },
  ],
  multiple: overrides.multiple,
  custom: overrides.custom,
})

describe("prompt revision helpers", () => {
  test("preserves structured mentions and image attachments after a rewrite", () => {
    const original: PromptInputV2Prompt = [
      { type: "text", content: "Fix ", start: 0, end: 4 },
      { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 4, end: 13 },
      { type: "text", content: " please", start: 13, end: 20 },
      { type: "image", id: "img", filename: "shot.png", mime: "image/png", blob: { id: "blob", url: "blob:test" } },
    ]

    const revised = revisedPromptParts("Please inspect @src/a.ts and fix the bug.", original)

    expect(revised).toEqual([
      { type: "text", content: "Please inspect ", start: 0, end: 15 },
      { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 15, end: 24 },
      { type: "text", content: " and fix the bug.", start: 24, end: 41 },
      original[3],
    ])
  })

  test("does not invent extra structured mentions when the model repeats a token", () => {
    const original: PromptInputV2Prompt = [{ type: "file", path: "src/a.ts", content: "@src/a.ts", start: 0, end: 9 }]

    const revised = revisedPromptParts("Compare @src/a.ts with @src/a.ts", original)
    expect(revised.filter((part) => part.type === "file")).toHaveLength(1)
    expect(
      revised
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join(""),
    ).toContain("@src/a.ts")
  })

  test("preserves duplicate mention metadata in original occurrence order", () => {
    const original: PromptInputV2Prompt = [
      {
        type: "file",
        path: "src/a.ts",
        content: "@src/a.ts",
        start: 0,
        end: 9,
        selection: { startLine: 1, startChar: 1, endLine: 2, endChar: 1 },
      },
      { type: "text", content: " ", start: 9, end: 10 },
      {
        type: "file",
        path: "src/a.ts",
        content: "@src/a.ts",
        start: 10,
        end: 19,
        selection: { startLine: 20, startChar: 1, endLine: 21, endChar: 1 },
      },
    ]

    const revised = revisedPromptParts("First @src/a.ts then @src/a.ts", original)
    const files = revised.filter((part) => part.type === "file")
    expect(files).toHaveLength(2)
    expect(files[0]?.selection?.startLine).toBe(1)
    expect(files[1]?.selection?.startLine).toBe(20)
  })

  test("serializes rich composer semantics without leaking client-only attachment internals", () => {
    const parts: PromptInputV2Prompt = [
      { type: "text", content: "Use ", start: 0, end: 4 },
      {
        type: "file",
        path: "src/a.ts",
        content: "@src/a.ts",
        start: 4,
        end: 13,
        selection: { startLine: 2, startChar: 1, endLine: 4, endChar: 8 },
      },
      { type: "agent", name: "explore", content: "@explore", start: 13, end: 21 },
      { type: "skill", name: "ui-review", content: "@ui-review", start: 21, end: 31 },
      {
        type: "file",
        path: "/references/design-system",
        content: "@design-system",
        start: 31,
        end: 45,
        mime: "application/x-directory",
        filename: "design-system",
      },
      {
        type: "file",
        path: "mcp://docs/component",
        content: "@Component docs",
        start: 45,
        end: 60,
        mime: "text/markdown",
        filename: "Component docs",
        url: "mcp://docs/component",
        source: {
          type: "resource",
          text: { value: "@Component docs", start: 45, end: 60 },
          clientName: "docs",
          uri: "mcp://docs/component",
        },
      },
      {
        type: "image",
        id: "img-1",
        filename: "screen.png",
        mime: "image/png",
        blob: { id: "opaque-blob", url: "blob:secret-client-url" },
      },
    ]

    expect(promptRevisionDraftContext(parts)).toEqual({
      mentions: [
        {
          id: "m1",
          type: "file",
          token: "@src/a.ts",
          path: "src/a.ts",
          selection: { startLine: 2, startChar: 1, endLine: 4, endChar: 8 },
        },
        { id: "m2", type: "agent", token: "@explore", name: "explore" },
        { id: "m3", type: "skill", token: "@ui-review", name: "ui-review" },
        {
          id: "m4",
          type: "reference",
          token: "@design-system",
          name: "design-system",
          path: "/references/design-system",
        },
        {
          id: "m5",
          type: "resource",
          token: "@Component docs",
          name: "Component docs",
          clientName: "docs",
          uri: "mcp://docs/component",
        },
      ],
      attachments: [{ id: "img-1", type: "image", filename: "screen.png", mime: "image/png" }],
    })
  })

  test("materializes Revisor-declared references as native Prompt Input V2 parts", () => {
    const original: PromptInputV2Prompt = [
      { type: "text", content: "old", start: 0, end: 3 },
      { type: "image", id: "img", filename: "shot.png", mime: "image/png", blob: { id: "blob", url: "blob:test" } },
    ]
    const text = "Inspect @src/new.ts with @ui-review and @Design docs."
    const revised = revisedPromptParts(text, original, [
      { type: "file", content: "@src/new.ts", start: 8, end: 19, path: "src/new.ts" },
      { type: "skill", content: "@ui-review", start: 25, end: 35, name: "ui-review" },
      {
        type: "resource",
        content: "@Design docs",
        start: 40,
        end: 52,
        name: "Design docs",
        clientName: "design",
        uri: "mcp://design/docs",
        mimeType: "text/markdown",
      },
    ])

    expect(revised.filter((part) => part.type === "file")).toEqual([
      { type: "file", path: "src/new.ts", content: "@src/new.ts", start: 8, end: 19 },
      {
        type: "file",
        path: "mcp://design/docs",
        content: "@Design docs",
        start: 40,
        end: 52,
        mime: "text/markdown",
        filename: "Design docs",
        url: "mcp://design/docs",
        source: {
          type: "resource",
          text: { value: "@Design docs", start: 40, end: 52 },
          clientName: "design",
          uri: "mcp://design/docs",
        },
      },
    ])
    expect(revised.find((part) => part.type === "skill")).toEqual({
      type: "skill",
      name: "ui-review",
      content: "@ui-review",
      start: 25,
      end: 35,
    })
    expect(revised.at(-1)).toBe(original[1])
  })

  test("keeps multi-select labels separate from independent details", () => {
    expect(promptRevisionResponse([question({ multiple: true })], [["UI", "Core"]], ["Server"])).toEqual({
      answers: [["UI", "Core"]],
      details: ["Server"],
    })
  })

  test("single-select keeps one provided option plus independent custom details", () => {
    expect(promptRevisionResponse([question()], [["UI", "Core"]], ["Something else"])).toEqual({
      answers: [["UI"]],
      details: ["Something else"],
    })
  })

  test("custom false ignores freeform text and keeps only provided choices", () => {
    expect(promptRevisionResponse([question({ custom: false })], [["UI"]], ["ignored"])).toEqual({
      answers: [["UI"]],
      details: [""],
    })
  })

  test("builds clarification payloads without conflating selected labels and details", () => {
    const response = { answers: [["UI"]], details: ["Keep deprecated aliases"] }
    const result = promptRevisionClarifications([question({ question: "Which?" })], response)
    response.answers[0]!.push("Core")
    expect(result).toEqual([{ question: "Which?", answers: ["UI"], detail: "Keep deprecated aliases" }])
  })

  test("fingerprint changes when prompt structure changes even if visible text does not", () => {
    const text: PromptInputV2Prompt = [{ type: "text", content: "@src/a.ts", start: 0, end: 9 }]
    const mention: PromptInputV2Prompt = [{ type: "file", path: "src/a.ts", content: "@src/a.ts", start: 0, end: 9 }]
    expect(promptRevisionFingerprint(text)).not.toBe(promptRevisionFingerprint(mention))
  })

  test("streams structured mentions atomically while preserving image attachments", () => {
    const image = {
      type: "image" as const,
      id: "img",
      filename: "shot.png",
      mime: "image/png",
      blob: { id: "blob", url: "blob:test" },
    }
    const parts: PromptInputV2Prompt = [
      { type: "text", content: "Inspect ", start: 0, end: 8 },
      { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 8, end: 17 },
      { type: "text", content: " carefully", start: 17, end: 27 },
      image,
    ]

    const insideMention = promptRevisionPrefix(parts, 12)
    expect(promptRevisionText(insideMention)).toBe("Inspect ")
    expect(insideMention.at(-1)).toBe(image)

    const completeMention = promptRevisionPrefix(parts, 17)
    expect(promptRevisionText(completeMention)).toBe("Inspect @src/a.ts")
    expect(completeMention.find((part) => part.type === "file")).toMatchObject({
      type: "file",
      path: "src/a.ts",
      content: "@src/a.ts",
      start: 8,
      end: 17,
    })
    expect(completeMention.at(-1)).toBe(image)
  })

  test("word reveal boundaries never split structured mentions and cap long animations", () => {
    const parts: PromptInputV2Prompt = [
      { type: "text", content: "Inspect ", start: 0, end: 8 },
      { type: "file", path: "folder/my file.ts", content: "@folder/my file.ts", start: 8, end: 26 },
      { type: "text", content: " then continue", start: 26, end: 40 },
    ]
    const boundaries = promptRevisionRevealBoundaries(parts)
    expect(boundaries.some((boundary) => boundary > 8 && boundary < 26)).toBe(false)
    expect(boundaries.at(-1)).toBe(40)

    const long: PromptInputV2Prompt = [
      {
        type: "text",
        content: Array.from({ length: 300 }, (_, index) => `word${index}`).join(" "),
        start: 0,
        end: Array.from({ length: 300 }, (_, index) => `word${index}`).join(" ").length,
      },
    ]
    expect(promptRevisionRevealBoundaries(long, 40).length).toBeLessThanOrEqual(41)
  })
})
