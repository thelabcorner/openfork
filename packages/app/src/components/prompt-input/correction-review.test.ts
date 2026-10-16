import { describe, expect, test } from "bun:test"
import { promptCorrectionReviewFingerprint, type PromptCorrectionReviewScope } from "./correction-review"

function scope(): PromptCorrectionReviewScope {
  const content = "contienu the reasearch"
  return {
    prompt: [
      { type: "text", content, start: 0, end: content.length },
      { type: "image", id: "image-a", filename: "original.png", mime: "image/png",
        blob: { id: "blob-a", url: "blob:original" } },
    ],
    context: [{ key: "comment-a", type: "file", path: "src/code.ts", comment: "Preserve the source" }],
    sessionID: "ses_1",
    directory: "C:/Projects/Repo",
    modelID: "model-a",
    providerID: "provider-a",
    variant: "default",
    locale: "en",
    ignored: ["teh"],
    custom: { gaol: "goal" },
  }
}

describe("correction review guards against stale send authorization", () => {
  test("same draft and execution scope yields a stable fingerprint", () => {
    expect(promptCorrectionReviewFingerprint(scope())).toBe(promptCorrectionReviewFingerprint(scope()))
  })

  test("text, attachment, nested blob and structural metadata are each part of the contract", () => {
    const base = promptCorrectionReviewFingerprint(scope())
    const text = scope()
    if (text.prompt[0]?.type === "text") text.prompt[0].content = "reasearch then contienu"
    expect(promptCorrectionReviewFingerprint(text)).not.toBe(base)

    const image = scope()
    if (image.prompt[1]?.type === "image") image.prompt[1].blob.url = "blob:replacement"
    expect(promptCorrectionReviewFingerprint(image)).not.toBe(base)

    const dropped = scope()
    dropped.prompt = dropped.prompt.slice(0, 1)
    expect(promptCorrectionReviewFingerprint(dropped)).not.toBe(base)

    const mention = scope()
    const mentionContext = mention.context[0]
    if (!mentionContext) throw new Error("missing context")
    mentionContext.comment = "Different comment"
    expect(promptCorrectionReviewFingerprint(mention)).not.toBe(base)
  })

  test("routing changes invalidate a reviewed prompt without any model inference", () => {
    const keys: Array<keyof PromptCorrectionReviewScope> = [
      "sessionID", "directory", "modelID", "providerID", "variant", "locale",
    ]
    const original = promptCorrectionReviewFingerprint(scope())
    for (const key of keys) {
      const changed: PromptCorrectionReviewScope = { ...scope(), [key]: "different-value" }
      expect(promptCorrectionReviewFingerprint(changed)).not.toBe(original)
    }
  })

  test("personal glossary changes also invalidate a review", () => {
    const original = promptCorrectionReviewFingerprint(scope())
    expect(promptCorrectionReviewFingerprint({ ...scope(), ignored: ["reasearch"] })).not.toBe(original)
    expect(promptCorrectionReviewFingerprint({ ...scope(), custom: { gaol: "jail" } })).not.toBe(original)
  })

  test("cyclic or unreadable restored context fails closed", () => {
    const corrupt = scope()
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const corruptContext = corrupt.context[0]
    if (!corruptContext) throw new Error("missing context")
    Object.defineProperty(corruptContext, "comment", { enumerable: true, value: cycle })
    expect(promptCorrectionReviewFingerprint(corrupt)).toBeUndefined()
  })
})
