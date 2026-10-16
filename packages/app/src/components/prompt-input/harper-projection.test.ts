import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt-state"
import { applyHarperSuggestion, harperSpanToUtf16, projectPromptForHarper, promptGrammarDraftIdentity, type PromptGrammarIssue } from "./harper-projection"

const prose = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]
const issue = (original: string, start: number): PromptGrammarIssue => ({
  id: `${start}`, start, end: start + original.length, original,
  message: "Synthetic fixture issue", category: "spelling", suggestions: ["correct"],
})

describe("Harper grammar projection (local, structured-safe)", () => {
  test("works for normal prose and preserves positions", () => {
    const input = projectPromptForHarper(prose("This is a example of a application."))
    expect(input?.text).toBe("This is a example of a application.")
    expect(input && harperSpanToUtf16(input, 10, 17)).toEqual({
      start: 10, end: 17, original: "example",
    })
  })

  test("masks quoted literals, code fences, URLs and metadata before linting", () => {
    const text = 'Please reasearch the module. "contienu" https://example.com/reasearch\n```ts\ncontienu()\n```\nDo the reasearch.'
    const input = projectPromptForHarper(prose(text))
    expect(input).toBeDefined()
    expect(input?.text).toContain("Please reasearch the module.")
    expect(input?.text).not.toContain("contienu")
    expect(input?.text).not.toContain("example.com")
    expect(input?.text).toContain("Do the reasearch.")
    const quoted = text.indexOf("contienu")
    const scalar = Array.from(text.slice(0, quoted)).length
    expect(input && harperSpanToUtf16(input, scalar, scalar + 8)).toBeUndefined()
  })

  test("keeps Unicode scalar → UTF-16 locations across emoji and astral symbols", () => {
    const text = "😊 This is a example."
    const input = projectPromptForHarper(prose(text))
    expect(input).toBeDefined()
    const index = Array.from(text.slice(0, text.indexOf("example"))).length
    expect(input && harperSpanToUtf16(input, index, index + 7)).toEqual({
      start: text.indexOf("example"),
      end: text.indexOf("example") + 7,
      original: "example",
    })
  })

  test("does not expose mention identities or permit spans across structured parts", () => {
    const head = "Please "
    const mention = "@tool"
    const tail = " reasearch this."
    const parts: Prompt = [
      { type: "text", content: head, start: 0, end: head.length },
      { type: "tool", name: "tool", content: mention, start: head.length, end: head.length + mention.length },
      { type: "text", content: tail, start: head.length + mention.length,
        end: head.length + mention.length + tail.length },
    ]
    const input = projectPromptForHarper(parts)
    expect(input?.text).not.toContain(mention)
    const cursor = head.length
    expect(input && harperSpanToUtf16(input, cursor - 1, cursor + mention.length + 1)).toBeUndefined()
  })

  test("abstains on commands, 8k+ prompts and broken offsets", () => {
    expect(projectPromptForHarper(prose("/review the the text"))).toBeUndefined()
    expect(projectPromptForHarper(prose("test ".repeat(1_800)))).toBeUndefined()
    expect(projectPromptForHarper([{ type: "text", content: "hello", start: 1, end: 6 }])).toBeUndefined()
  })

  test("applies only an explicit approved text suggestion, never modifies the input", () => {
    const lead = "Please correct "
    const reference = "@file.ts"
    const parts: Prompt = [
      { type: "text", content: lead, start: 0, end: lead.length },
      { type: "file", content: reference, path: "src/file.ts", start: lead.length, end: lead.length + reference.length },
      { type: "text", content: " and correct.", start: lead.length + reference.length,
        end: lead.length + reference.length + " and correct.".length },
    ]
    const x = issue("correct", 7)
    const result = applyHarperSuggestion(parts, x, "correct")
    expect(result).toBeDefined()
    expect(result?.parts[1]).toMatchObject({ start: lead.length })
    expect(applyHarperSuggestion(parts, x, "unlisted")).toBeUndefined()
    expect(parts[0]).toMatchObject({ content: lead })
  })

  test("draft identity distinguishes metadata changes even with identical text", () => {
    const make = (path: string): Prompt => [
      { type: "text", content: "Inspect ", start: 0, end: 8 },
      { type: "file", path, content: "@module", start: 8, end: 15 },
      { type: "text", content: " for the issue.", start: 15, end: 30 },
    ]
    const a = make("src/original.ts")
    const b = make("src/changed.ts")
    expect(a.map((part) => "content" in part ? part.content : "").join("")).toBe(b.map((part) => "content" in part ? part.content : "").join(""))
    expect(promptGrammarDraftIdentity(a)).not.toBe(promptGrammarDraftIdentity(b))
    expect(promptGrammarDraftIdentity(a)).toBe(promptGrammarDraftIdentity(make("src/original.ts")))
  })

  test("malformed or cyclic restored source metadata refuses a draft identity", () => {
    const circular: Record<string, unknown> = {}
    circular.loop = circular
    const bad = [{ type: "text" as const, content: "test", start: 0, end: 4 }] satisfies Prompt
    Object.assign(bad[0], { untrusted: circular })
    expect(promptGrammarDraftIdentity(bad)).toBeUndefined()
  })

  test("rejects attempts to modify quoted code even when a stale issue matches its text", () => {
    const text = 'Please keep "contienu" exactly.'
    const x: PromptGrammarIssue = { ...issue("contienu", text.indexOf("contienu")), suggestions: ["continue"] }
    expect(applyHarperSuggestion(prose(text), x, "continue")).toBeUndefined()
  })
})
