import type { OxpInvocationDetailInfo, OxpInvocationInfo, OxpParentActivitySummary } from "@opencode-ai/sdk/v2/client"

/**
 * OXP activity lab fixtures. DEV-ONLY.
 *
 * Shapes are copied from the real producers — `packages/opencode/src/oxp/*`
 * results and `activity-recorder.ts`'s `safeSummary` / `invocationDetail`
 * projections — so what the lab renders is what the page renders in production.
 */

const START = new Date(2026, 8, 21, 14, 2, 0).getTime()

let cursor = START
let sequence = 0

function at(offsetMs: number) {
  cursor += offsetMs
  return cursor
}

function id() {
  sequence += 1
  return `inv_${String(sequence).padStart(3, "0")}`
}

function row(over: Partial<OxpInvocationInfo> & { durationMs?: number }): OxpInvocationInfo {
  const { durationMs = 120, ...rest } = over
  const startedAt = at(900)
  return {
    id: id(),
    activityID: "oxpa_lab",
    hostRunID: "run_a",
    observedEpoch: 1,
    plane: "augmentation",
    tool: "read",
    status: "success",
    mutationAttempted: false,
    mutationCommitted: false,
    startedAt,
    completedAt: startedAt + durationMs,
    links: [],
    ...rest,
  } as OxpInvocationInfo
}

export const LAB_ACTIVITY: OxpParentActivitySummary = {
  id: "oxpa_lab",
  title: "Wire the activity transcript",
  firstSeenAt: START,
  lastSeenAt: START + 41 * 60_000,
  callCount: 14,
  failureCount: 2,
  augmentationCalls: 11,
  supervisionCalls: 1,
  delegationCalls: 2,
  observedEpochCount: 2,
  lastTool: "process",
  lastRootAlias: "openfork",
}

const GREP_OUTPUT = [
  "Found 7 matches",
  "packages/app/src/context/oxp-activity.ts:",
  "  Line 12: type InvocationDetailState = {",
  "  Line 31: const MAX_CACHED_INVOCATION_DETAILS = 128",
  "  Line 284: const ensureInvocationDetail = (invocationID: string) => {",
  "",
  "packages/app/src/pages/oxp/oxp-detail-model.ts:",
  "  Line 3: import type { OxpInvocationDetailInfo } from \"@opencode-ai/sdk/v2/client\"",
  "  Line 411: export function buildDetail(item, detail): DetailModel {",
  "",
  "packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:",
  "  Line 749: const oxpInvocationDetail = Effect.fn(\"GlobalHttpApi.oxpInvocationDetail\")(",
  "  Line 753: const row = yield* oxpInspection.invocationDetail(ctx.params.invocationID)",
].join("\n")

const READ_OUTPUT = [
  '<path lines="513">/openfork/packages/app/src/context/oxp-activity.ts</path>',
  "<type>file</type>",
  "<content>",
  "284: const ensureInvocationDetail = (invocationID: string) => {",
  "285:   touchInvocationDetail(invocationID)",
  "286:   const current = state.invocationDetails[invocationID]",
  "287:   if (current?.loaded || current?.loading) return",
  "288:   const pending = invocationDetailRefreshes.get(invocationID)",
  "289:   if (pending) return",
  "290:   setState(\"invocationDetails\", invocationID, {",
  "291:     loaded: false,",
  "292:     loading: true,",
  "293:     error: undefined,",
  "294:   })",
  "",
  "(Showing lines 284-294 of 513. Use offset=295 to continue.)",
  "</content>",
].join("\n")

const PROCESS_OUTPUT = [
  "bun test v1.3.14 (0d9b296a)",
  "",
  "src\\pages\\oxp\\oxp-detail-model.test.ts:",
  "\u001b[32m(pass)\u001b[0m process > the command gets its own block, not a JSON dump [1.02ms]",
  "\u001b[32m(pass)\u001b[0m process > exit code and duration become a stats strip [0.41ms]",
  "\u001b[32m(pass)\u001b[0m read > a file read becomes a content window [0.33ms]",
  "",
  " 66 pass",
  " 0 fail",
  " 313 expect() calls",
  "Ran 66 tests across 2 files. [262.00ms]",
].join("\n")

const EDIT_DIFF = [
  "Index: /openfork/packages/app/src/pages/oxp-activity-page.tsx",
  "===================================================================",
  "--- /openfork/packages/app/src/pages/oxp-activity-page.tsx",
  "+++ /openfork/packages/app/src/pages/oxp-activity-page.tsx",
  "@@ -74,9 +74,12 @@",
  "   const ordered = createMemo(() => ascending(items()))",
  "-  const visible = createMemo(() => ordered())",
  "+  const visible = createMemo(() => {",
  "+    const active = filter()",
  "+    const needle = query()",
  "+    return ordered().filter((item) => matchesFilter(item, active) && matchesQuery(item, needle))",
  "+  })",
  "   const entries = createMemo(() => timelineEntries(visible()))",
  "",
].join("\n")

const PATCH_DIFF = [
  "Index: /openfork/packages/session-ui/src/components/search-results.tsx",
  "--- /openfork/packages/session-ui/src/components/search-results.tsx",
  "+++ /openfork/packages/session-ui/src/components/search-results.tsx",
  "@@ -1,3 +1,4 @@",
  "+import { createMemo, createSignal, For, Show } from \"solid-js\"",
  " import { useI18n } from \"@opencode-ai/ui/context/i18n\"",
  "",
  "Index: /openfork/packages/session-ui/src/components/message-part.tsx",
  "--- /openfork/packages/session-ui/src/components/message-part.tsx",
  "+++ /openfork/packages/session-ui/src/components/message-part.tsx",
  "@@ -2290,20 +2290,4 @@",
  "-function parseGrepOutput(output: string): GrepResult | undefined {",
  "-  const lines = output.split(\"\\n\")",
  "-  return { total, truncated, files }",
  "-}",
  "",
].join("\n")

/** Oldest first, exactly as the page orders them. */
export const LAB_INVOCATIONS: OxpInvocationInfo[] = [
  row({
    tool: "openfork_info",
    action: "roots",
    durationMs: 41,
    safeSummary: { action: "roots" },
    links: [{ kind: "root", ref: "root_1", relation: "observed", label: "openfork" }],
    rootAlias: "openfork",
  }),
  row({
    tool: "find",
    durationMs: 318,
    rootAlias: "openfork",
    safeSummary: { kind: "grep", pattern: "invocationDetail", root: "openfork", count: 7 },
  }),
  row({
    tool: "read",
    durationMs: 84,
    rootAlias: "openfork",
    safeSummary: { path: "/openfork/packages/app/src/context/oxp-activity.ts", lines: 513, offset: 284 },
  }),
  row({
    tool: "read",
    durationMs: 22,
    rootAlias: "openfork",
    safeSummary: { path: "/openfork/packages/app/src/pages/oxp", directory: true, entries: 9 },
  }),
  row({
    tool: "process",
    action: "start",
    durationMs: 6_482,
    rootAlias: "openfork",
    mutationAttempted: true,
    mutationCommitted: true,
    status: "committed",
    safeSummary: {
      action: "start",
      handle: "proc_7f21",
      workdir: "/packages/app",
      mode: "foreground",
      running: false,
      exitCode: 0,
      outputBytes: 2_118,
    },
    links: [{ kind: "process", ref: "proc_7f21", relation: "created" }],
  }),
  row({
    tool: "edit",
    durationMs: 137,
    rootAlias: "openfork",
    status: "committed",
    mutationAttempted: true,
    mutationCommitted: true,
    safeSummary: {
      strategy: "exact",
      applied: 1,
      changed: true,
      files: [
        {
          path: "/openfork/packages/app/src/pages/oxp-activity-page.tsx",
          type: "update",
          additions: 4,
          deletions: 1,
        },
      ],
    },
  }),
  row({
    tool: "patch",
    durationMs: 402,
    rootAlias: "openfork",
    status: "committed",
    mutationAttempted: true,
    mutationCommitted: true,
    safeSummary: {
      format: "git",
      fileCount: 2,
      applied: true,
      files: [
        { path: "/openfork/packages/session-ui/src/components/search-results.tsx", type: "add", additions: 1, deletions: 0 },
        { path: "/openfork/packages/session-ui/src/components/message-part.tsx", type: "update", additions: 0, deletions: 4 },
      ],
    },
  }),
  row({
    tool: "git",
    durationMs: 96,
    rootAlias: "openfork",
    safeSummary: { mode: "status", root: "/openfork", files: 3 },
  }),
  row({
    tool: "find",
    durationMs: 1_240,
    rootAlias: "openfork",
    status: "failed",
    errorCode: "OXP_INVALID_ARGUMENT",
    safeSummary: { kind: "grep", pattern: "(((" },
  }),
  row({
    tool: "openfork_worker",
    action: "start",
    plane: "delegation",
    durationMs: 812,
    rootAlias: "openfork",
    status: "committed",
    mutationAttempted: true,
    mutationCommitted: true,
    safeSummary: {
      action: "start",
      agent: "build",
      workerID: "ses_worker_1",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
    },
    links: [{ kind: "worker_session", ref: "ses_worker_1", relation: "created", label: "Rework the timeline rail" }],
  }),
  row({
    tool: "openfork_session",
    action: "prompt",
    plane: "supervision",
    durationMs: 244,
    rootAlias: "openfork",
    safeSummary: { action: "prompt", sessionID: "ses_main", agent: "build" },
    links: [{ kind: "session", ref: "ses_main", relation: "observed", label: "OXP activity overhaul" }],
  }),
  row({
    tool: "capability",
    action: "call",
    durationMs: 158,
    rootAlias: "openfork",
    safeSummary: { action: "call", namespace: "mcp", capability: "linear/list_issues" },
    links: [{ kind: "external_mcp", ref: "linear", relation: "observed", label: "linear" }],
  }),
  row({
    tool: "process",
    action: "poll",
    durationMs: 39,
    rootAlias: "openfork",
    status: "denied",
    errorCode: "OXP_AUTH_DENIED",
    safeSummary: { action: "poll", handle: "proc_dead" },
  }),
  row({
    tool: "process",
    action: "start",
    durationMs: 0,
    completedAt: undefined,
    status: "running",
    rootAlias: "openfork",
    continuityMarker: "handoff_advisory",
    safeSummary: { action: "start", workdir: "/packages/app", mode: "background", running: true },
  }),
]

/** Keyed by invocation id, exactly as `store.invocationDetail(id)` serves them. */
export const LAB_DETAILS: Record<string, OxpInvocationDetailInfo> = {
  inv_002: {
    invocationID: "inv_002",
    request: { args: { grep: "invocationDetail", path: "/packages", rootID: "root_1" } },
    outcome: {
      title: "invocationDetail",
      output: GREP_OUTPUT,
      metadata: { action: "grep", root: "openfork", count: 7, truncated: false },
    },
  },
  inv_003: {
    invocationID: "inv_003",
    request: { args: { path: "/packages/app/src/context/oxp-activity.ts", offset: 284, limit: 11, rootID: "root_1" } },
    outcome: {
      title: "/openfork/packages/app/src/context/oxp-activity.ts",
      output: READ_OUTPUT,
      metadata: { action: "read", path: "/openfork/packages/app/src/context/oxp-activity.ts", lines: 513, offset: 284, truncated: true },
    },
  },
  inv_005: {
    invocationID: "inv_005",
    request: {
      args: {
        action: "start",
        rootID: "root_1",
        command: "bun test src/pages/oxp --coverage",
        workdir: "/packages/app",
        mode: "foreground",
        timeoutMs: 120_000,
      },
    },
    outcome: {
      title: "bun test src/pages/oxp --coverage",
      output: PROCESS_OUTPUT,
      structured: { handle: "proc_7f21", running: false, exitCode: 0, outputBytes: 2_118, output: PROCESS_OUTPUT },
      metadata: {
        handle: "proc_7f21",
        workdir: "/packages/app",
        mode: "foreground",
        running: false,
        startedAt: 0,
        endedAt: 6_482,
        exitCode: 0,
        outputBytes: 2_118,
        truncated: false,
      },
      mutation: { attempted: true, committed: true },
    },
  },
  inv_006: {
    invocationID: "inv_006",
    request: {
      args: {
        path: "/packages/app/src/pages/oxp-activity-page.tsx",
        rootID: "root_1",
        oldString: "const visible = createMemo(() => ordered())",
        newString: "const visible = createMemo(() => { … })",
      },
    },
    outcome: {
      title: "/openfork/packages/app/src/pages/oxp-activity-page.tsx",
      output: "Edit applied successfully (strategy=exact, applied=1).",
      metadata: {
        path: "/openfork/packages/app/src/pages/oxp-activity-page.tsx",
        strategy: "exact",
        applied: 1,
        diff: EDIT_DIFF,
        warnings: ["This file has no OXP read-grounding record."],
      },
      mutation: { attempted: true, committed: true },
    },
  },
  inv_007: {
    invocationID: "inv_007",
    request: { args: { rootID: "root_1", patchText: "…", format: "git", apply: true } },
    outcome: {
      title: "patch: applied 2 changes",
      output: "Applied 2 files.",
      metadata: {
        format: "git",
        fileCount: 2,
        applied: true,
        diff: PATCH_DIFF,
        files: [
          { type: "add", path: "/openfork/packages/session-ui/src/components/search-results.tsx", additions: 1, deletions: 0 },
          { type: "update", path: "/openfork/packages/session-ui/src/components/message-part.tsx", additions: 0, deletions: 4 },
        ],
      },
      mutation: { attempted: true, committed: true },
    },
  },
  inv_008: {
    invocationID: "inv_008",
    request: { args: { rootID: "root_1", mode: "status" } },
    outcome: {
      title: "git status",
      output: "<status>\n M packages/app/src/pages/oxp-activity-page.tsx\n?? packages/app/src/pages/oxp/\n M packages/session-ui/src/components/message-part.tsx\n</status>",
      metadata: { mode: "status", ok: true, exitCode: 0, truncated: false, root: "/openfork" },
    },
  },
  inv_009: {
    invocationID: "inv_009",
    request: { args: { grep: "(((", rootID: "root_1" } },
    outcome: {
      error: {
        code: "OXP_INVALID_ARGUMENT",
        message:
          "regex parse error:\n    (((\n    ^\nerror: unclosed group\n\nNarrow the pattern or escape the parentheses before retrying.",
        metadata: { surface: "find" },
      },
    },
  },
  inv_010: {
    invocationID: "inv_010",
    request: {
      args: {
        action: "start",
        rootID: "root_1",
        title: "Rework the timeline rail",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-opus-5" },
        prompt:
          "Replace the lane-based indentation in the OXP timeline with a single flat column, and flag overlapping calls with a left rail instead of a margin offset.",
      },
    },
    outcome: {
      title: "OpenFork delegated worker started",
      structured: {
        workerID: "ses_worker_1",
        workers: [
          {
            workerID: "ses_worker_1",
            title: "Rework the timeline rail",
            agent: "build",
            model: { providerID: "anthropic", modelID: "claude-opus-5" },
            execution: { running: true, generation: 1 },
          },
        ],
      },
      mutation: { attempted: true, committed: true },
    },
  },
  inv_013: {
    invocationID: "inv_013",
    request: { args: { action: "poll", handle: "proc_dead", rootID: "root_1" } },
    outcome: {
      error: { code: "OXP_AUTH_DENIED", message: "Unknown or retired OXP process handle", metadata: { handle: "proc_dead" } },
    },
  },
  inv_014: {
    invocationID: "inv_014",
    request: {
      args: { action: "start", rootID: "root_1", command: "bun run dev", workdir: "/packages/desktop", mode: "background" },
    },
  },
}
