import { describe, expect, test } from "bun:test"
import { applySpans } from "../../src/tool/edit/span"
import { assertSpansExplain } from "../../src/tool/edit/invariant"
import { applyEditStrategy } from "../../src/tool/edit/strategy"
import { resolveReplacement } from "../../src/tool/edit/match"
import * as Patch from "../../src/patch"
import * as PatchCore from "../../src/tool/patch/core"
import { deriveContent } from "../../src/tool/patch/resolve"

const selectors = ["edits", "line", "range", "insert", "append", "near"] as const

function paramsFor(mask: number) {
  const params: Record<string, unknown> = {}
  if (mask & (1 << 0)) params.edits = [{ oldString: "one", newString: "ONE" }]
  if (mask & (1 << 1)) Object.assign(params, { line: 1, oldText: "one", newText: "ONE" })
  if (mask & (1 << 2)) Object.assign(params, { startLine: 1, endLine: 1, oldText: "one", newText: "ONE" })
  if (mask & (1 << 3)) Object.assign(params, { insertAt: 0, newText: "header" })
  if (mask & (1 << 4)) Object.assign(params, { appendFile: true, newText: "tail" })
  if (mask & (1 << 5)) Object.assign(params, { nearText: "one", oldText: "one", newText: "ONE" })
  return params
}

// A tiny deterministic PRNG keeps failures reproducible without a dependency.
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function gitAdd(path: string, contents: string, finalNewline: boolean): string {
  const lines = contents === "" ? [] : contents.split("\n")
  const patch = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
  ]
  if (lines.length > 0) {
    patch.push(`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`))
    if (!finalNewline) patch.push("\\ No newline at end of file")
  }
  return patch.join("\n")
}

describe("edit and patch deterministic fuzz", () => {
  test("exhaustively classifies all edit strategy selector combinations", () => {
    for (let mask = 0; mask < 1 << selectors.length; mask++) {
      const count = selectors.filter((_, index) => mask & (1 << index)).length
      const params = paramsFor(mask)
      if (count === 0) {
        expect(() => applyEditStrategy("one\ntwo", params as never), `mask ${mask}`).toThrow(/No edit strategy/)
      } else if (count > 1) {
        expect(() => applyEditStrategy("one\ntwo", params as never), `mask ${mask}`).toThrow(/multiple strategies/)
      } else {
        expect(() => applyEditStrategy("one\ntwo", params as never), `mask ${mask}`).not.toThrow()
      }
    }
  })

  test("exhaustively validates range parameter presence and delete combinations", () => {
    for (let mask = 0; mask < 1 << 5; mask++) {
      const params: Record<string, unknown> = {}
      if (mask & 1) params.startLine = 1
      if (mask & 2) params.endLine = 1
      if (mask & 4) params.oldText = "one"
      if (mask & 8) params.newText = "ONE"
      if (mask & 16) params.delete = true
      const hasStartAndEnd = (mask & 3) === 3
      const hasOld = (mask & 4) !== 0
      const hasNew = (mask & 8) !== 0
      const deleting = (mask & 16) !== 0
      const valid = hasStartAndEnd && (deleting ? hasOld && !hasNew : hasNew)
      if (valid) expect(() => applyEditStrategy("one", params as never), `mask ${mask}`).not.toThrow()
      else expect(() => applyEditStrategy("one", params as never), `mask ${mask}`).toThrow()
    }
  })

  test("numeric edit boundaries accept only in-range integer targets", () => {
    const values = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5, 0, 0.5, 1, 2, 3, Number.MAX_SAFE_INTEGER]
    for (const value of values) {
      const lineParams = { line: value, oldText: value === 2 ? "two" : "one", newText: "changed" }
      const insertParams = {
        insertAt: value,
        ...(value > 0 && value <= 2 ? { oldText: value === 1 ? "one" : "two" } : {}),
        newText: "inserted",
      }
      const valid = Number.isInteger(value) && value >= 1 && value <= 2
      if (valid) expect(() => applyEditStrategy("one\ntwo", lineParams), `line ${value}`).not.toThrow()
      else expect(() => applyEditStrategy("one\ntwo", lineParams), `line ${value}`).toThrow()
      const validInsert = Number.isInteger(value) && value >= 0 && value <= 2
      if (validInsert) expect(() => applyEditStrategy("one\ntwo", insertParams), `insertAt ${value}`).not.toThrow()
      else expect(() => applyEditStrategy("one\ntwo", insertParams), `insertAt ${value}`).toThrow()
    }
  })

  test("generated exact replacements only alter their selected span", () => {
    const next = random(0x5eed_cafe)
    const atoms = ["ascii", "space here", "tab\there", "", "café", "e\u0301", "🪴", "+minus-", "quote'\""]
    const endings = ["\n", "\r\n", "\n", "\r\n"]

    for (let sample = 0; sample < 300; sample++) {
      const count = 2 + Math.floor(next() * 10)
      const rows = Array.from({ length: count }, (_, index) => `row-${sample}-${index}-${atoms[Math.floor(next() * atoms.length)]}`)
      let source = rows[0]!
      for (let index = 1; index < rows.length; index++) source += endings[Math.floor(next() * endings.length)] + rows[index]
      if (next() < 0.5) source += endings[Math.floor(next() * endings.length)]
      if (next() < 0.2) source = `\uFEFF${source}`

      const first = Math.floor(next() * (rows.length - 1))
      const span = 1 + Math.floor(next() * Math.min(3, rows.length - first))
      const oldText = rows.slice(first, first + span).join("\n")
      const newText = `${atoms[Math.floor(next() * atoms.length)]}-${sample}\nchanged-${sample}`
      const result = resolveReplacement(source, oldText, newText)
      const output = applySpans(source, result.spans)
      assertSpansExplain(source, output, result.spans)
      expect(result.applied, `sample ${sample}`).toBe(1)
      expect(output).not.toBe(source)
      expect(output.slice(0, result.spans[0]!.start)).toBe(source.slice(0, result.spans[0]!.start))
      expect(output.slice(result.spans[0]!.start + result.spans[0]!.replacement.length)).toBe(
        source.slice(result.spans[0]!.end),
      )
    }
  })

  test("generated patch hunks preserve LF, CRLF, lone-CR, mixed, and EOF boundaries", () => {
    const next = random(0xe01_5afe)
    const terms = ["\n", "\r\n", "\r"] as const

    for (let sample = 0; sample < 240; sample++) {
      const count = 4 + Math.floor(next() * 12)
      const rows = Array.from({ length: count }, (_, index) => `src-${sample}-${index}`)
      const rowTerms = Array.from({ length: count }, (_, index) =>
        index === count - 1 && next() < 0.5 ? "" : terms[Math.floor(next() * terms.length)]!,
      )
      const source = rows.map((line, index) => line + rowTerms[index]).join("")
      const selected = rows.map((_, index) => index).filter(() => next() < 0.3)
      if (selected.length === 0) selected.push(Math.floor(next() * count))

      const chunks = selected.map((index) => {
        const replaceCount = Math.floor(next() * 4)
        return {
          old_lines: [rows[index]!],
          new_lines: Array.from({ length: replaceCount }, (_, replacement) => `out-${sample}-${index}-${replacement}`),
          old_start: index + 1,
        }
      })
      // Hunk order is not a location hint. Exercise arbitrary authoring order.
      chunks.sort(() => next() - 0.5)

      const expectedRows = rows.map((text, index) => ({ text, term: rowTerms[index]! }))
      for (const index of [...selected].sort((a, b) => b - a)) {
        const chunk = chunks.find((item) => item.old_start === index + 1)!
        const priorTerm = [...rowTerms.slice(0, index)].reverse().find(Boolean)
        const fallbackTerm = rowTerms[index] || priorTerm || terms[0]
        const replacement = chunk.new_lines.map((text, replacementIndex) => ({
          text,
          term: replacementIndex === chunk.new_lines.length - 1 ? rowTerms[index]! : fallbackTerm,
        }))
        expectedRows.splice(index, 1, ...replacement)
      }

      const expected = expectedRows.map((row) => row.text + row.term).join("")
      const result = deriveContent(source, chunks, `fuzz-${sample}.txt`)
      expect(result.content, `sample ${sample}`).toBe(expected)
      assertSpansExplain(source, result.content, result.spans)
    }
  })

  test("generated repeated exact targets refuse every ambiguous location", () => {
    const next = random(0xa11_b1a0)
    for (let sample = 0; sample < 90; sample++) {
      const occurrences = 2 + Math.floor(next() * 7)
      const target = `duplicate-${sample}`
      const lines = Array.from({ length: occurrences }, (_, index) => `${target} at ${index}`)
      const first = Math.floor(next() * occurrences)
      const second = (first + 1 + Math.floor(next() * (occurrences - 1))) % occurrences
      lines[first] = target
      lines[second] = target
      const source = lines.join(["\n", "\r\n", "\r"][Math.floor(next() * 3)])
      expect(() => resolveReplacement(source, target, `replacement-${sample}`), `sample ${sample}`).toThrow()
    }
  })

  test("generated native add patches preserve blank and prefixed lines", () => {
    const next = random(0xadd_f11e)
    const atoms = ["plain", "", "+starts-plus", "-starts-minus", " starts-context", "*** looks-like-header", "🧪"]

    for (let sample = 0; sample < 150; sample++) {
      const lines = Array.from({ length: Math.floor(next() * 9) }, () => atoms[Math.floor(next() * atoms.length)]!)
      const patch = ["*** Begin Patch", `*** Add File: fuzz-${sample}.txt`, ...lines.map((line) => `+${line}`), "*** End Patch"].join(
        "\n",
      )
      const parsed = Patch.parsePatch(patch).hunks
      expect(parsed).toHaveLength(1)
      expect(parsed[0]).toEqual({ type: "add", path: `fuzz-${sample}.txt`, contents: lines.join("\n") })
    }
    const trailingWhitespace = Patch.parsePatch(
      ["*** Begin Patch", "*** Add File: trailing.txt", "+last line  \t", "*** End Patch"].join("\n"),
    )
    expect(trailingWhitespace.hunks[0]).toEqual({
      type: "add",
      path: "trailing.txt",
      contents: "last line  \t",
    })
  })

  test("generated Git add diffs preserve empty files, content, and final-newline state", () => {
    const next = random(0x617069)
    const atoms = ["plain", "", "+plus", "-minus", "café", "🧪", " quote "]

    for (let sample = 0; sample < 180; sample++) {
      const lines = Array.from({ length: Math.floor(next() * 8) }, () => atoms[Math.floor(next() * atoms.length)]!)
      const contents = lines.join("\n")
      const finalNewline = contents !== "" && next() < 0.5
      const parsed = PatchCore.translateGitDiff(gitAdd(`fuzz-${sample}.txt`, contents, finalNewline))
      expect(parsed, `sample ${sample}`).toHaveLength(1)
      expect(parsed![0]).toEqual({
        type: "add",
        path: `fuzz-${sample}.txt`,
        contents,
        finalNewline: contents === "" ? false : finalNewline,
      })
    }
  })

  test("a final Git content line ending in spaces is preserved", () => {
    const translated = PatchCore.translateGitDiff(gitAdd("spaces.txt", "last line  \t", true))
    expect(translated).toEqual([
      { type: "add", path: "spaces.txt", contents: "last line  \t", finalNewline: true },
    ])
  })

  test("generated unprefixed patch-body lines are rejected instead of discarded", () => {
    const next = random(0xbad_0ff5)
    for (let sample = 0; sample < 120; sample++) {
      const junk = ["plain text", "  ", "?invalid", `junk-${Math.floor(next() * 1_000_000)}`][Math.floor(next() * 4)]!
      const patch = [
        "*** Begin Patch",
        `*** Add File: invalid-${sample}.txt`,
        "+before",
        junk,
        "+after",
        "*** End Patch",
      ].join("\n")
      expect(() => Patch.parsePatch(patch), `sample ${sample}`).toThrow()
    }
  })
})
