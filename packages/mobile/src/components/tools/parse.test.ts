import { describe, expect, test } from "bun:test"
import {
  looksLikeMarkdown,
  parseGit,
  parseJobBlock,
  parseSkillNotice,
  parseToolError,
  parseToolText,
  parseTypecheck,
} from "./parse"

const ESC = "\u001b"

describe("parseToolError", () => {
  test("does not mistake a quoted patch excerpt for a stack trace", () => {
    const parsed = parseToolError(
      [
        "patch verification failed for 1 file(s):",
        "  client/src/resize/GroupResizeHandles.tsx: update: Failed to find expected lines:",
        "    const computedHitZone = Math.max(computedHandleSize + 4, 18 / Math.sqrt(scale));",
        "",
        "Current file content closest to the expected lines:",
        "",
        " 1136 |   // Visual size scales smoothly with zoom.",
        ">1137 |   const computedHandleSize = Math.max(6, 10 / Math.sqrt(scale));",
        " 1138 |   const computedRotationOffset = -Math.max(40, 30);",
        "",
        "Nothing was applied. Fix the hunks and resubmit.",
      ].join("\n"),
    )

    expect(parsed.stack).toEqual([])
    expect(parsed.blocks.map((block) => block.kind)).toEqual(["text", "code", "text", "code", "text"])

    const excerpt = parsed.blocks[3]!
    if (excerpt.kind !== "code") throw new Error("unreachable")
    expect(excerpt.lines.map((line) => line.number)).toEqual(["1136", "1137", "1138"])
    expect(excerpt.lines.filter((line) => line.marker).map((line) => line.number)).toEqual(["1137"])
  })

  test("still detects a real stack trace", () => {
    const parsed = parseToolError(
      [
        "TypeError: Cannot read properties of undefined (reading 'id')",
        "    at resolve (/repo/src/resolve.ts:12:9)",
        "    at async handle (/repo/src/handle.ts:44:3)",
        "    at async /repo/src/main.ts:8:1",
      ].join("\n"),
    )
    expect(parsed.type).toBe("TypeError")
    expect(parsed.stack).toHaveLength(3)
    expect(parsed.blocks).toHaveLength(1)
  })

  test("keeps a one-frame tail inline rather than hiding it", () => {
    expect(parseToolError("ENOENT: no such file\n    at open (fs.ts:1:1)").stack).toEqual([])
  })

  test("splits model-facing remediation off the end", () => {
    const parsed = parseToolError(
      "oldString cannot be empty when editing an existing file.\nPlease provide the exact text to replace.",
    )
    expect(parsed.hints).toEqual(["Please provide the exact text to replace."])
    expect(parsed.blocks).toHaveLength(1)
  })
})

describe("looksLikeMarkdown", () => {
  test("rejects tool output that merely contains punctuation", () => {
    expect(looksLikeMarkdown('<job id="job_1" status="running">\nKind: shell\n</job>')).toBe(false)
    expect(looksLikeMarkdown("Found 3 matches\nsrc/a.ts:\n  Line 4: const x = a * b * c")).toBe(false)
  })

  test("accepts documents with unambiguous structure", () => {
    expect(looksLikeMarkdown("# Title\n\n## Section\n\ntext")).toBe(true)
    expect(looksLikeMarkdown("intro\n\n```ts\nconst a = 1\n```")).toBe(true)
  })
})

describe("parseToolText", () => {
  test("unwraps a tag and turns its body into fields", () => {
    const parsed = parseToolText(
      [
        '<job id="job_069" status="running" kind="shell">',
        "<command>npx tsx scripts/run.ts</command>",
        "Kind: shell",
        "Status: running",
        "Started: 2026-09-03T21:06:43.594Z",
        "</job>",
      ].join("\n"),
    )
    expect(parsed.tag).toBe("job")
    expect(parsed.attrs.map((a) => a.key)).toEqual(["id", "status", "kind"])
    const fields = parsed.blocks.find((block) => block.kind === "fields")
    if (fields?.kind !== "fields") throw new Error("unreachable")
    expect(fields.items.map((item) => item.key)).toEqual(["Kind", "Status", "Started"])
  })

  test("keeps a single Key: value line as prose rather than a one-row grid", () => {
    expect(parseToolText("Killed job job_1. Status: cancelled.").blocks).toEqual([
      { kind: "text", text: "Killed job job_1. Status: cancelled." },
    ])
  })

  test("preserves the alignment of a fixed-width table", () => {
    const table = "Job                Status\njob_1              running"
    expect(parseToolText(table).blocks).toEqual([{ kind: "text", text: table }])
  })
})

describe("parseSkillNotice", () => {
  test("splits a not-found miss into message, roster, and model hints", () => {
    const parsed = parseSkillNotice(
      [
        'Skill "upstream-sync" not found. Not in local skills folders or registered.',
        "Available: docs, review",
        "",
        "Available skills (project folders + previously imported paths):",
        "- docs: Write documentation.",
        "- review: Review a diff.",
        "",
        'Use skill({ mode: "list" }) to list all.',
      ].join("\n"),
    )!
    expect(parsed.message).toBe('Skill "upstream-sync" not found. Not in local skills folders or registered.')
    // The roster arrives twice; the described copy wins and nothing duplicates.
    expect(parsed.items).toEqual([
      { name: "docs", description: "Write documentation." },
      { name: "review", description: "Review a diff." },
    ])
    expect(parsed.hints).toHaveLength(1)
  })
})

describe("parseTypecheck", () => {
  test("groups diagnostics by file and reads the triage tiers", () => {
    const parsed = parseTypecheck(
      [
        '<typecheck status="failed">',
        "<triage><p0>1</p0><p1>0</p1><p2>1</p2><p3>0</p3></triage>",
        "<diagnostics>",
        '<diagnostic file="src/a.ts" line="3" column="9" code="TS2304" severity="error">',
        "<message>Cannot find name &#39;x&#39;.</message><suggestion>Declare it.</suggestion>",
        "</diagnostic>",
        '<diagnostic file="src/a.ts" line="8" column="1" code="TS2322" severity="error">',
        "<message>Type mismatch.</message><suggestion>Fix the type.</suggestion>",
        "</diagnostic>",
        "</diagnostics>",
        "</typecheck>",
      ].join("\n"),
    )!
    expect(parsed.status).toBe("failed")
    expect(parsed.diagnostics).toHaveLength(2)
    expect(parsed.groups).toHaveLength(1)
    expect(parsed.groups[0]!.file).toBe("src/a.ts")
    expect(parsed.diagnostics[0]!.message).toBe("Cannot find name 'x'.")
    expect(parsed.tiers).toEqual([
      { tier: "P0", count: 1 },
      { tier: "P2", count: 1 },
    ])
  })

  test("returns undefined for output that is not a typecheck run", () => {
    expect(parseTypecheck("no errors")).toBeUndefined()
  })
})

describe("parseJobBlock", () => {
  test("separates the command, the fields, and the output tail", () => {
    const parsed = parseJobBlock(
      [
        '<job id="job_1" status="running" kind="shell">',
        "<command>npm run build</command>",
        "Kind: shell",
        "Status: running",
        "Log: /tmp/job_1.log",
        "",
        "Output tail:",
        "building...",
        "done",
        "</job>",
      ].join("\n"),
    )!
    expect(parsed.attrs.status).toBe("running")
    expect(parsed.command).toBe("npm run build")
    expect(parsed.fields.map((f) => f.key)).toEqual(["Kind", "Status", "Log"])
    expect(parsed.tail).toBe("building...\ndone")
  })
})

describe("parseGit", () => {
  test("reads status entries", () => {
    const parsed = parseGit(
      "status",
      "<status><entry> M src/a.ts</entry><entry>?? src/b.ts</entry></status>",
    )!
    expect(parsed.mode).toBe("status")
    if (parsed.mode !== "status") throw new Error("unreachable")
    expect(parsed.entries).toEqual([
      { code: " M", path: "src/a.ts" },
      { code: "??", path: "src/b.ts" },
    ])
  })

  test("treats a clean tree as zero entries rather than a parse failure", () => {
    const parsed = parseGit("status", '<status clean="true" />')!
    if (parsed.mode !== "status") throw new Error("unreachable")
    expect(parsed.entries).toEqual([])
  })

  test("reads the log", () => {
    const parsed = parseGit("log", "<log>abc123 (HEAD) first\ndef456 second</log>")!
    if (parsed.mode !== "log") throw new Error("unreachable")
    expect(parsed.commits).toEqual(["abc123 (HEAD) first", "def456 second"])
  })
})
