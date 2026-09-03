import { describe, expect, test } from "bun:test"
import { countUnifiedDiff, getToolResult, lineCount } from "./tool-result"

describe("lineCount", () => {
  test("returns undefined for missing output", () => {
    expect(lineCount(undefined)).toBeUndefined()
  })

  test("ignores a trailing newline", () => {
    expect(lineCount("a\nb\nc\n")).toBe(3)
  })

  test("returns 0 for whitespace-only output", () => {
    expect(lineCount("\n\n")).toBe(0)
  })
})

describe("countUnifiedDiff", () => {
  test("counts added and removed lines, ignoring file headers", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,3 @@", " ctx", "-old", "+new", "+extra"].join("\n")
    expect(countUnifiedDiff(diff)).toEqual({ additions: 2, deletions: 1 })
  })

  test("returns undefined when nothing changed", () => {
    expect(countUnifiedDiff("@@ -1 +1 @@\n ctx")).toBeUndefined()
  })

  test("returns undefined for non-strings", () => {
    expect(countUnifiedDiff(undefined)).toBeUndefined()
  })
})

describe("getToolResult", () => {
  test("reports nothing while the call is still running", () => {
    expect(getToolResult({ tool: "grep", metadata: { matches: 4 }, status: "running" })).toBeUndefined()
  })

  test("reports a failure for errored calls regardless of tool", () => {
    expect(getToolResult({ tool: "anything", status: "error" })).toEqual({ text: "failed", tone: "danger" })
  })

  test("grep reports match count", () => {
    expect(getToolResult({ tool: "grep", metadata: { matches: 22 } })).toEqual({ text: "22 matches", tone: undefined })
  })

  test("grep flags a zero-match search", () => {
    expect(getToolResult({ tool: "grep", metadata: { matches: 0 } })).toEqual({ text: "0 matches", tone: "warning" })
  })

  test("grep singularises one match", () => {
    expect(getToolResult({ tool: "grep", metadata: { matches: 1 } })?.text).toBe("1 match")
  })

  test("read counts output lines", () => {
    expect(getToolResult({ tool: "read", output: "a\nb\nc" })?.text).toBe("3 lines")
  })

  test("read marks truncated output", () => {
    expect(getToolResult({ tool: "read", output: "a\nb", metadata: { truncated: true } })?.text).toBe("2 lines+")
  })

  test("glob prefers metadata count over the output", () => {
    expect(getToolResult({ tool: "glob", metadata: { count: 31 }, output: "one\ntwo" })?.text).toBe("31 files")
  })

  test("shell reports a zero exit as success", () => {
    expect(getToolResult({ tool: "shell", metadata: { exit: 0 } })).toEqual({ text: "exit 0", tone: "success" })
  })

  test("shell reports a non-zero exit as danger", () => {
    expect(getToolResult({ tool: "shell", metadata: { exit: 2 } })).toEqual({ text: "exit 2", tone: "danger" })
  })

  test("edit reads structured filediff counts", () => {
    expect(getToolResult({ tool: "edit", metadata: { filediff: { additions: 12, deletions: 3 } } })).toEqual({
      changes: { additions: 12, deletions: 3 },
    })
  })

  test("write falls back to counting its unified diff string", () => {
    const diff = ["--- a/x", "+++ b/x", "+one", "+two", "-gone"].join("\n")
    expect(getToolResult({ tool: "write", metadata: { diff } })).toEqual({
      changes: { additions: 2, deletions: 1 },
    })
  })

  test("todowrite reports progress", () => {
    const todos = [{ status: "completed" }, { status: "completed" }, { status: "pending" }]
    expect(getToolResult({ tool: "todowrite", args: { todos } })).toEqual({ text: "2 / 3", tone: undefined })
  })

  test("todowrite marks a fully complete list as success", () => {
    const todos = [{ status: "completed" }]
    expect(getToolResult({ tool: "todowrite", args: { todos } })?.tone).toBe("success")
  })

  test("typecheck reports a clean run", () => {
    expect(getToolResult({ tool: "typecheck", metadata: { errors: 0 } })).toEqual({ text: "clean", tone: "success" })
  })

  test("returns undefined when the tool exposes no usable signal", () => {
    expect(getToolResult({ tool: "websearch", metadata: { provider: "exa" } })).toBeUndefined()
    expect(getToolResult({ tool: "grep", metadata: {} })).toBeUndefined()
  })
})
