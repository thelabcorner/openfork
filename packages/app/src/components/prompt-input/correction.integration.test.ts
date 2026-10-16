import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { snapshotPrompt } from "@/context/prompt-snapshot"
import { correctPromptParts } from "./correction"
import { buildRequestParts } from "./build-request-parts"

describe("prompt normalization -> request/optimistic transport consistency", () => {
  test("captured draft and file-selection metadata cannot change during async setup", () => {
    const intro = "contienu "
    const mention = "@file.ts"
    const prompt: Prompt = [
      { type: "text", content: intro, start: 0, end: intro.length },
      { type: "file", path: "file.ts", content: mention, start: intro.length,
        end: intro.length + mention.length,
        selection: { startLine: 1, endLine: 3, startChar: 0, endChar: 10 },
      },
    ]
    const frozen = snapshotPrompt(prompt)
    const output = correctPromptParts(frozen)
    if (prompt[0]?.type === "text") prompt[0].content = "changed while waiting"
    if (prompt[1]?.type === "file") {
      prompt[1].path = "rebound.ts"
      prompt[1].selection!.startLine = 100
    }
    expect(output.original[0]).toMatchObject({ type: "text", content: "contienu " })
    expect(output.effective[0]).toMatchObject({ type: "text", content: "continue " })
    expect(output.effective[1]).toMatchObject({
      type: "file", path: "file.ts", content: mention,
      selection: { startLine: 1, endLine: 3, startChar: 0, endChar: 10 },
      start: "continue ".length, end: "continue @file.ts".length,
    })
  })

  test("the exact effective text and shifted mention offsets reach the send builder", () => {
    const prefix = "Contienu the reasearch with "
    const token = "@file.ts"
    const suffix = " and optimzation."
    const prompt: Prompt = [
      { type: "text", content: prefix, start: 0, end: prefix.length },
      { type: "file", content: token, start: prefix.length, end: prefix.length + token.length, path: "file.ts",
        source: {
          type: "file", path: "file.ts",
          text: { value: token, start: prefix.length, end: prefix.length + token.length },
        },
      },
      { type: "text", content: suffix, start: prefix.length + token.length, end: prefix.length + token.length + suffix.length },
    ]
    const correction = correctPromptParts(prompt)
    expect(correction.status).toBe("corrected")
    const correctedMention = correction.effective[1]
    if (!correctedMention || correctedMention.type !== "file") throw new Error("expected file reference")
    expect(correctedMention.source?.text).toMatchObject({
      value: token,
      start: "Continue the research with ".length,
      end: "Continue the research with @file.ts".length,
    })
    expect(prompt[1]).toMatchObject({
      source: { text: { value: token, start: prefix.length, end: prefix.length + token.length } },
    })
    const effectiveText = correction.effective.map((part) => ("content" in part ? part.content : "")).join("")
    const { requestParts, optimisticParts } = buildRequestParts({
      prompt: correction.effective,
      context: [],
      images: [],
      text: effectiveText,
      sessionID: "ses_test",
      messageID: "msg_test",
      sessionDirectory: "C:/projects/test",
    })
    expect(effectiveText).toBe("Continue the research with @file.ts and optimization.")
    expect(requestParts.find((part) => part.type === "text")).toMatchObject({ type: "text", text: effectiveText })
    expect(optimisticParts.find((part) => part.type === "text")).toMatchObject({ type: "text", text: effectiveText })
    const file = requestParts.find((part) => part.type === "file")
    expect(file?.type).toBe("file")
    if (!file || file.type !== "file") throw new Error("expected file")
    expect(file.source?.text).toMatchObject({
      value: token,
      start: "Continue the research with ".length,
      end: "Continue the research with @file.ts".length,
    })
    expect(correction.original).toBe(prompt)
    expect(prompt[0]).toMatchObject({ content: prefix, start: 0, end: prefix.length })
  })

  test("selective correction shifts structured-reference offsets without altering rejected text", () => {
    const opening = "contienu "
    const mention = "@agent"
    const ending = " reasearch"
    const draft: Prompt = [
      { type: "text", content: opening, start: 0, end: opening.length },
      { type: "agent", name: "agent", content: mention, start: opening.length, end: opening.length + mention.length },
      { type: "text", content: ending, start: opening.length + mention.length,
        end: opening.length + mention.length + ending.length },
    ]
    const preview = correctPromptParts(draft)
    expect(preview.patches).toHaveLength(2)
    const first = preview.patches[0]
    if (!first) throw new Error("missing first patch")
    const selected = correctPromptParts(draft, true, { selectedPatchStarts: new Set([first.start]) })
    expect(selected.patches).toHaveLength(1)
    expect(selected.effective[0]).toMatchObject({ content: "continue " })
    expect(selected.effective[1]).toMatchObject({
      type: "agent", content: mention, start: "continue ".length, end: "continue @agent".length,
    })
    expect(selected.effective[2]).toMatchObject({
      content: ending, start: "continue @agent".length, end: "continue @agent reasearch".length,
    })
    expect(draft[1]).toMatchObject({ start: opening.length })
  })

  test("frozen image descriptor remains immutable across editor changes during submission", () => {
    const typed = "contienu the reasearch"
    const original: Prompt = [
      { type: "text", content: typed, start: 0, end: typed.length },
      { type: "image", id: "image-1", filename: "original.png", sourcePath: "original.png",
        mime: "image/png", blob: { id: "blob-original", url: "blob:original" } },
    ]
    const captured = snapshotPrompt(original)
    const corrected = correctPromptParts(captured)
    const draftImages = corrected.effective.filter((part) => part.type === "image")
    expect(draftImages).toHaveLength(1)
    expect(draftImages[0]).toMatchObject({
      id: "image-1", filename: "original.png", mime: "image/png",
      blob: { id: "blob-original", url: "blob:original" },
    })
    if (original[1]?.type !== "image") throw new Error("expected source image")
    original[1].filename = "replacement.png"
    original[1].mime = "image/jpeg"
    original[1].blob.id = "blob-replacement"
    original[1].blob.url = "blob:replacement"
    original.pop()
    expect(corrected.effective[0]).toMatchObject({ content: "continue the research" })
    expect(draftImages[0]).toMatchObject({
      filename: "original.png", mime: "image/png",
      blob: { id: "blob-original", url: "blob:original" },
    })
    expect(captured[1]).not.toBe(original[1])
  })

  test("unrecognized structured parts and images are preserved", () => {
    const text = "contienu "
    const token = "@tool"
    const data: Prompt = [
      { type: "text", content: text, start: 0, end: text.length },
      { type: "tool", content: token, start: text.length, end: text.length + token.length, name: "tool" },
      { type: "image", id: "asset", filename: "a.png", mime: "image/png", blob: { id: "b", url: "blob:x" } },
    ]
    const r = correctPromptParts(data)
    expect(r.effective[1]).toMatchObject({ type: "tool", content: "@tool", name: "tool" })
    expect(r.effective[2]).toBe(data[2])
  })
})
