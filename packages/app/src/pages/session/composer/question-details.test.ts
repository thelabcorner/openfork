import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { QUESTION_DETAIL_MAX_CHARS, questionDetailsEmpty, questionDetailsText } from "./question-details"

const text = (content: string): Prompt[number] => ({ type: "text", content, start: 0, end: content.length })

describe("questionDetailsText", () => {
  test("joins text parts in order", () => {
    expect(questionDetailsText([text("use the "), text("second option")])).toBe("use the second option")
  })

  test("preserves file mentions verbatim so the answer keeps its references", () => {
    const parts: Prompt = [
      text("look at "),
      { type: "file", path: "src/app.ts", content: "@src/app.ts", start: 0, end: 11 },
      text(" and "),
      { type: "file", path: "src/util.ts", content: "@src/util.ts", start: 0, end: 12 },
    ]
    expect(questionDetailsText(parts)).toBe("look at @src/app.ts and @src/util.ts")
  })

  test("preserves agent, skill and tool mentions", () => {
    const parts: Prompt = [
      { type: "agent", name: "plan", content: "@plan", start: 0, end: 5 },
      text(" then "),
      { type: "skill", name: "dataviz", content: "@dataviz", start: 0, end: 8 },
      text(" with "),
      { type: "tool", name: "grep", content: "@grep", start: 0, end: 5 },
    ]
    expect(questionDetailsText(parts)).toBe("@plan then @dataviz with @grep")
  })

  test("drops image attachments, which have no textual form", () => {
    const parts: Prompt = [
      text("see "),
      { type: "image", id: "img_1", filename: "shot.png", mime: "image/png", blob: { id: "b1", url: "blob:x" } },
      text("this"),
    ]
    expect(questionDetailsText(parts)).toBe("see this")
  })

  test("trims surrounding whitespace", () => {
    expect(questionDetailsText([text("  answer \n ")])).toBe("answer")
  })

  test("caps runaway details at the API limit", () => {
    const long = "x".repeat(QUESTION_DETAIL_MAX_CHARS + 500)
    expect(questionDetailsText([text(long)])).toHaveLength(QUESTION_DETAIL_MAX_CHARS)
  })
})

describe("questionDetailsEmpty", () => {
  test("treats whitespace-only composers as empty", () => {
    expect(questionDetailsEmpty([text("   \n  ")])).toBe(true)
    expect(questionDetailsEmpty([])).toBe(true)
  })

  test("a lone mention still counts as details", () => {
    expect(questionDetailsEmpty([{ type: "file", path: "a.ts", content: "@a.ts", start: 0, end: 5 }])).toBe(false)
  })
})
