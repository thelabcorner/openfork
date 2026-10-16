import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt-state"
import { proposeHarperAutofix, rejectHarperAutofix, shiftHarperChanges, rebaseHarperChanges, type AutoHarperChange } from "./harper-autofix"
import type { PromptGrammarIssue } from "./harper-projection"

const prose = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]
const spelling = (text: string, token: string, suggestions: string[]): PromptGrammarIssue => ({
  id: "fixture", original: token, start: text.indexOf(token),
  end: text.indexOf(token) + token.length, message: "Spelling",
  category: "spelling", suggestions,
})

describe("opt-in high-confidence automatic corrections and rejection", () => {
  test("never accepts Harper's misleading first candidate when a curated typo differs", () => {
    const text = "Please contienu the reasearch."
    const change = proposeHarperAutofix(prose(text),
      [spelling(text, "contienu", ["content", "continent", "continue"])],
      text.length, new Set())
    expect(change?.parts[0]).toMatchObject({ content: "Please continue the reasearch." })
    expect(change?.change).toMatchObject({ original: "contienu", replacement: "continue" })
    expect(change?.cursor).toBe(text.length)
    expect(prose(text)[0]).toMatchObject({ content: text })
  })

  test("ignores ambiguous technical names, grammar, and unverifiable spellings", () => {
    const text = "Use openfork and check teh settings."
    expect(proposeHarperAutofix(prose(text),
      [spelling(text, "openfork", ["openwork"])], text.length, new Set())).toBeUndefined()
    const agreement: PromptGrammarIssue = {
      ...spelling("I has a book.", "has", ["have"]), category: "grammar",
      message: "The form of the verb must agree in grammatical number with the pronoun.",
    }
    expect(proposeHarperAutofix(prose("I has a book."), [agreement], 13, new Set())).toBeUndefined()
    expect(proposeHarperAutofix(prose(text),
      [spelling(text, "teh", ["ten"])], text.length, new Set())).toBeUndefined()
  })

  test("auto-fixes only Harper's exact, single-suggestion indefinite-article grammar rule", () => {
    const text = "This is a example."
    const article: PromptGrammarIssue = {
      ...spelling(text, "a", ["an"]), category: "grammar",
      message: "Incorrect indefinite article.",
    }
    const result = proposeHarperAutofix(prose(text), [article], text.length, new Set())
    expect(result?.parts[0]).toMatchObject({ content: "This is an example." })
    expect(result?.change).toMatchObject({ original: "a", replacement: "an" })
    expect(result && rejectHarperAutofix(result.parts, result.change, result.cursor)?.parts).toEqual(prose(text))
    expect(proposeHarperAutofix(prose(text), [article], text.length, new Set(["a"]))).toBeUndefined()
    const multiple = { ...article, suggestions: ["an", "a"] }
    expect(proposeHarperAutofix(prose(text), [multiple], text.length, new Set())).toBeUndefined()
  })

  test("sentence punctuation is not mistaken for a property or function identifier", () => {
    for (const suffix of [".", "!", ","]) {
      const text = "Please reasearch" + suffix
      const candidate = proposeHarperAutofix(prose(text),
        [spelling(text, "reasearch", ["research"])], text.length, new Set())
      expect(candidate?.parts[0]).toMatchObject({ content: "Please research" + suffix })
    }
    for (const text of ["module.reasearch", "reasearch()", "reasearch.test"]) {
      const candidate = proposeHarperAutofix(prose(text),
        [spelling(text, "reasearch", ["research"])], text.length, new Set())
      expect(candidate).toBeUndefined()
    }
  })

  test("only changes a word after the caret leaves it", () => {
    const text = "Please contienu "
    const issue = spelling(text, "contienu", ["continue"])
    expect(proposeHarperAutofix(prose(text), [issue], issue.end, new Set())).toBeUndefined()
    expect(proposeHarperAutofix(prose(text), [issue], text.length, new Set())?.change.original).toBe("contienu")
  })

  test("rejection restores exactly the changed word without discarding other draft content", () => {
    const text = "Please contienu the reasearch."
    const issue = spelling(text, "contienu", ["content", "continue"])
    const changed = proposeHarperAutofix(prose(text), [issue], text.length, new Set())
    expect(changed).toBeDefined()
    if (!changed) return
    const reverted = rejectHarperAutofix(changed.parts, changed.change, changed.cursor)
    expect(reverted?.parts).toEqual(prose(text))
    expect(reverted?.cursor).toBe(text.length)
    expect(proposeHarperAutofix(prose(text), [issue], text.length, new Set(["contienu"]))).toBeUndefined()
  })

  test("protected code and quoted strings are never auto-applied", () => {
    for (const text of [
      'Do not edit "contienu" in the test.',
      "Keep `contienu` unchanged.",
      "Use contienu() and don't rename the function.",
      "In the fenced block:\n```ts\ncontienu\n```",
    ]) {
      const issue = spelling(text, "contienu", ["continue"])
      expect(proposeHarperAutofix(prose(text), [issue], text.length, new Set())).toBeUndefined()
    }
  })

  test("recalculates offsets of structured mentions after automatic change and rejection", () => {
    const before = "Please contienu "
    const mention = "@file.ts"
    const end = " and inspect."
    const parts: Prompt = [
      { type: "text", content: before, start: 0, end: before.length },
      { type: "file", content: mention, path: "file.ts", start: before.length, end: before.length + mention.length },
      { type: "text", content: end, start: before.length + mention.length,
        end: before.length + mention.length + end.length },
    ]
    const changed = proposeHarperAutofix(parts, [spelling(before, "contienu", ["continue"])],
      before.length + mention.length + end.length, new Set())
    expect(changed?.parts[1]).toMatchObject({ start: "Please continue ".length })
    expect(changed?.parts[0]).toMatchObject({ content: "Please continue " })
    if (!changed) return
    expect(rejectHarperAutofix(changed.parts, changed.change, changed.cursor)?.parts).toEqual(parts)
  })

  test("unrelated typing before or after a correction preserves individual reject controls", () => {
    const marker: AutoHarperChange = {
      id: "a", original: "contienu", replacement: "continue", start: 7, end: 15,
    }
    const oldText = "Please continue working."
    expect(rebaseHarperChanges(prose(oldText), prose("Now " + oldText), [marker])).toEqual([
      { ...marker, start: 11, end: 19 },
    ])
    expect(rebaseHarperChanges(prose(oldText), prose(oldText + " More instructions."), [marker])).toEqual([marker])
    expect(rebaseHarperChanges(prose(oldText), prose("Please continueX working."), [marker])).toEqual([])
  })

  test("changing an opaque mention invalidates every old correction marker", () => {
    const prefix = "Please continue "
    const marker: AutoHarperChange = {
      id: "a", original: "contienu", replacement: "continue", start: 7, end: 15,
    }
    const parts = (path: string): Prompt => [
      { type: "text", content: prefix, start: 0, end: prefix.length },
      { type: "file", path, content: "@ref", start: prefix.length, end: prefix.length + 4 },
    ]
    expect(rebaseHarperChanges(parts("a.ts"), parts("b.ts"), [marker])).toBeUndefined()
  })

  test("independent automatic fixes preserve earlier rejection coordinates", () => {
    const older: AutoHarperChange = { id: "one", original: "teh", replacement: "the", start: 10, end: 13 }
    expect(shiftHarperChanges([older], 4, 8, 2)).toEqual([{ ...older, start: 12, end: 15 }])
    expect(shiftHarperChanges([older], 16, 20, 2)).toEqual([older])
    expect(shiftHarperChanges([older], 11, 12, 2)).toEqual([])
  })
})
