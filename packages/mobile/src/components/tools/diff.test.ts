import { describe, expect, test } from "bun:test"
import { parseUnifiedDiff, splitLines, synthesizeDiff } from "./diff"

describe("parseUnifiedDiff", () => {
  test("parses hunks with headers, counts and line numbers", () => {
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 83db48f..bf269f4 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -10,7 +10,8 @@ export function boot() {",
      " const one = 1",
      "-const two = 2",
      "+const two = 2 // tweaked",
      "+const three = 3",
      " const four = 4",
    ].join("\n")

    const parsed = parseUnifiedDiff(patch)!
    expect(parsed).toBeDefined()
    expect(parsed.additions).toBe(2)
    expect(parsed.deletions).toBe(1)
    expect(parsed.hunks.length).toBe(1)

    const hunk = parsed.hunks[0]!
    expect(hunk.lines[0]).toEqual({ kind: "context", oldNo: 10, newNo: 10, text: "const one = 1" })
    expect(hunk.lines[1]).toEqual({ kind: "del", oldNo: 11, text: "const two = 2" })
    expect(hunk.lines[2]).toEqual({ kind: "add", newNo: 11, text: "const two = 2 // tweaked" })
    expect(hunk.lines[3]).toEqual({ kind: "add", newNo: 12, text: "const three = 3" })
    expect(hunk.lines[4]).toEqual({ kind: "context", oldNo: 12, newNo: 13, text: "const four = 4" })
  })

  test("tracks line numbers across multiple hunks", () => {
    const patch = [
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "@@ -20,3 +20,3 @@",
      " x",
      " y",
      "-z",
    ].join("\n")

    const parsed = parseUnifiedDiff(patch)!
    expect(parsed.hunks.length).toBe(2)
    expect(parsed.deletions).toBe(2)
    expect(parsed.additions).toBe(1)

    const second = parsed.hunks[1]!
    expect(second.lines[0]?.oldNo).toBe(20)
    expect(second.lines[2]?.oldNo).toBe(22)
  })

  test("skips no-newline markers without corrupting numbering", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-old", "\\ No newline at end of file", "+new"].join("\n")
    const parsed = parseUnifiedDiff(patch)!
    expect(parsed.hunks[0]!.lines.length).toBe(2)
    expect(parsed.hunks[0]!.lines[1]?.newNo).toBe(1)
  })

  test("normalizes CRLF output", () => {
    const parsed = parseUnifiedDiff("@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n")!
    expect(parsed.hunks[0]!.lines.map((l) => l.text)).toEqual(["a", "b", "c"])
  })

  test("returns undefined for non-diff input", () => {
    expect(parseUnifiedDiff("")).toBeUndefined()
    expect(parseUnifiedDiff("just some log output\nnothing diffy")).toBeUndefined()
  })

  test("tolerates malformed context rows missing their leading space", () => {
    const parsed = parseUnifiedDiff(["@@ -1,2 +1,2 @@", "context-no-space", "+added"].join("\n"))!
    expect(parsed.hunks[0]!.lines[0]).toMatchObject({ kind: "context", text: "context-no-space" })
    expect(parsed.additions).toBe(1)
  })

  test("bare patch with no file headers still parses", () => {
    const parsed = parseUnifiedDiff("-gone\n+here\n")!
    expect(parsed.deletions).toBe(1)
    expect(parsed.additions).toBe(1)
    expect(parsed.hunks[0]!.header).toContain("@@ -1 +1 @@")
  })
})

describe("splitLines", () => {
  test("drops the trailing empty entry from newline-terminated text", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"])
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"])
    expect(splitLines("")).toEqual([])
    expect(splitLines("\n")).toEqual([""])
  })
})

describe("synthesizeDiff", () => {
  test("produces all-addition diff for new files", () => {
    const parsed = synthesizeDiff("", "line one\nline two")!
    expect(parsed.additions).toBe(2)
    expect(parsed.deletions).toBe(0)
    expect(parsed.hunks.every((hunk) => hunk.lines.every((l) => l.kind === "add"))).toBe(true)
  })

  test("counts symmetric replacements", () => {
    const before = "alpha\nbravo\ncharlie"
    const after = "alpha\nBRAVO\ndelta\ncharlie"
    const parsed = synthesizeDiff(before, after)!
    expect(parsed.additions).toBe(2)
    expect(parsed.deletions).toBe(1)
  })

  test("collapses long unchanged runs to context windows around edits", () => {
    const stable = Array.from({ length: 100 }, (_, i) => `stable ${i}`).join("\n")
    const after = `${stable}\ninserted`
    const parsed = synthesizeDiff(stable, after)!
    const contextRows = parsed.hunks.flatMap((hunk) => hunk.lines.filter((l) => l.kind === "context"))
    expect(contextRows.length).toBeLessThan(50)
    expect(parsed.additions).toBe(1)
  })

  test("identical content produces no diff", () => {
    expect(synthesizeDiff("same", "same")).toBeUndefined()
    expect(synthesizeDiff("", "")).toBeUndefined()
  })

  test("falls back to whole-file replace beyond the LCS cap", () => {
    const big = Array.from({ length: 1200 }, (_, i) => `a${i}`)
    const other = Array.from({ length: 1200 }, (_, i) => `b${i}`)
    const parsed = synthesizeDiff(big.join("\n"), other.join("\n"))!
    expect(parsed.additions).toBe(1200)
    expect(parsed.deletions).toBe(1200)
  })
})
