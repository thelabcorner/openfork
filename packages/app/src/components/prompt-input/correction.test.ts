import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { correctPromptParts, shouldCorrectPromptSubmission, PROMPT_CORRECTION_DICTIONARY_VERSION } from "./correction"

const prose = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]
const corrected = (source: string) => correctPromptParts(prose(source)).effective
  .map((part) => ("content" in part ? part.content : "")).join("")

describe("prompt correction: local, conservative, reference-safe", () => {
  test("versioned known-error dictionary fixes the motivating typos", () => {
    expect(PROMPT_CORRECTION_DICTIONARY_VERSION).toBe("known-typos-1")
    expect(corrected("Contienu the reasearch comprehensivley and exhasutively.")).toBe(
      "Continue the research comprehensively and exhaustively.",
    )
    expect(corrected("Please optimize perfomance, becuase the architecure is unstable.")).toBe(
      "Please optimize performance, because the architecture is unstable.",
    )
  })
  test("explicit human-composer admission gate rejects all untrusted and special paths", () => {
    expect(shouldCorrectPromptSubmission({ enabled: true, mode: "normal" })).toBe(true)
    expect(shouldCorrectPromptSubmission({ enabled: false, mode: "normal" })).toBe(false)
    expect(shouldCorrectPromptSubmission({ enabled: true, mode: "shell" })).toBe(false)
    expect(shouldCorrectPromptSubmission({ enabled: true, mode: "normal", skip: true })).toBe(false)
    expect(shouldCorrectPromptSubmission({ enabled: true, mode: "normal", humanInterjection: true })).toBe(false)
  })

  test("title-case protection avoids named entities and uncommon chemistry vocabulary", () => {
    expect(corrected("I met Contienu and Dr. Thier in the gaol.")).toBe("I met Contienu and Dr. Thier in the gaol.")
    expect(corrected("Contienu reasearch.\nContienu the implementation.")).toBe(
      "Continue research.\nContinue the implementation.",
    )
    expect(corrected("ADN and nucleophilic thier reactions")).toBe("ADN and nucleophilic thier reactions")
  })

  test("valid real-word errors, polarity and unknown project words abstain", () => {
    const input = "The Victorian gaol, then/form/from; don't disable the Nacre kernel."
    expect(corrected(input)).toBe(input)
  })
  test("never touches code spans, multiline code fences or quoted literals", () => {
    const tick = String.fromCharCode(96)
    const source = "Please contienu but preserve " + tick + "contienu" + tick + ", \"contienu\" and 'contienu'.\n" +
      tick.repeat(3) + "ts\nconst contienu = 1;\n" + tick.repeat(3) + "\nNow contienu."
    const expected = "Please continue but preserve " + tick + "contienu" + tick + ", \"contienu\" and 'contienu'.\n" +
      tick.repeat(3) + "ts\nconst contienu = 1;\n" + tick.repeat(3) + "\nNow continue."
    expect(corrected(source)).toBe(expected)
  })
  test("unclosed code fence protects the remainder", () => {
    const tick = String.fromCharCode(96)
    const input = "Please contienu.\n" + tick.repeat(3) + "json\n{ \"contienu\": true }\ncontienu"
    expect(corrected(input)).toBe("Please continue.\n" + tick.repeat(3) + "json\n{ \"contienu\": true }\ncontienu")
  })
  test("explicit personal corrections cover gaol without globally rewriting valid words", () => {
    const original = prose("My gaol is to finish the reasearch. Do not alter " +
      "\"gaol\" or the identifier " + String.fromCharCode(96) + "gaol" + String.fromCharCode(96))
    const result = correctPromptParts(original, true, { userReplacements: { gaol: "goal" } })
    expect(result.effective[0]).toMatchObject({
      content: "My goal is to finish the research. Do not alter \"gaol\" or the identifier " +
        String.fromCharCode(96) + "gaol" + String.fromCharCode(96),
    })
    expect(result.patches[0]?.rule).toBe("user:gaol")
    expect(correctPromptParts(original).effective[0]).toMatchObject({
      content: "My gaol is to finish the research. Do not alter \"gaol\" or the identifier " +
        String.fromCharCode(96) + "gaol" + String.fromCharCode(96),
    })
    expect(correctPromptParts(original, true, { excludedWords: ["gaol"], userReplacements: { gaol: "goal" } })
      .effective[0]).toMatchObject({
        content: "My gaol is to finish the research. Do not alter \"gaol\" or the identifier " +
          String.fromCharCode(96) + "gaol" + String.fromCharCode(96),
      })
  })

  test("personal substitutions cannot rewrite polarity, permissions or unsafe destinations", () => {
    const source = prose("not allow delete keep disable approve permit send public gaol")
    const changed = correctPromptParts(source, true, { userReplacements: {
      not: "now", allow: "deny", delete: "remove", keep: "drop", disable: "enable",
      approve: "reject", permit: "forbid", send: "ignore", public: "private",
      gaol: "goal", "foo.ts": "bar", yes: "no",
    } })
    expect(changed.effective[0]).toMatchObject({
      content: "not allow delete keep disable approve permit send public goal",
    })
    expect(changed.patches).toHaveLength(1)
  })

  test("dictionary locale guard abstains outside English UI locales", () => {
    const draft = prose("contienu the reasearch")
    expect(correctPromptParts(draft, true, { locale: "en" }).status).toBe("corrected")
    expect(correctPromptParts(draft, true, { locale: "en-US" }).status).toBe("corrected")
    for (const locale of ["es", "de", "zh-CN", "fr", "jp"]) {
      expect(correctPromptParts(draft, true, { locale }).effective).toBe(draft)
    }
  })

  test("settings exclusions veto known substitutions and remain case insensitive", () => {
    const source = prose("contienu reasearch")
    const result = correctPromptParts(source, true, { excludedWords: ["CONTIE NU", "CONT IENU", "contienu"] })
    expect(result.effective[0]).toMatchObject({ content: "contienu research" })
    expect(result.patches).toHaveLength(1)
    expect(correctPromptParts(source, false, { excludedWords: [] }).effective).toBe(source)
  })

  test("declarative YAML, TOML, JSON, table cells and curly quotes are preserved", () => {
    const input = "Please contienu.\nkey: contienu\noption = contienu\n" +
      '| contienu | data |\n{"name": "contienu"}\n' +
      "Preserve “contienu”, ‘contienu’ and «contienu».\nThen contienu."
    const expected = input.replace("Please contienu", "Please continue").replace("Then contienu", "Then continue")
    expect(corrected(input)).toBe(expected)
  })

  test("YAML frontmatter, Unicode identifiers, bidirectional controls and zero width abstain", () => {
    const frontmatter = "---\ntitle: contienu\n---\nPlease contienu"
    expect(corrected(frontmatter)).toBe("---\ntitle: contienu\n---\nPlease continue")
    expect(corrected("Please contienu and αcontienuβ and cafécontienu")).toBe(
      "Please continue and αcontienuβ and cafécontienu",
    )
    for (const mark of ["\u202E", "\u200B", "\u2069"]) {
      const input = "Please contienu" + mark
      expect(correctPromptParts(prose(input)).effective).toEqual(prose(input))
    }
  })

  test("unclosed double-quoted literals never receive edits", () => {
    expect(corrected('Please contienu. Exact identifier: "contienu')).toBe(
      'Please continue. Exact identifier: "contienu',
    )
  })

  test("command, code-looking and stacktrace lines remain exact", () => {
    const input = "Please contienu\nconst contienu = 1\n" +
      "// contienu is a literal\n2026-10-10T21:00:00Z ERROR contienu\nNext contienu"
    expect(corrected(input)).toBe(input.replace("Please contienu", "Please continue").replace("Next contienu", "Next continue"))
  })

  test("dense interleaved quotations preserve exact literals and correct surrounding prose", () => {
    const protectedBody = ('"contienu" ').repeat(1_000)
    const proseTail = ("contienu ").repeat(120)
    const input = protectedBody + proseTail
    const result = correctPromptParts(prose(input))
    expect(result.status).toBe("corrected")
    expect(result.patches).toHaveLength(120)
    expect(result.effective[0]).toMatchObject({
      content: protectedBody + ("continue ").repeat(120),
    })
  })

  test("hundreds of structured references keep linearized UTF-16 ranges aligned", () => {
    const parts: Prompt = []
    let offset = 0
    for (let i = 0; i < 420; i++) {
      const content = i % 7 === 0 ? " contienu " : " stable "
      parts.push({ type: "text", content, start: offset, end: offset + content.length })
      offset += content.length
      const token = "@agent"
      parts.push({ type: "agent", content: token, name: "agent", start: offset, end: offset + token.length })
      offset += token.length
    }
    const result = correctPromptParts(parts)
    expect(result.status).toBe("corrected")
    expect(result.patches).toHaveLength(60)
    let next = 0
    for (let i = 0; i < result.effective.length; i++) {
      const after = result.effective[i]
      if (after.type === "image") continue
      expect(after.start).toBe(next)
      expect(after.end).toBe(next + after.content.length)
      next = after.end
      if (after.type !== "agent") continue
      expect(after.content).toBe("@agent")
      expect(after.name).toBe("agent")
    }
    expect(result.original).toBe(parts)
  })

  test("capitalized known typos are corrected only at prompt or line starts", () => {
    const lines = Array.from({ length: 40 }, () => "  Contienu the reasearch.").join("\n")
    const expected = Array.from({ length: 40 }, () => "  Continue the research.").join("\n")
    expect(corrected(lines)).toBe(expected)
    const properName = "Please consult Dr. Contienu about the project"
    expect(corrected(properName)).toBe(properName)
  })

  test("function and callsite identifiers cannot be silently renamed", () => {
    const input = "Please call contienu() rather than reasearch(), then contienu the reasearch."
    expect(corrected(input)).toBe("Please call contienu() rather than reasearch(), then continue the research.")
    expect(corrected("const contienu = fn(reasearch)")).toBe("const contienu = fn(reasearch)")
  })

  test("unclosed single-quoted literals and contractions are treated distinctly", () => {
    expect(corrected("Please contienu, but keep 'contienu")).toBe("Please continue, but keep 'contienu")
    expect(corrected("We shouldn't contienu the reasearch.")).toBe("We shouldn't continue the research.")
    expect(corrected("The quoted 'contienu' token must stay; contienu."))
      .toBe("The quoted 'contienu' token must stay; continue.")
  })

  test("standalone carriage returns abstain; CRLF line boundaries still work", () => {
    const old = prose("contienu\rreasearch")
    const skipped = correctPromptParts(old)
    expect(skipped.status).toBe("bypassed")
    expect(skipped.effective).toBe(old)
    expect(corrected("contienu\r\nreasearch")).toBe("continue\r\nresearch")
  })

  test("structural validation precedes candidate filtering on clean text", () => {
    const invalid = [{ type: "text", content: "All correct", start: 1, end: 12 }] as Prompt
    expect(correctPromptParts(invalid).status).toBe("bypassed")
    const noCandidate = prose("Inspect renderer state and report every measured outcome.")
    const result = correctPromptParts(noCandidate)
    expect(result.status).toBe("unchanged")
    expect(result.effective).toBe(noCandidate)
  })

  test("known words exclusively inside opaque structured references do not trigger edits", () => {
    const before = "All good. "
    const mention = "@contienu"
    const parts: Prompt = [
      { type: "text", content: before, start: 0, end: before.length },
      { type: "agent", name: "contienu", content: mention, start: before.length, end: before.length + mention.length },
    ]
    const output = correctPromptParts(parts)
    expect(output.status).toBe("unchanged")
    expect(output.effective).toBe(parts)
  })

  test("excessive part topology abstains within a bounded budget", () => {
    const parts: Prompt = []
    for (let i = 0; i < 4_097; i++) {
      parts.push({ type: "text", content: "x", start: i, end: i + 1 })
    }
    const output = correctPromptParts(parts)
    expect(output.status).toBe("bypassed")
    expect(output.effective).toBe(parts)
  })

  test("reviewed partial selection applies only explicitly approved patch offsets", () => {
    const source = prose("contienu the reasearch; then contienu again.")
    const full = correctPromptParts(source)
    expect(full.patches).toHaveLength(3)
    const middle = full.patches[1]
    if (!middle) throw new Error("expected middle spelling patch")
    const one = correctPromptParts(source, true, { selectedPatchStarts: new Set([middle.start]) })
    expect(one.patches).toHaveLength(1)
    expect(one.effective[0]).toMatchObject({
      content: "contienu the research; then contienu again.",
    })
    expect(one.original).toBe(source)

    const none = correctPromptParts(source, true, { selectedPatchStarts: new Set() })
    expect(none.status).toBe("unchanged")
    expect(none.effective).toBe(source)

    const unknown = correctPromptParts(source, true, { selectedPatchStarts: new Set([999_999]) })
    expect(unknown.effective).toBe(source)
  })

  test("shell and slash commands are protected", () => {
    expect(corrected("/run contienu")).toBe("/run contienu")
    expect(corrected("git contienu --contienu")).toBe("git contienu --contienu")
    expect(corrected("npm install contienu")).toBe("npm install contienu")
  })
  test("protects URLs, paths, flags, email, HTML and Markdown destinations", () => {
    const input = "contienu https://a.example/contienu and C:\\src\\contienu.ts, --contienu, " +
      "foo@contienu.com, [contienu](https://example.com/contienu), <contienu attr=\"contienu\" />"
    expect(corrected(input)).toBe(input.replace(/^contienu/, "continue"))
  })
  test("link masking handles nested brackets and malformed destinations without leaking edits", () => {
    const valid = "Please contienu. [contienu](https://example.org/contienu) then reasearch."
    expect(corrected(valid)).toBe("Please continue. [contienu](https://example.org/contienu) then research.")
    const nested = "Please contienu. [outer [contienu](docs) then reasearch."
    expect(corrected(nested)).toBe("Please continue. [outer [contienu](docs) then research.")
    const unterminated = "Please contienu. [literal](contienu and reasearch"
    expect(corrected(unterminated)).toBe("Please continue. [literal](contienu and reasearch")
    const emptyTarget = "Please contienu. [contienu]() then reasearch."
    expect(corrected(emptyTarget)).toBe("Please continue. [contienu]() then research.")
  })

  test("adversarial unmatched Markdown link prefixes remain bounded and preserve prose", () => {
    const pre = "Please contienu this paragraph.\n"
    const malformed = "[".repeat(12_000) + " contienu"
    const result = correctPromptParts(prose(pre + malformed))
    expect(result.status).toBe("corrected")
    expect(result.effective[0]).toMatchObject({ content: "Please continue this paragraph.\n" + malformed })
    expect(result.patches).toHaveLength(1)
  })

  test("maintains structured mentions, image identity and UTF-16 offsets", () => {
    const before = "Contienu researching 😀 "
    const token = "@SessionPrompt"
    const rest = " and reasearch the result"
    const image = { type: "image", id: "blob-1", filename: "image.png", mime: "image/png", blob: { id: "b", url: "blob:test" } } as const
    const input: Prompt = [
      { type: "text", content: before, start: 0, end: before.length },
      { type: "agent", content: token, name: "SessionPrompt", start: before.length, end: before.length + token.length },
      { type: "text", content: rest, start: before.length + token.length, end: before.length + token.length + rest.length },
      image,
    ]
    const result = correctPromptParts(input)
    expect(result.status).toBe("corrected")
    expect(result.patches).toHaveLength(2)
    const output = result.effective
    const visible = output.map((part) => ("content" in part ? part.content : "")).join("")
    expect(visible).toBe("Continue researching 😀 @SessionPrompt and research the result")
    expect(output[1]).toMatchObject({ type: "agent", name: "SessionPrompt", content: token })
    const mention = output[1]
    if (!mention || mention.type === "image") throw new Error("expected structured mention")
    expect(mention.start).toBe("Continue researching 😀 ".length)
    expect(mention.end).toBe("Continue researching 😀 @SessionPrompt".length)
    expect(output[3]).toBe(image)
    expect(input[0]).toMatchObject({ content: before, start: 0, end: before.length })
  })
  test("skips malformed range metadata rather than shifting references", () => {
    const data: Prompt = [{ type: "text", content: "contienu", start: 8, end: 16 }]
    const result = correctPromptParts(data)
    expect(result.status).toBe("bypassed")
    expect(result.effective).toBe(data)
  })
  test("does not edit a typo split across text parts", () => {
    const data: Prompt = [
      { type: "text", content: "cont", start: 0, end: 4 },
      { type: "text", content: "ienu", start: 4, end: 8 },
    ]
    expect(correctPromptParts(data).status).toBe("unchanged")
  })
  test("prototype keys and unrelated English words cannot invalidate corrections", () => {
    expect(corrected("constructor toString valueOf contienu")).toBe(
      "constructor toString valueOf continue",
    )
  })

  test("randomized part boundaries preserve atomic reference identity and offsets", () => {
    let seed = 37913
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const snippets = ["contienu", "reasearch", "😀 ", "gaol", "Nacre", "adn", "safe", "contienu.ts", "teh"]
    for (let round = 0; round < 400; round++) {
      const parts: Prompt = []
      let offset = 0
      for (let i = 0; i < 6; i++) {
        const content = snippets[Math.floor(random() * snippets.length)] + " "
        parts.push({ type: "text", content, start: offset, end: offset + content.length })
        offset += content.length
        if (random() > 0.7) {
          const token = "@repo/file.ts"
          parts.push({ type: "file", path: "repo/file.ts", content: token, start: offset, end: offset + token.length })
          offset += token.length
        }
      }
      const original = parts.map((p) => ("content" in p ? p.content : "")).join("")
      const normalized = correctPromptParts(parts)
      let actual = 0
      for (let i = 0; i < parts.length; i++) {
        const before = parts[i]
        const after = normalized.effective[i]
        if (before.type === "image") continue
        if (after.type === "image") throw new Error("unexpected image")
        expect(after.start).toBe(actual)
        expect(after.end).toBe(actual + after.content.length)
        actual = after.end
        if (before.type !== "text") {
          expect(after.content).toBe(before.content)
          if (before.type === "file" && after.type === "file") expect(after.path).toBe(before.path)
        }
      }
      expect(parts.map((p) => ("content" in p ? p.content : "")).join("")).toBe(original)
      expect(correctPromptParts(normalized.effective).patches).toHaveLength(0)
    }
  })

  test("disabled, image-only, oversized and repeated pass preserve original", () => {
    const data = prose("contienu")
    expect(correctPromptParts(data, false).effective).toBe(data)
    expect(correctPromptParts([{
      type: "image", id: "i", filename: "i.png", mime: "image/png", blob: { id: "i", url: "blob:i" },
    }]).status).toBe("bypassed")
    expect(correctPromptParts(prose("contienu ".repeat(3000))).status).toBe("bypassed")
    const once = correctPromptParts(prose("contienu reasearch"))
    expect(correctPromptParts(once.effective).patches).toHaveLength(0)
  })
})
