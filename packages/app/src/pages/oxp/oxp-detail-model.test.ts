import { describe, expect, test } from "bun:test"
import type { OxpInvocationDetailInfo, OxpInvocationInfo } from "@opencode-ai/sdk/v2/client"
import { dict } from "@/i18n/en"
import { buildDetail, countDiff, detailHints, splitUnifiedDiff, type DetailSection } from "./oxp-detail-model"
import type { Phrase } from "./oxp-presentation"

function invocation(over: Partial<OxpInvocationInfo> = {}): OxpInvocationInfo {
  return {
    id: "inv_1",
    activityID: "oxpa_1",
    hostRunID: "run_1",
    plane: "augmentation",
    tool: "read",
    status: "success",
    mutationAttempted: false,
    mutationCommitted: false,
    startedAt: 1_000,
    completedAt: 1_200,
    links: [],
    ...over,
  } as OxpInvocationInfo
}

const detail = (request?: unknown, outcome?: unknown): OxpInvocationDetailInfo =>
  ({
    invocationID: "inv_1",
    ...(request === undefined ? {} : { request: request as Record<string, unknown> }),
    ...(outcome === undefined ? {} : { outcome: outcome as Record<string, unknown> }),
  }) as OxpInvocationDetailInfo

const kinds = (sections: DetailSection[]) => sections.map((section) => section.kind)
const find = <K extends DetailSection["kind"]>(sections: DetailSection[], kind: K) =>
  sections.find((section): section is Extract<DetailSection, { kind: K }> => section.kind === kind)

function collectKeys(sections: DetailSection[]): string[] {
  const keys: string[] = []
  const push = (phrase: Phrase | undefined) => {
    if (phrase && phrase.kind !== "text") keys.push(phrase.key)
  }
  for (const section of sections) {
    if ("label" in section) push(section.label as Phrase | undefined)
    if (section.kind === "fields") for (const item of section.items) push(item.label)
    if (section.kind === "stats") for (const item of section.items) push(item.label)
    if (section.kind === "notice") push(section.message)
  }
  return keys
}

describe("no detail captured", () => {
  test("an invocation older than capture is empty, not an error", () => {
    const model = buildDetail(invocation(), undefined)
    expect(model.empty).toBe(true)
    expect(model.sections).toHaveLength(0)
  })

  test("a row with a detail record but no payload is still empty", () => {
    const model = buildDetail(invocation(), detail())
    expect(model.empty).toBe(true)
  })

  test("diagnostics exist even with no payload", () => {
    const model = buildDetail(invocation({ rootAlias: "openfork", observedEpoch: 3 }), undefined)
    const values = model.diagnostics.map((item) => item.value)
    expect(values).toContain("openfork")
    expect(values).toContain("3")
    expect(values).toContain("inv_1")
  })
})

describe("process", () => {
  const request = { args: { action: "start", rootID: "root_1", command: "bun test packages/core", workdir: "/repo" } }
  const outcome = {
    title: "bun test packages/core",
    output: "12 pass\n0 fail\n",
    structured: { handle: "proc_1", running: false, exitCode: 0, outputBytes: 16, output: "12 pass\n0 fail\n" },
    metadata: { handle: "proc_1", workdir: "/repo", mode: "foreground", running: false, exitCode: 0, outputBytes: 16, startedAt: 10, endedAt: 6510 },
  }

  test("the command gets its own block, not a JSON dump", () => {
    const model = buildDetail(invocation({ tool: "process", action: "start" }), detail(request, outcome))
    const command = find(model.sections, "command")
    expect(command?.command).toBe("bun test packages/core")
    expect(kinds(model.sections)).not.toContain("params")
  })

  test("exit code and duration become a stats strip", () => {
    const model = buildDetail(invocation({ tool: "process" }), detail(request, outcome))
    const stats = find(model.sections, "stats")
    expect(stats?.items.map((item) => item.value)).toContain("0")
    expect(stats?.items.map((item) => item.value)).toContain("6.5s")
  })

  test("output renders as a log, not as prose", () => {
    const model = buildDetail(invocation({ tool: "process" }), detail(request, outcome))
    expect(find(model.sections, "log")?.body).toBe("12 pass\n0 fail\n")
  })

  test("a JSON status body is not mistaken for a log", () => {
    const model = buildDetail(
      invocation({ tool: "process", action: "status" }),
      detail({ args: { action: "status", handle: "proc_1" } }, { output: '{"handle":"proc_1"}', metadata: { handle: "proc_1" } }),
    )
    expect(kinds(model.sections)).not.toContain("log")
  })

  test("process.list becomes a row list", () => {
    const model = buildDetail(
      invocation({ tool: "process", action: "list" }),
      detail(
        { args: { action: "list", rootID: "root_1" } },
        { structured: { processes: [{ handle: "proc_1", workdir: "/repo", running: true }] } },
      ),
    )
    const rows = find(model.sections, "rows")
    expect(rows?.rows[0]).toMatchObject({ primary: "proc_1", trailing: "running" })
  })

  test("the command is recoverable for the collapsed row", () => {
    expect(detailHints(invocation({ tool: "process" }), detail(request, outcome))).toEqual({
      command: "bun test packages/core",
    })
  })
})

describe("find", () => {
  test("a grep routes to the grep renderer and keeps its pattern", () => {
    const model = buildDetail(
      invocation({ tool: "find" }),
      detail(
        { args: { grep: "invocationDetail", path: "/app", include: "*.ts" } },
        { output: "Found 2 matches\napp/a.ts:\n  Line 1: invocationDetail", metadata: { action: "grep", count: 2, root: "openfork" } },
      ),
    )
    const grep = find(model.sections, "grep")
    expect(grep?.pattern).toBe("invocationDetail")
    expect(kinds(model.sections)).not.toContain("glob")
  })

  test("a glob routes to the glob renderer", () => {
    const model = buildDetail(
      invocation({ tool: "find" }),
      detail({ args: { glob: "**/*.tsx" } }, { output: "a.tsx\nb.tsx", metadata: { action: "glob", count: 2 } }),
    )
    expect(kinds(model.sections)).toContain("glob")
  })

  test("the query is recoverable for the collapsed row", () => {
    expect(detailHints(invocation({ tool: "find" }), detail({ args: { grep: "needle" } }, {}))).toEqual({
      query: "needle",
    })
  })

  test("truncated results get a notice", () => {
    const model = buildDetail(
      invocation({ tool: "find" }),
      detail({ args: { grep: "x" } }, { output: "Found 1 matches", metadata: { action: "grep", truncated: true } }),
    )
    expect(find(model.sections, "notice")?.message).toMatchObject({ key: "oxpActivity.detail.resultsTruncated" })
  })
})

describe("read", () => {
  test("a file read becomes a content window", () => {
    const model = buildDetail(
      invocation({ tool: "read" }),
      detail(
        { args: { path: "/app/a.ts", offset: 140, limit: 120 } },
        { output: '<path lines="900">/app/a.ts</path>\n<type>file</type>\n<content>\n140: const a = 1\n</content>', metadata: { action: "read", path: "/app/a.ts", lines: 900 } },
      ),
    )
    expect(kinds(model.sections)).toContain("readWindow")
    const fields = find(model.sections, "fields")
    expect(fields?.items.map((item) => item.value)).toContain("140–259")
  })

  test("a batched read lists its targets as rows", () => {
    const model = buildDetail(
      invocation({ tool: "read" }),
      detail({ args: { reads: [{ path: "/a.ts" }, { path: "/b.ts", offset: 10, limit: 5 }] } }, {}),
    )
    const rows = find(model.sections, "rows")
    expect(rows?.rows.map((row) => row.primary)).toEqual(["/a.ts", "/b.ts"])
    expect(rows?.rows[1]?.trailing).toBe("10–14")
  })

  test("an attachment says so instead of rendering nothing", () => {
    const model = buildDetail(
      invocation({ tool: "read" }),
      detail({ args: { path: "/a.png" } }, { output: "Image attachment available", metadata: { attachment: true } }),
    )
    expect(find(model.sections, "notice")?.message).toMatchObject({ key: "oxpActivity.detail.attachment" })
  })
})

describe("edit and write", () => {
  const patch = `Index: /app/a.ts\n===\n--- /app/a.ts\n+++ /app/a.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n`

  test("a committed edit renders the recorded diff", () => {
    const model = buildDetail(
      invocation({ tool: "edit", mutationCommitted: true }),
      detail({ args: { path: "/app/a.ts" } }, { metadata: { path: "/app/a.ts", strategy: "exact", applied: 1, diff: patch } }),
    )
    const diff = find(model.sections, "diff")
    expect(diff?.path).toBe("/app/a.ts")
    expect(diff?.additions).toBe(1)
    expect(diff?.deletions).toBe(1)
  })

  test("a rejected edit still shows what was asked for, as a diff", () => {
    const model = buildDetail(
      invocation({ tool: "edit", status: "conflict" }),
      detail({ args: { path: "/app/a.ts", oldString: "a", newString: "b" } }, { metadata: { path: "/app/a.ts", applied: 0, diff: "" } }),
    )
    const diff = find(model.sections, "diff")
    expect(diff?.before).toBe("a")
    expect(diff?.after).toBe("b")
  })

  test("edit warnings surface as hints, not as a metadata blob", () => {
    const model = buildDetail(
      invocation({ tool: "edit" }),
      detail({ args: { path: "/a.ts" } }, { metadata: { path: "/a.ts", diff: patch, warnings: ["no read grounding"] } }),
    )
    expect(find(model.sections, "notice")?.hints).toEqual(["no read grounding"])
  })

  test("a write with no recorded diff falls back to the written content", () => {
    const model = buildDetail(
      invocation({ tool: "write" }),
      detail({ args: { path: "/a.ts", content: "export const a = 1\n" } }, { metadata: { path: "/a.ts", exists: false, changed: true, diff: "" } }),
    )
    const code = find(model.sections, "code")
    expect(code?.filename).toBe("/a.ts")
    expect(code?.body).toBe("export const a = 1\n")
  })

  test("a new file is reported as created", () => {
    const model = buildDetail(
      invocation({ tool: "write" }),
      detail({ args: { path: "/a.ts" } }, { metadata: { path: "/a.ts", exists: false, changed: true, diff: patch } }),
    )
    expect(find(model.sections, "diff")?.status).toBe("added")
  })
})

describe("patch", () => {
  const combined =
    `Index: /a.ts\n--- /a.ts\n+++ /a.ts\n@@ -1 +1 @@\n-a\n+b\n` + `Index: /b.ts\n--- /b.ts\n+++ /b.ts\n@@ -1 +1 @@\n-c\n+d\n`

  test("a combined diff splits into one viewer per file", () => {
    expect(splitUnifiedDiff(combined).map((chunk) => chunk.path)).toEqual(["/a.ts", "/b.ts"])
  })

  test("each touched file gets its own diff section", () => {
    const model = buildDetail(
      invocation({ tool: "patch", mutationCommitted: true }),
      detail(
        { args: { patchText: "…", format: "git" } },
        {
          metadata: {
            format: "git",
            fileCount: 2,
            applied: true,
            diff: combined,
            files: [
              { type: "update", path: "/a.ts", additions: 1, deletions: 1 },
              { type: "update", path: "/b.ts", additions: 1, deletions: 1 },
            ],
          },
        },
      ),
    )
    expect(kinds(model.sections).filter((kind) => kind === "diff")).toHaveLength(2)
  })

  test("a dry run with no diff lists the planned files", () => {
    const model = buildDetail(
      invocation({ tool: "patch" }),
      detail(
        { args: { patchText: "…", apply: false } },
        { metadata: { format: "git", fileCount: 1, applied: false, files: [{ type: "add", path: "/c.ts", additions: 3, deletions: 0 }] } },
      ),
    )
    const rows = find(model.sections, "rows")
    expect(rows?.rows[0]).toMatchObject({ primary: "/c.ts", trailing: "+3 −0" })
  })

  test("a move renders its destination", () => {
    const model = buildDetail(
      invocation({ tool: "patch" }),
      detail({ args: {} }, { metadata: { files: [{ type: "move", path: "/a.ts", movePath: "/b.ts" }] } }),
    )
    expect(find(model.sections, "rows")?.rows[0]?.primary).toBe("/a.ts → /b.ts")
  })
})

describe("git", () => {
  test("git output routes to the timeline's own git renderer with its mode", () => {
    const model = buildDetail(
      invocation({ tool: "git" }),
      detail({ args: { mode: "status" } }, { output: "<status>\n M a.ts\n</status>", metadata: { mode: "status", ok: true, exitCode: 0, root: "/openfork" } }),
    )
    expect(find(model.sections, "git")).toMatchObject({ mode: "status" })
  })
})

describe("workers", () => {
  test("a roster renders as rows that can open the native session", () => {
    const model = buildDetail(
      invocation({ tool: "openfork_worker", plane: "delegation" }),
      detail(
        { args: { action: "list" } },
        { structured: { workers: [{ workerID: "ses_1", title: "Implement foo", agent: "build", execution: { running: true } }] } },
      ),
    )
    const rows = find(model.sections, "rows")
    expect(rows?.rows[0]).toMatchObject({ primary: "Implement foo", trailing: "running", sessionID: "ses_1" })
  })

  test("durable ownership is not rendered as live execution", () => {
    const model = buildDetail(
      invocation({ tool: "openfork_worker", plane: "delegation" }),
      detail(
        { args: { action: "list" } },
        {
          structured: {
            workers: [
              {
                workerID: "ses_1",
                title: "Implement foo",
                agent: "build",
                execution: { owned: true, generation: 3 },
              },
            ],
          },
        },
      ),
    )
    const rows = find(model.sections, "rows")
    expect(rows?.rows[0]).toMatchObject({ primary: "Implement foo", trailing: "owned", sessionID: "ses_1" })
  })

  test("a start request shows its prompt as prose", () => {
    const model = buildDetail(
      invocation({ tool: "openfork_worker" }),
      detail({ args: { action: "start", title: "Do the thing", prompt: "Please do the thing." } }, { structured: { workerID: "ses_2" } }),
    )
    expect(find(model.sections, "prose")?.body).toBe("Please do the thing.")
  })
})

describe("errors", () => {
  test("a failure renders an error panel and its code, not the success path", () => {
    const model = buildDetail(
      invocation({ tool: "process", status: "denied", errorCode: "OXP_AUTH_DENIED" }),
      detail({ args: { action: "start", command: "rm -rf /" } }, { error: { code: "OXP_AUTH_DENIED", message: "Root is not approved" } }),
    )
    expect(find(model.sections, "error")?.body).toBe("Root is not approved")
    expect(kinds(model.sections)).not.toContain("log")
    const values = model.sections.flatMap((section) => (section.kind === "fields" ? section.items.map((item) => item.value) : []))
    expect(values).toContain("Auth denied")
    // The request survives the failure: you can still see the command that was refused.
    expect(find(model.sections, "command")?.command).toBe("rm -rf /")
  })
})

describe("generic families", () => {
  test("an unmodelled array still becomes rows rather than JSON", () => {
    const model = buildDetail(
      invocation({ tool: "openfork_session" }),
      detail(
        { args: { action: "list" } },
        { structured: { sessions: [{ id: "ses_1", title: "Main" }, { id: "ses_2", title: "Side" }] } },
      ),
    )
    const rows = find(model.sections, "rows")
    expect(rows?.rows.map((row) => row.primary)).toEqual(["Main", "Side"])
  })

  test("an unmodelled tool's arguments become labelled chips, not a dump", () => {
    const model = buildDetail(
      invocation({ tool: "openfork_info" }),
      detail({ args: { action: "roots", verbose: true } }, { output: "ok" }),
    )
    expect(find(model.sections, "params")?.input).toEqual({ action: "roots", verbose: true })
  })
})

describe("capture limits", () => {
  test("a truncated capture is reported once, at the model level", () => {
    const model = buildDetail(
      invocation({ tool: "process" }),
      detail({ args: { command: "x" }, detailTruncated: true }, { output: "…" }),
    )
    expect(model.truncated).toBe(true)
  })
})

describe("diff counting", () => {
  test("file headers are not counted as changes", () => {
    expect(countDiff("--- a\n+++ b\n+x\n-y\n z")).toEqual({ additions: 1, deletions: 1 })
  })
})

describe("i18n key coverage", () => {
  const known = new Set(Object.keys(dict))

  test("every label the parser emits exists in the dictionary", () => {
    const models = [
      buildDetail(
        invocation({ tool: "process" }),
        detail({ args: { action: "start", command: "x", workdir: "/r", shell: "sh", timeoutMs: 1000, chars: "y" } }, { output: "out", metadata: { handle: "h", workdir: "/r", mode: "foreground", running: false, exitCode: 0, outputBytes: 2, startedAt: 1, endedAt: 2, retainedBytes: 4, truncated: true } }),
      ),
      buildDetail(
        invocation({ tool: "find" }),
        detail({ args: { grep: "x", path: "/p", include: "*.ts" } }, { output: "Found 0 matches", metadata: { action: "grep", count: 0, root: "r", truncated: true } }),
      ),
      buildDetail(invocation({ tool: "read" }), detail({ args: { path: "/a", offset: 1, limit: 2, action: "read" } }, { output: "x", metadata: { lines: 3, truncated: true } })),
      buildDetail(
        invocation({ tool: "edit" }),
        detail({ args: { path: "/a", line: 3, occurrence: 1, replaceAll: true, edits: [{ line: 1 }] } }, { metadata: { path: "/a", strategy: "exact", applied: 1, diff: "+a", warnings: ["w"] } }),
      ),
      buildDetail(invocation({ tool: "write" }), detail({ args: { path: "/a", content: "x" } }, { metadata: { path: "/a", exists: true, changed: true, diffTruncated: true } })),
      buildDetail(invocation({ tool: "patch" }), detail({ args: { patchText: "x", format: "git", apply: true } }, { metadata: { format: "git", applied: true, files: [{ type: "add", path: "/a" }] } })),
      buildDetail(invocation({ tool: "git" }), detail({ args: { mode: "log", workdir: "/w", ref: "HEAD", paths: ["/a"] } }, { output: "<log></log>", metadata: { mode: "log", exitCode: 0, root: "/r" } })),
      buildDetail(
        invocation({ tool: "openfork_worker" }),
        detail({ args: { action: "batch_start", title: "t", agent: "a", prompt: "p", workerID: "w", batchID: "b", model: { providerID: "p", modelID: "m" }, workers: [{ title: "x" }] } }, { structured: { workers: [{ workerID: "w", execution: { running: false } }], batchID: "b" } }),
      ),
      buildDetail(invocation({ tool: "openfork_session" }), detail({ args: { action: "prompt", sessionID: "s", text: "hi", agent: "a" } }, { structured: { sessionID: "s" } })),
      buildDetail(invocation({ tool: "capability" }), detail({ args: { action: "call", namespace: "mcp", capability: "a/b", args: { x: 1 } } }, { output: "ok" })),
      buildDetail(invocation({ tool: "process", status: "failed" }), detail({ args: {} }, { error: { code: "OXP_CONFLICT", message: "no", metadata: { detail: "x" } } })),
    ]
    for (const model of models) {
      for (const key of collectKeys(model.sections)) expect(known.has(key)).toBe(true)
      for (const item of model.diagnostics) {
        if (item.label.kind !== "text") expect(known.has(item.label.key)).toBe(true)
        if (typeof item.value !== "string" && item.value.kind !== "text") expect(known.has(item.value.key)).toBe(true)
      }
    }
  })
})
