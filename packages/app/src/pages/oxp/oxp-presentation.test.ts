import { describe, expect, test } from "bun:test"
import type { OxpActivityStatus, OxpInvocationInfo } from "@opencode-ai/sdk/v2/client"
import { dict } from "@/i18n/en"
import {
  ascending,
  effectiveTool,
  formatBytes,
  formatDuration,
  invocationFacts,
  linkKindKey,
  matchesFilter,
  matchesQuery,
  relativePhrase,
  statusKey,
  timelineEntries,
  toolIdentity,
  toolStatus,
  type OxpFilter,
  type Phrase,
} from "./oxp-presentation"

const STATUSES: OxpActivityStatus[] = [
  "running",
  "success",
  "committed",
  "cancelled_before_commit",
  "cancelled_after_commit",
  "denied",
  "conflict",
  "failed",
  "ambiguous_external_result",
  "interrupted",
]

const LINK_KINDS: OxpInvocationInfo["links"][number]["kind"][] = [
  "session",
  "worker_session",
  "worker_group",
  "scheduled_task",
  "process",
  "root",
  "external_mcp",
  "file_transfer",
]

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

function keysOf(phrase: Phrase) {
  return phrase.kind === "text" ? [] : [phrase.key]
}

describe("i18n key coverage", () => {
  const known = new Set(Object.keys(dict))

  test("every status maps to a dictionary key", () => {
    for (const status of STATUSES) expect(known.has(statusKey(status))).toBe(true)
  })

  test("every link kind maps to a dictionary key", () => {
    for (const kind of LINK_KINDS) expect(known.has(linkKindKey(kind))).toBe(true)
  })

  test("every plane maps to a dictionary key", () => {
    for (const plane of ["augmentation", "supervision", "delegation"])
      expect(known.has(`oxpActivity.plane.${plane}`)).toBe(true)
  })

  test("every process action maps to a tool title", () => {
    // `start` renders as "Command"; the rest get their own verb.
    for (const action of ["poll", "write", "list", "status", "wait", "kill", "remove"]) {
      const identity = toolIdentity(invocation({ tool: "process", action }))
      for (const key of keysOf(identity.title)) expect(known.has(key)).toBe(true)
    }
  })

  test("tool identities and facts only emit known keys", () => {
    const tools = [
      "read",
      "find",
      "edit",
      "write",
      "patch",
      "process",
      "git",
      "openfork_worker",
      "openfork_session",
      "openfork_request",
      "openfork_info",
      "openai_files",
      "capability",
      "mystery_tool",
    ]
    for (const tool of tools) {
      const item = invocation({ tool, safeSummary: { count: 2, lines: 3, workerCount: 2, exitCode: 1, fileCount: 2 } })
      for (const key of keysOf(toolIdentity(item).title)) expect(known.has(key)).toBe(true)
      for (const fact of invocationFacts(item).facts)
        for (const key of keysOf(fact)) expect(known.has(key) || known.has(`${key}.other`)).toBe(true)
    }
  })

  test("relative stamps only emit known keys", () => {
    const now = 10 * 86_400_000
    for (const at of [now, now - 5 * 60_000, now - 5 * 3_600_000, now - 3 * 86_400_000])
      for (const key of keysOf(relativePhrase(at, now))) expect(known.has(key)).toBe(true)
  })
})

describe("formatting", () => {
  test("durations stay compact across scales", () => {
    expect(formatDuration(0)).toBe("0ms")
    expect(formatDuration(84)).toBe("84ms")
    expect(formatDuration(1_240)).toBe("1.2s")
    expect(formatDuration(6_500)).toBe("6.5s")
    expect(formatDuration(42_000)).toBe("42s")
    expect(formatDuration(124_000)).toBe("2m 04s")
    expect(formatDuration(3_780_000)).toBe("1h 03m")
    expect(formatDuration(Number.NaN)).toBe("—")
  })

  test("bytes round the way a reader expects", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(20480)).toBe("20 KB")
  })
})

describe("tool identity", () => {
  test("a read shows its path and truncates from the left", () => {
    const identity = toolIdentity(invocation({ tool: "read", safeSummary: { path: "/app/src/pages/session.tsx" } }))
    expect(identity.icon).toBe("glasses")
    expect(identity.subtitle).toBe("/app/src/pages/session.tsx")
    expect(identity.subtitleTruncate).toBe("start")
  })

  test("a directory read becomes a list", () => {
    const identity = toolIdentity(invocation({ tool: "read", safeSummary: { path: "/app/src", directory: true } }))
    expect(identity.icon).toBe("bullet-list")
  })

  test("a grep shows the pattern in mono, a glob says so", () => {
    const grep = toolIdentity(invocation({ tool: "find", safeSummary: { kind: "grep", pattern: "invocationDetail" } }))
    expect(grep.subtitle).toBe("invocationDetail")
    expect(grep.subtitleMono).toBe(true)
    const glob = toolIdentity(invocation({ tool: "find", safeSummary: { kind: "glob", pattern: "**/*.tsx" } }))
    expect(glob.title).toEqual({ kind: "t", key: "oxpActivity.tool.findFiles", params: undefined })
  })

  test("a process row degrades to the workdir until the command is cached", () => {
    const item = invocation({ tool: "process", action: "start", safeSummary: { workdir: "/repo" } })
    expect(toolIdentity(item).subtitle).toBe("/repo")
    expect(toolIdentity(item, { command: "bun test packages/core" }).subtitle).toBe("bun test packages/core")
  })

  test("a capability call presents as the tool it proxies", () => {
    expect(effectiveTool("capability", "git.status")).toBe("git")
    expect(effectiveTool("capability", "memory.search")).toBe("capability")
    expect(effectiveTool("read", undefined)).toBe("read")
    const identity = toolIdentity(
      invocation({ tool: "capability", safeSummary: { namespace: "openfork", capability: "process.start" } }),
    )
    expect(identity.icon).toBe("console")
  })

  test("an unknown tool still gets a readable title", () => {
    const identity = toolIdentity(invocation({ tool: "openfork_mystery_thing" }))
    expect(identity.title).toEqual({ kind: "text", value: "Mystery Thing" })
  })
})

describe("outcome facts", () => {
  test("a search reports its match count", () => {
    const facts = invocationFacts(invocation({ tool: "find", safeSummary: { kind: "grep", count: 24 } }))
    expect(facts.facts[0]).toEqual({ kind: "plural", key: "oxpActivity.result.matches", count: 24 })
  })

  test("a zero-match search is still reported, not hidden", () => {
    const facts = invocationFacts(invocation({ tool: "find", safeSummary: { kind: "grep", count: 0 } }))
    expect(facts.facts[0]).toEqual({ kind: "plural", key: "oxpActivity.result.matches", count: 0 })
  })

  test("an edit reports diff counts instead of prose", () => {
    const facts = invocationFacts(
      invocation({ tool: "edit", safeSummary: { files: [{ path: "a.ts", additions: 18, deletions: 7 }] } }),
    )
    expect(facts.changes).toEqual({ additions: 18, deletions: 7 })
  })

  test("a failed call leads with its error code, humanised", () => {
    const facts = invocationFacts(invocation({ status: "failed", errorCode: "OXP_AUTH_DENIED" }))
    expect(facts.facts[0]).toEqual({ kind: "text", value: "Auth denied" })
  })

  test("a process reports its exit code and a running one says so", () => {
    expect(invocationFacts(invocation({ tool: "process", safeSummary: { exitCode: 1 } })).facts).toContainEqual({
      kind: "t",
      key: "oxpActivity.result.exit",
      params: { code: 1 },
    })
    expect(invocationFacts(invocation({ tool: "process", safeSummary: { running: true } })).facts).toContainEqual({
      kind: "t",
      key: "oxpActivity.result.running",
      params: undefined,
    })
  })

  test("facts stay bounded so the row cannot wrap", () => {
    const facts = invocationFacts(
      invocation({
        tool: "process",
        errorCode: "OXP_CONFLICT",
        safeSummary: { exitCode: 1, outputBytes: 4096, truncated: true },
      }),
    )
    expect(facts.facts.length).toBeLessThanOrEqual(3)
  })
})

describe("status mapping", () => {
  test("BasicTool statuses collapse to running / error / completed", () => {
    expect(toolStatus({ status: "running" })).toBe("running")
    expect(toolStatus({ status: "denied" })).toBe("error")
    expect(toolStatus({ status: "interrupted" })).toBe("error")
    expect(toolStatus({ status: "committed" })).toBe("completed")
  })
})

describe("filtering", () => {
  const rows = [
    invocation({ id: "a", tool: "read", safeSummary: { path: "/app/foo.ts" } }),
    invocation({ id: "b", tool: "edit", mutationCommitted: true, safeSummary: { files: [{ path: "/app/foo.ts" }] } }),
    invocation({ id: "c", tool: "openfork_worker", plane: "delegation" }),
    invocation({ id: "d", tool: "process", status: "failed", errorCode: "OXP_CONFLICT" }),
    invocation({
      id: "e",
      tool: "read",
      links: [{ kind: "worker_session", ref: "ses_1", relation: "observed" }],
    }),
  ]

  const ids = (filter: OxpFilter) => rows.filter((row) => matchesFilter(row, filter)).map((row) => row.id)

  test("tools excludes worker-linked and non-augmentation work", () => {
    expect(ids("tools")).toEqual(["a", "b", "d"])
  })

  test("workers picks up both the delegation plane and worker links", () => {
    expect(ids("workers")).toEqual(["c", "e"])
  })

  test("changes only matches mutations", () => {
    expect(ids("changes")).toEqual(["b"])
  })

  test("errors only matches failure statuses", () => {
    expect(ids("errors")).toEqual(["d"])
  })

  test("free text searches the compact projection only", () => {
    expect(matchesQuery(rows[0]!, "foo.ts")).toBe(true)
    expect(matchesQuery(rows[0]!, "FOO.TS")).toBe(true)
    expect(matchesQuery(rows[0]!, "")).toBe(true)
    expect(matchesQuery(rows[0]!, "nothing")).toBe(false)
    expect(matchesQuery(rows[4]!, "ses_1")).toBe(true)
  })
})

describe("timeline", () => {
  test("reads oldest first, the way a session does", () => {
    const out = ascending([invocation({ id: "b", startedAt: 20 }), invocation({ id: "a", startedAt: 10 })])
    expect(out.map((row) => row.id)).toEqual(["a", "b"])
  })

  test("a day rule opens the transcript and repeats across midnight", () => {
    const day1 = new Date(2026, 0, 1, 10).getTime()
    const day2 = new Date(2026, 0, 2, 10).getTime()
    const entries = timelineEntries(
      ascending([
        invocation({ id: "a", startedAt: day1, completedAt: day1 + 10 }),
        invocation({ id: "b", startedAt: day2, completedAt: day2 + 10 }),
      ]),
    )
    expect(entries.filter((entry) => entry.kind === "day")).toHaveLength(2)
  })

  test("a host restart is a rule, an epoch change is a rule, and both are not", () => {
    const base = new Date(2026, 0, 1, 10).getTime()
    const entries = timelineEntries([
      invocation({ id: "a", startedAt: base, completedAt: base + 1, hostRunID: "r1", observedEpoch: 1 }),
      invocation({ id: "b", startedAt: base + 2, completedAt: base + 3, hostRunID: "r1", observedEpoch: 2 }),
      invocation({ id: "c", startedAt: base + 4, completedAt: base + 5, hostRunID: "r2", observedEpoch: 3 }),
    ])
    const markers = entries.filter((entry) => entry.kind === "marker")
    expect(markers).toHaveLength(2)
    expect(markers[0]).toMatchObject({ label: { key: "oxpActivity.divider.epoch" } })
    expect(markers[1]).toMatchObject({ label: { key: "oxpActivity.divider.hostRun" } })
  })

  test("a handoff advisory gets its own rule", () => {
    const base = new Date(2026, 0, 1, 10).getTime()
    const entries = timelineEntries([
      invocation({ id: "a", startedAt: base, completedAt: base + 1, continuityMarker: "handoff_advisory" }),
    ])
    expect(entries.some((entry) => entry.kind === "marker" && entry.label.kind === "t" && entry.label.key === "oxpActivity.divider.handoff")).toBe(
      true,
    )
  })

  test("overlapping calls are flagged, not laid out in lanes", () => {
    const base = new Date(2026, 0, 1, 10).getTime()
    const entries = timelineEntries([
      invocation({ id: "a", startedAt: base, completedAt: base + 1000 }),
      invocation({ id: "b", startedAt: base + 500, completedAt: base + 900 }),
      invocation({ id: "c", startedAt: base + 2000, completedAt: base + 2100 }),
    ])
    const rows = entries.filter((entry) => entry.kind === "invocation")
    expect(rows.map((row) => (row as { concurrent: boolean }).concurrent)).toEqual([false, true, false])
  })

  test("a long-lived running call does not paint the rest of the transcript", () => {
    // A background process that never settles would otherwise flag every row
    // beneath it forever; the running row already reads as running.
    const base = new Date(2026, 0, 1, 10).getTime()
    const entries = timelineEntries([
      invocation({ id: "a", startedAt: base, completedAt: undefined, status: "running" }),
      invocation({ id: "b", startedAt: base + 500, completedAt: base + 900 }),
      invocation({ id: "c", startedAt: base + 5_000, completedAt: base + 5_100 }),
    ])
    const rows = entries.filter((entry) => entry.kind === "invocation")
    expect(rows.map((row) => (row as { concurrent: boolean }).concurrent)).toEqual([false, false, false])
  })

  test("a settled long call still flags the calls that overlapped it", () => {
    const base = new Date(2026, 0, 1, 10).getTime()
    const entries = timelineEntries([
      invocation({ id: "a", startedAt: base, completedAt: base + 6_000 }),
      invocation({ id: "b", startedAt: base + 900, completedAt: base + 1_100 }),
      invocation({ id: "c", startedAt: base + 7_000, completedAt: base + 7_100 }),
    ])
    const rows = entries.filter((entry) => entry.kind === "invocation")
    expect(rows.map((row) => (row as { concurrent: boolean }).concurrent)).toEqual([false, true, false])
  })

  // The timeline caches entry wrappers by id so a live refresh re-creates only
  // the rows that actually changed instead of collapsing every expanded call.
  // That cache is only sound while ids are unique within a render and stable
  // across renders of the same transcript.
  test("entry ids are unique and stable across renders", () => {
    const base = new Date(2026, 0, 1, 10).getTime()
    const items = [
      invocation({ id: "a", startedAt: base, completedAt: base + 10, observedEpoch: 1 }),
      invocation({
        id: "b",
        startedAt: base + 20,
        completedAt: base + 30,
        observedEpoch: 2,
        continuityMarker: "handoff_advisory",
      }),
      invocation({ id: "c", startedAt: base + 40, hostRunID: "run_2", status: "running", completedAt: undefined }),
    ]
    const ids = timelineEntries(items).map((entry) => entry.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(timelineEntries(items).map((entry) => entry.id)).toEqual(ids)
    // A call settling must not renumber the entries around it.
    const settled = items.map((item) =>
      item.id === "c" ? invocation({ ...item, status: "success", completedAt: base + 60 }) : item,
    )
    expect(timelineEntries(settled).map((entry) => entry.id)).toEqual(ids)
  })
})
