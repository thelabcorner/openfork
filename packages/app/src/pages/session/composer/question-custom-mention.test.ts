import { describe, expect, test } from "bun:test"
import { applyQuestionMention, questionMentionToken } from "./question-custom-mention"

describe("question custom response mentions", () => {
  test("finds a mention token at the cursor", () => {
    expect(questionMentionToken("Use @packages/app", 17)).toEqual({ start: 4, end: 17, query: "packages/app" })
  })

  test("does not treat email-like text as a mention", () => {
    expect(questionMentionToken("me@example.com", 14)).toBeUndefined()
  })

  test("stops a mention at whitespace", () => {
    expect(questionMentionToken("Use @src then", 13)).toBeUndefined()
  })

  test("stops a mention at prose punctuation", () => {
    expect(questionMentionToken("Use @src, then", 9)).toBeUndefined()
  })

  test("replaces the whole token when the caret is in its middle", () => {
    const value = "Use @src/old.ts please"
    const token = questionMentionToken(value, 8)
    expect(token).toEqual({ start: 4, end: 15, query: "src" })
    expect(applyQuestionMention(value, token!, "src/new.ts")).toEqual({
      value: "Use @src/new.ts please",
      cursor: 15,
    })
  })

  test("replaces only the active token and keeps following text", () => {
    expect(applyQuestionMention("Use @src, please", { start: 4, end: 8, query: "src" }, "src/index.ts")).toEqual({
      value: "Use @src/index.ts, please",
      cursor: 17,
    })
  })
})
