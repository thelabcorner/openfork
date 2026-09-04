import { describe, expect, test } from "bun:test"
import { looksLikeMarkdown, parseToolText } from "./tool-text"

describe("looksLikeMarkdown", () => {
  test("accepts documents with unambiguous structure", () => {
    expect(looksLikeMarkdown("# Title\n\n## Section\n\ntext")).toBe(true)
    expect(looksLikeMarkdown("intro\n\n```ts\nconst a = 1\n```")).toBe(true)
    expect(looksLikeMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true)
  })

  test("rejects tool output that merely contains punctuation", () => {
    // Rendering these as markdown is what mangled them: the wrapper disappears,
    // the fields collapse into a paragraph, indentation is dropped.
    expect(looksLikeMarkdown('<job id="job_1" status="running">\nKind: shell\nStatus: running\n</job>')).toBe(false)
    expect(looksLikeMarkdown("Found 3 matches\nsrc/a.ts:\n  Line 4: const x = a * b * c")).toBe(false)
    expect(looksLikeMarkdown("# comment in a shell script\necho hi")).toBe(false)
  })
})

describe("parseToolText", () => {
  test("unwraps a tag and turns its body into fields", () => {
    const parsed = parseToolText(
      [
        '<job id="job_069" status="running" kind="shell">',
        "<command>npx tsx scripts/run.ts baseline</command>",
        "Kind: shell",
        "Status: running",
        "Started: 2026-09-03T21:06:43.594Z",
        "</job>",
      ].join("\n"),
    )

    expect(parsed.tag).toBe("job")
    expect(parsed.attrs).toEqual([
      { key: "id", value: "job_069" },
      { key: "status", value: "running" },
      { key: "kind", value: "shell" },
    ])
    const fields = parsed.blocks.find((block) => block.kind === "fields")
    expect(fields).toBeDefined()
    if (fields?.kind !== "fields") throw new Error("unreachable")
    expect(fields.items.map((item) => item.key)).toEqual(["Kind", "Status", "Started"])
  })

  test("keeps a single Key: value line as prose rather than a one-row grid", () => {
    const parsed = parseToolText("Killed job job_1. Status: cancelled.")
    expect(parsed.blocks).toEqual([{ kind: "text", text: "Killed job job_1. Status: cancelled." }])
  })

  test("preserves indentation in verbatim text", () => {
    const parsed = parseToolText("Job                      Status\njob_1                    running")
    expect(parsed.blocks).toEqual([
      { kind: "text", text: "Job                      Status\njob_1                    running" },
    ])
  })

  test("collects bullet runs into a list", () => {
    const parsed = parseToolText("Files changed:\n- src/a.ts\n- src/b.ts\n- src/c.ts")
    expect(parsed.blocks).toEqual([
      { kind: "text", text: "Files changed:" },
      { kind: "list", items: ["src/a.ts", "src/b.ts", "src/c.ts"] },
    ])
  })
})
