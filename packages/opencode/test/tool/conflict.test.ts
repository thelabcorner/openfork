import { describe, expect, test } from "bun:test"
import { bestRegion, occurrenceLineNumbers, patchConflictDetail, renderRegion, replaceConflictHint, spanConflictHint } from "../../src/tool/conflict"
import { replace } from "../../src/tool/edit"

const source = [
  "function render(props) {",
  "  const items = props.items ?? []",
  "  return items.map((i) => i.name).join(', ')",
  "}",
  "",
  "function other() {",
  "  return 42",
  "}",
].join("\n")

describe("conflict context", () => {
  test("bestRegion tolerates indentation and whitespace drift", () => {
    const region = bestRegion(source, ["    function render(props)  {", "const items = props.items ?? []"])
    expect(region?.start).toBe(0)
    expect(region?.score).toBe(1)
  })

  test("bestRegion finds a partially drifted block", () => {
    const region = bestRegion(source, [
      "function render(props) {",
      "  const items = props.items || []",
      "  return items.map((i) => i.name).join(', ')",
      "}",
    ])
    expect(region?.start).toBe(0)
    expect(region?.score).toBeCloseTo(0.75)
  })

  test("bestRegion rejects unrelated needles", () => {
    expect(bestRegion(source, ["zzzz qqqq wwww eee rrr ttt"])).toBeUndefined()
  })

  test("occurrenceLineNumbers reports every exact hit", () => {
    expect(occurrenceLineNumbers("a\ndup\nb\ndup\ndup", "dup")).toEqual([2, 4, 5])
  })

  test("renderRegion numbers lines, marks the region, and truncates long lines", () => {
    const long = "x".repeat(400)
    const content = `${Array.from({ length: 40 }, (_, i) => `pad ${i}`).join("\n")}\n${long}\nafter`
    const out = renderRegion(content, { start: 40, end: 41 })
    const rows = out.split("\n")
    expect(rows.length).toBeLessThanOrEqual(15)
    expect(out).toContain(`${"x".repeat(160)}…`)
    expect(rows.find((r) => r.startsWith(">"))).toBeDefined()
  })

  test("replaceConflictHint lists lines for ambiguous matches", () => {
    const hint = replaceConflictHint({ content: "a\ntarget\nb\ntarget", needle: "target" })
    expect(hint).toContain("appears at line(s): 2, 4")
    expect(hint).toContain("| target")
  })

  test("replaceConflictHint shows the nearest region for stale targets", () => {
    const hint = replaceConflictHint({
      content: source,
      needle: ["function render(props) {", "  const items = props.items || []"].join("\n"),
    })
    expect(hint).toContain("Current file content closest to your target:")
    expect(hint).toContain("| function render(props) {")
  })

  test("replaceConflictHint lists lines even for insignificant-but-ambiguous needles", () => {
    const hint = replaceConflictHint({ content: source, needle: "}" })
    expect(hint).toContain("appears at line(s): 4, 8")
  })

  test("replaceConflictHint stays silent for absent junk needles", () => {
    expect(replaceConflictHint({ content: source, needle: "zz" })).toBeUndefined()
    expect(replaceConflictHint({ content: source, needle: "totally absent unique zebra text" })).toBeUndefined()
  })

  test("spanConflictHint renders the expanded span with line numbers", () => {
    const out = spanConflictHint({ content: source, span: "function other() {\n  return 42\n}" })
    expect(out).toContain("6 | function other() {")
    expect(out).toContain("7 |   return 42")
  })

  test("patchConflictDetail recovers expected lines from derive errors", () => {
    const error = new Error(
      "Failed to find expected lines in src/x.ts:\nfunction render(props) {\n  const items = props.items || []\n  return items.map((i) => i.name).join(', ')",
    )
    const detail = patchConflictDetail({ content: source, chunks: [], error })
    expect(detail).toContain("Failed to find expected lines in src/x.ts")
    expect(detail).toContain("Current file content closest to the expected lines:")
    expect(detail).toContain("props.items ?? []")
  })

  test("patchConflictDetail handles change_context failures", () => {
    const error = new Error("Failed to find context 'function render(props) {' in src/x.ts")
    const detail = patchConflictDetail({ content: source, chunks: [], error })
    expect(detail).toContain("| function render(props) {")
  })

  test("patchConflictDetail passes through unrecognized errors", () => {
    const error = new Error("boom")
    expect(patchConflictDetail({ content: source, chunks: [], error })).toBe("boom")
  })

  test("replace() embeds the nearest region when oldString is absent", () => {
    try {
      replace(source, "  const items = props.items || []\n  return items.map((i) => i.name).join(', ')", "", false)
      throw new Error("expected replace to fail")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain("Could not find oldString")
      expect(message).toContain("Current file content closest to your target:")
      expect(message).toContain("| function render(props) {")
    }
  })

  test("replace() lists match sites when oldString is ambiguous", () => {
    const content = "one\nmark\nthree\nmark\nfive"
    try {
      replace(content, "mark", "X", false)
      throw new Error("expected replace to fail")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain("Found multiple matches")
      expect(message).toContain("appears at line(s): 2, 4")
    }
  })
})
