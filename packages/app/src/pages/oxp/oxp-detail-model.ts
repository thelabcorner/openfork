import type { OxpInvocationDetailInfo, OxpInvocationInfo } from "@opencode-ai/sdk/v2/client"
import {
  asRecord,
  bool,
  effectiveTool,
  errorCodeLabel,
  formatBytes,
  formatDuration,
  modelLabel,
  num,
  numeric,
  str,
  statusKey,
  summaryOf,
  t,
  text,
  type OxpTextKey,
  type Phrase,
} from "./oxp-presentation"

/**
 * Detail payloads, parsed.
 *
 * The durable record keeps the exact request arguments and the exact result the
 * capability returned. Rendering that as "Request payload" / "Result metadata"
 * JSON blocks is the same as not rendering it: the reader still has to decode a
 * command out of `{"action":"start","command":"…"}`. So every family the OXP
 * surface actually produces is parsed into the section it deserves — a command,
 * a diff, a grep result, a read window, a process log, a worker roster — and the
 * generic path is a labelled field grid or the session timeline's own
 * content-aware output renderer, never a raw dump.
 *
 * All of this is pure and only runs for an expanded row.
 */

export type Field = { label: Phrase; value: string | Phrase; mono?: boolean }
export type Stat = { label: Phrase; value: string; tone?: "success" | "warning" | "danger" | "accent" }
export type DetailRow = {
  id: string
  primary: string
  secondary?: string
  trailing?: string
  tone?: "success" | "warning" | "danger" | "accent"
  mono?: boolean
  truncate?: "start" | "end"
  /** Session id to open natively, when the row addresses one. */
  sessionID?: string
}

export type DetailSection =
  | { kind: "stats"; id: string; items: Stat[] }
  | { kind: "fields"; id: string; label?: Phrase; items: Field[] }
  | { kind: "command"; id: string; label: Phrase; command: string }
  | { kind: "code"; id: string; label: Phrase; filename: string; body: string; trailing?: string }
  | { kind: "log"; id: string; label: Phrase; body: string }
  | {
      kind: "diff"
      id: string
      path: string
      patch?: string
      before?: string
      after?: string
      additions: number
      deletions: number
      status?: "added" | "deleted" | "modified"
    }
  | { kind: "grep"; id: string; label: Phrase; output: string; pattern?: string }
  | { kind: "glob"; id: string; label: Phrase; output: string }
  | { kind: "readWindow"; id: string; label: Phrase; output: string; trailing?: string }
  | { kind: "git"; id: string; label: Phrase; mode: string; output: string }
  | { kind: "rows"; id: string; label: Phrase; rows: DetailRow[]; limit?: number }
  | { kind: "prose"; id: string; label: Phrase; body: string }
  | { kind: "params"; id: string; label: Phrase; input: Record<string, unknown> }
  | { kind: "error"; id: string; body: string }
  | { kind: "notice"; id: string; message: Phrase; tone?: "warning" | "danger"; hints?: string[] }

export type DetailModel = {
  /** Present once the payload resolves to nothing — an invocation older than capture. */
  empty: boolean
  sections: DetailSection[]
  diagnostics: Field[]
  truncated: boolean
  /** Command recovered from the payload; lets the collapsed row upgrade its subtitle. */
  command?: string
  /** Search pattern recovered from the payload, same purpose. */
  query?: string
}

/* ── Primitives ──────────────────────────────────────────────────────────── */

const SCALAR_LIMIT = 240

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > SCALAR_LIMIT ? `${value.slice(0, SCALAR_LIMIT)}…` : value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  return undefined
}

function stringList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, limit)
}

function field(label: OxpTextKey, value: string | undefined, mono = false): Field[] {
  return value === undefined || value === "" ? [] : [{ label: t(label), value, mono }]
}

/**
 * Anything the bespoke parsers did not claim still gets a labelled home rather
 * than disappearing — as param chips, which is what the session timeline uses
 * for an unknown tool's input.
 */
function leftovers(source: Record<string, unknown> | undefined, claimed: readonly string[]) {
  if (!source) return undefined
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (claimed.includes(key) || key === "detailTruncated") continue
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      if (value.length > 0) rest[key] = value
      continue
    }
    if (typeof value === "object") continue
    rest[key] = value
  }
  return Object.keys(rest).length > 0 ? rest : undefined
}

/**
 * `createTwoFilesPatch` output, concatenated per file by the patch surface.
 * Split it back so each file gets its own diff viewer instead of one giant
 * unified blob with several headers buried in it.
 */
export function splitUnifiedDiff(patch: string): Array<{ path: string; patch: string }> {
  const lines = patch.split("\n")
  const chunks: Array<{ path: string; patch: string }> = []
  let current: { path: string; lines: string[] } | undefined

  const flush = () => {
    if (!current) return
    const body = current.lines.join("\n").trim()
    if (body) chunks.push({ path: current.path, patch: current.lines.join("\n") })
    current = undefined
  }

  for (const line of lines) {
    const index = /^Index: (.+)$/.exec(line)
    if (index) {
      flush()
      current = { path: index[1]!.trim(), lines: [line] }
      continue
    }
    if (!current) {
      const minus = /^--- (\S+)/.exec(line)
      if (minus) current = { path: minus[1]!.trim(), lines: [line] }
      else continue
    } else current.lines.push(line)
  }
  flush()
  return chunks
}

export function countDiff(patch: string) {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions += 1
    else if (line.startsWith("-")) deletions += 1
  }
  return { additions, deletions }
}

/* ── Request sections ────────────────────────────────────────────────────── */

type Build = {
  item: OxpInvocationInfo
  tool: string
  args?: Record<string, unknown>
  outcome?: Record<string, unknown>
  metadata?: Record<string, unknown>
  structured?: Record<string, unknown>
  output?: string
  sections: DetailSection[]
  command?: string
  query?: string
}

function requestSections(build: Build) {
  const { args, sections } = build
  if (!args) return

  switch (build.tool) {
    case "process": {
      const command = str(args, "command")
      if (command) {
        build.command = command
        sections.push({ id: "req-command", kind: "command", label: t("oxpActivity.detail.section.command"), command })
      }
      const chars = str(args, "chars")
      if (chars)
        sections.push({ id: "req-stdin", kind: "code", label: t("oxpActivity.detail.section.stdin"), filename: "stdin.txt", body: chars })
      const items = [
        ...field("oxpActivity.field.action", str(args, "action")),
        ...field("oxpActivity.field.workdir", str(args, "workdir"), true),
        ...field("oxpActivity.field.handle", str(args, "handle"), true),
        ...field("oxpActivity.field.mode", str(args, "mode")),
        ...field("oxpActivity.field.shell", str(args, "shell"), true),
        ...field("oxpActivity.field.timeout", timeoutLabel(args)),
      ]
      if (items.length) sections.push({ id: "req-fields", kind: "fields", label: t("oxpActivity.detail.section.request"), items })
      return
    }
    case "find": {
      const grep = str(args, "grep")
      const glob = str(args, "glob")
      build.query = grep ?? glob
      const items = [
        ...field(grep ? "oxpActivity.field.pattern" : "oxpActivity.field.glob", grep ?? glob, true),
        ...field("oxpActivity.field.scope", str(args, "path"), true),
        ...field("oxpActivity.field.include", str(args, "include"), true),
      ]
      if (items.length) sections.push({ id: "req-fields", kind: "fields", label: t("oxpActivity.detail.section.query"), items })
      return
    }
    case "read": {
      const reads = Array.isArray(args.reads) ? args.reads : undefined
      if (reads?.length) {
        sections.push({
          id: "req-reads",
          kind: "rows",
          label: t("oxpActivity.detail.section.targets"),
          rows: reads.flatMap((entry, index) => {
            const row = asRecord(entry)
            const path = str(row, "path")
            if (!path) return []
            return [
              {
                id: `read-${index}`,
                primary: path,
                trailing: windowLabel(row),
                truncate: "start" as const,
              },
            ]
          }),
        })
        return
      }
      const items = [
        ...field("oxpActivity.field.path", str(args, "path"), true),
        ...field("oxpActivity.field.window", windowLabel(args)),
        ...field("oxpActivity.field.action", str(args, "action")),
      ]
      if (items.length) sections.push({ id: "req-fields", kind: "fields", label: t("oxpActivity.detail.section.request"), items })
      return
    }
    case "edit": {
      const items = [
        ...field("oxpActivity.field.path", str(args, "path"), true),
        ...field("oxpActivity.field.anchor", anchorLabel(args)),
        ...field("oxpActivity.field.occurrence", numberLabel(args, "occurrence")),
        ...field("oxpActivity.field.replaceAll", flagLabel(args, "replaceAll")),
      ]
      if (items.length) sections.push({ id: "req-fields", kind: "fields", label: t("oxpActivity.detail.section.request"), items })
      const edits = Array.isArray(args.edits) ? args.edits : undefined
      if (edits?.length)
        sections.push({
          id: "req-edits",
          kind: "rows",
          label: t("oxpActivity.detail.section.edits"),
          rows: edits.flatMap((entry, index) => {
            const row = asRecord(entry)
            if (!row) return []
            const target = anchorLabel(row) ?? str(row, "oldString") ?? str(row, "oldText")
            return [{ id: `edit-${index}`, primary: target ?? String(index + 1), mono: true, trailing: editKind(row) }]
          }),
        })
      return
    }
    case "write": {
      const items = field("oxpActivity.field.path", str(args, "path"), true)
      if (items.length) sections.push({ id: "req-fields", kind: "fields", label: t("oxpActivity.detail.section.request"), items })
      return
    }
    case "patch": {
      const items = [
        ...field("oxpActivity.field.format", str(args, "format")),
        ...field("oxpActivity.field.apply", applyLabel(args)),
      ]
      if (items.length) sections.push({ id: "req-fields", kind: "fields", label: t("oxpActivity.detail.section.request"), items })
      return
    }
    case "git": {
      const items = [
        ...field("oxpActivity.field.mode", str(args, "mode")),
        ...field("oxpActivity.field.workdir", str(args, "workdir"), true),
        ...field("oxpActivity.field.ref", str(args, "ref"), true),
      ]
      const paths = stringList(args.paths)
      if (items.length) sections.push({ id: "req-fields", kind: "fields", label: t("oxpActivity.detail.section.request"), items })
      if (paths.length)
        sections.push({
          id: "req-paths",
          kind: "rows",
          label: t("oxpActivity.detail.section.paths"),
          rows: paths.map((path, index) => ({ id: `path-${index}`, primary: path, truncate: "start" as const })),
        })
      return
    }
    case "openfork_worker": {
      const items = [
        ...field("oxpActivity.field.action", str(args, "action")),
        ...field("oxpActivity.field.title", str(args, "title")),
        ...field("oxpActivity.field.agent", str(args, "agent")),
        ...field("oxpActivity.field.model", modelLabel(args)),
        ...field("oxpActivity.field.workerID", str(args, "workerID"), true),
        ...field("oxpActivity.field.batchID", str(args, "batchID"), true),
      ]
      if (items.length) sections.push({ id: "req-fields", kind: "fields", label: t("oxpActivity.detail.section.request"), items })
      const prompt = str(args, "prompt")
      if (prompt) sections.push({ id: "req-prompt", kind: "prose", label: t("oxpActivity.detail.section.prompt"), body: prompt })
      const workers = Array.isArray(args.workers) ? args.workers : undefined
      if (workers?.length)
        sections.push({
          id: "req-workers",
          kind: "rows",
          label: t("oxpActivity.detail.section.workers"),
          rows: workers.flatMap((entry, index) => {
            const row = asRecord(entry)
            if (!row) return []
            return [
              {
                id: `worker-${index}`,
                primary: str(row, "title") ?? str(row, "agent") ?? String(index + 1),
                secondary: str(row, "agent"),
                trailing: modelLabel(row),
                mono: false,
              },
            ]
          }),
        })
      return
    }
    case "openfork_session":
    case "openfork_request": {
      const items = [
        ...field("oxpActivity.field.action", str(args, "action")),
        ...field("oxpActivity.field.sessionID", str(args, "sessionID"), true),
        ...field("oxpActivity.field.requestID", str(args, "requestID"), true),
        ...field("oxpActivity.field.agent", str(args, "agent")),
        ...field("oxpActivity.field.model", modelLabel(args)),
      ]
      if (items.length) sections.push({ id: "req-fields", kind: "fields", label: t("oxpActivity.detail.section.request"), items })
      const prompt = str(args, "text") ?? str(args, "message")
      if (prompt) sections.push({ id: "req-prompt", kind: "prose", label: t("oxpActivity.detail.section.prompt"), body: prompt })
      return
    }
    case "capability": {
      const items = [
        ...field("oxpActivity.field.action", str(args, "action")),
        ...field("oxpActivity.field.namespace", str(args, "namespace")),
        ...field("oxpActivity.field.capability", str(args, "capability"), true),
        ...field("oxpActivity.field.query", str(args, "query"), true),
      ]
      if (items.length) sections.push({ id: "req-fields", kind: "fields", label: t("oxpActivity.detail.section.request"), items })
      const nested = asRecord(args.args)
      if (nested)
        sections.push({ id: "req-args", kind: "params", label: t("oxpActivity.detail.section.arguments"), input: nested })
      return
    }
    default: {
      const rest = leftovers(args, ["rootID"])
      if (rest) sections.push({ id: "req-args", kind: "params", label: t("oxpActivity.detail.section.request"), input: rest })
    }
  }
}

function timeoutLabel(args: Record<string, unknown>) {
  const timeout = num(args, "timeoutMs") ?? num(args, "yieldMs")
  return timeout === undefined ? undefined : formatDuration(timeout)
}

function windowLabel(row: Record<string, unknown> | undefined) {
  const offset = num(row, "offset")
  const limit = num(row, "limit")
  if (offset === undefined && limit === undefined) return undefined
  if (offset !== undefined && limit !== undefined) return `${offset}–${offset + limit - 1}`
  if (offset !== undefined) return `from ${offset}`
  return `${limit} lines`
}

function numberLabel(source: Record<string, unknown>, key: string) {
  const value = num(source, key)
  return value === undefined ? undefined : String(value)
}

function flagLabel(source: Record<string, unknown>, key: string) {
  const value = bool(source, key)
  return value === true ? "true" : undefined
}

function anchorLabel(source: Record<string, unknown>) {
  const line = num(source, "line")
  if (line !== undefined) return `line ${line}`
  const start = num(source, "startLine")
  const end = num(source, "endLine")
  if (start !== undefined && end !== undefined) return `lines ${start}–${end}`
  const insertAt = num(source, "insertAt")
  if (insertAt !== undefined) return `insert at ${insertAt}`
  const insertAfter = num(source, "insertAfter")
  if (insertAfter !== undefined) return `insert after ${insertAfter}`
  const near = str(source, "nearText")
  if (near) return `near ${near}`
  return undefined
}

function editKind(row: Record<string, unknown>) {
  if (bool(row, "delete") === true) return "delete"
  if (bool(row, "appendFile") === true) return "append"
  if (num(row, "insertAt") !== undefined || num(row, "insertAfter") !== undefined) return "insert"
  return "replace"
}

function applyLabel(args: Record<string, unknown>) {
  const value = args.apply
  if (value === undefined) return "if-clean"
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "apply" : "dry-run"
  return undefined
}

/* ── Outcome sections ────────────────────────────────────────────────────── */

function outcomeSections(build: Build) {
  const { metadata, structured, output, sections } = build

  if (build.outcome?.error !== undefined) {
    const error = asRecord(build.outcome.error)
    const message = str(error, "message") ?? (typeof build.outcome.error === "string" ? build.outcome.error : undefined)
    const items = [
      ...field("oxpActivity.field.errorCode", str(error, "code") ? errorCodeLabel(str(error, "code")!) : undefined),
      ...fieldsFrom(asRecord(error?.metadata)),
    ]
    if (items.length) sections.push({ id: "err-fields", kind: "fields", label: t("oxpActivity.detail.section.error"), items })
    if (message) sections.push({ id: "err-body", kind: "error", body: message })
    return
  }

  switch (build.tool) {
    case "process":
      return processOutcome(build)
    case "find":
      return findOutcome(build)
    case "read":
      return readOutcome(build)
    case "edit":
      return editOutcome(build)
    case "write":
      return writeOutcome(build)
    case "patch":
      return patchOutcome(build)
    case "git":
      return gitOutcome(build)
    case "openfork_worker":
      return workerOutcome(build)
    default: {
      const rows = genericRows(structured)
      if (rows) sections.push(rows)
      const items = fieldsFrom(structured, rows ? [rows.id.replace("res-", "")] : []).concat(fieldsFrom(metadata))
      if (items.length)
        sections.push({ id: "res-fields", kind: "fields", label: t("oxpActivity.detail.section.result"), items })
      if (output && !rows) sections.push({ id: "res-output", kind: "prose", label: t("oxpActivity.detail.section.output"), body: output })
    }
  }
}

function processOutcome(build: Build) {
  const state = build.metadata ?? build.structured
  const stats: Stat[] = []
  const running = bool(state, "running")
  const exitCode = num(state, "exitCode")
  if (running === true) stats.push({ label: t("oxpActivity.field.state"), value: "running", tone: "accent" })
  if (exitCode !== undefined)
    stats.push({
      label: t("oxpActivity.field.exitCode"),
      value: String(exitCode),
      tone: exitCode === 0 ? "success" : "danger",
    })
  const startedAt = num(state, "startedAt")
  const endedAt = num(state, "endedAt")
  if (startedAt !== undefined && endedAt !== undefined)
    stats.push({ label: t("oxpActivity.field.duration"), value: formatDuration(endedAt - startedAt) })
  const bytes = num(state, "outputBytes")
  if (bytes !== undefined) stats.push({ label: t("oxpActivity.field.output"), value: formatBytes(bytes) })
  if (stats.length) build.sections.push({ id: "res-stats", kind: "stats", items: stats })

  const items = [
    ...field("oxpActivity.field.handle", str(state, "handle"), true),
    ...field("oxpActivity.field.workdir", str(state, "workdir"), true),
    ...field("oxpActivity.field.mode", str(state, "mode")),
    ...field("oxpActivity.field.retained", num(state, "retainedBytes") === undefined ? undefined : formatBytes(num(state, "retainedBytes")!)),
  ]
  if (items.length) build.sections.push({ id: "res-fields", kind: "fields", items })

  const processes = Array.isArray(build.structured?.processes) ? build.structured!.processes : undefined
  if (processes?.length) {
    build.sections.push({
      id: "res-processes",
      kind: "rows",
      label: t("oxpActivity.detail.section.processes"),
      rows: processes.flatMap((entry, index) => {
        const row = asRecord(entry)
        const handle = str(row, "handle")
        if (!handle) return []
        return [
          {
            id: handle || `process-${index}`,
            primary: handle,
            secondary: str(row, "workdir"),
            trailing: bool(row, "running") === true ? "running" : `exit ${num(row, "exitCode") ?? "—"}`,
            tone: bool(row, "running") === true ? ("accent" as const) : undefined,
            mono: true,
          },
        ]
      }),
    })
    return
  }

  const body = str(build.structured, "output") ?? build.output
  if (body && body.trim() && !body.startsWith("{") && !body.startsWith("["))
    build.sections.push({ id: "res-log", kind: "log", label: t("oxpActivity.detail.section.output"), body })

  if (bool(state, "truncated") === true || bool(state, "pageTruncated") === true)
    build.sections.push({ id: "res-truncated", kind: "notice", message: t("oxpActivity.detail.outputTruncated"), tone: "warning" })
}

function findOutcome(build: Build) {
  const glob = str(build.metadata, "action") === "glob"
  const count = num(build.metadata, "count")
  if (count !== undefined || build.metadata?.root)
    build.sections.push({
      id: "res-fields",
      kind: "fields",
      items: [
        ...field("oxpActivity.field.root", str(build.metadata, "root")),
        ...field("oxpActivity.field.results", count === undefined ? undefined : String(count)),
      ],
    })
  if (!build.output) return
  build.sections.push(
    glob
      ? { id: "res-glob", kind: "glob", label: t("oxpActivity.detail.section.results"), output: build.output }
      : {
          id: "res-grep",
          kind: "grep",
          label: t("oxpActivity.detail.section.results"),
          output: build.output,
          pattern: build.query,
        },
  )
  if (bool(build.metadata, "truncated") === true)
    build.sections.push({ id: "res-truncated", kind: "notice", message: t("oxpActivity.detail.resultsTruncated"), tone: "warning" })
}

function readOutcome(build: Build) {
  if (bool(build.metadata, "attachment") === true) {
    build.sections.push({ id: "res-attachment", kind: "notice", message: t("oxpActivity.detail.attachment") })
    return
  }
  if (!build.output) return
  const lines = num(build.metadata, "lines")
  const entries = num(build.metadata, "entries")
  build.sections.push({
    id: "res-read",
    kind: "readWindow",
    label: t("oxpActivity.detail.section.content"),
    output: build.output,
    trailing:
      lines !== undefined ? `${lines} lines` : entries !== undefined ? `${entries} entries` : undefined,
  })
  if (bool(build.metadata, "truncated") === true)
    build.sections.push({ id: "res-truncated", kind: "notice", message: t("oxpActivity.detail.readTruncated"), tone: "warning" })
}

function editOutcome(build: Build) {
  const path = str(build.metadata, "path") ?? str(build.args, "path") ?? build.item.id
  const patch = str(build.metadata, "diff")
  const items = [
    ...field("oxpActivity.field.strategy", str(build.metadata, "strategy")),
    ...field("oxpActivity.field.applied", numberLabel(build.metadata ?? {}, "applied")),
  ]
  if (items.length) build.sections.push({ id: "res-fields", kind: "fields", items })

  if (patch) {
    const counts = countDiff(patch)
    build.sections.push({ id: "res-diff", kind: "diff", path, patch, ...counts, status: "modified" })
  } else {
    // Nothing committed — show what the call *asked* for, as a real diff rather
    // than two opaque strings, so a rejected edit is still reviewable.
    const before = str(build.args, "oldString") ?? str(build.args, "oldText")
    const after = str(build.args, "newString") ?? str(build.args, "newText")
    if (before !== undefined || after !== undefined)
      build.sections.push({
        id: "res-diff",
        kind: "diff",
        path,
        before: before ?? "",
        after: after ?? "",
        additions: after ? after.split("\n").length : 0,
        deletions: before ? before.split("\n").length : 0,
        status: "modified",
      })
  }

  const warnings = stringList(build.metadata?.warnings)
  if (warnings.length)
    build.sections.push({
      id: "res-warnings",
      kind: "notice",
      message: t("oxpActivity.detail.editWarnings"),
      tone: "warning",
      hints: warnings,
    })
}

function writeOutcome(build: Build) {
  const path = str(build.metadata, "path") ?? str(build.args, "path") ?? build.item.id
  const patch = str(build.metadata, "diff")
  const existed = bool(build.metadata, "exists")
  const changed = bool(build.metadata, "changed")
  const items = [
    ...field("oxpActivity.field.target", existed === false ? "created" : "updated"),
    ...field("oxpActivity.field.changed", changed === undefined ? undefined : changed ? "yes" : "no"),
  ]
  if (items.length) build.sections.push({ id: "res-fields", kind: "fields", items })

  if (patch) {
    const counts = countDiff(patch)
    build.sections.push({
      id: "res-diff",
      kind: "diff",
      path,
      patch,
      ...counts,
      status: existed === false ? "added" : "modified",
    })
  } else {
    const content = str(build.args, "content")
    if (content !== undefined)
      build.sections.push({ id: "res-content", kind: "code", label: t("oxpActivity.detail.section.content"), filename: path, body: content })
  }
  if (bool(build.metadata, "diffTruncated") === true)
    build.sections.push({ id: "res-truncated", kind: "notice", message: t("oxpActivity.detail.diffTruncated"), tone: "warning" })
}

function patchOutcome(build: Build) {
  const files = Array.isArray(build.metadata?.files) ? build.metadata!.files : []
  const items = [
    ...field("oxpActivity.field.format", str(build.metadata, "format")),
    ...field("oxpActivity.field.applied", bool(build.metadata, "applied") === undefined ? undefined : bool(build.metadata, "applied") ? "yes" : "no"),
  ]
  if (items.length) build.sections.push({ id: "res-fields", kind: "fields", items })

  const patch = str(build.metadata, "diff")
  const chunks = patch ? splitUnifiedDiff(patch) : []
  const byPath = new Map(chunks.map((chunk) => [chunk.path, chunk.patch] as const))

  const parsed = files.flatMap((entry) => {
    const row = asRecord(entry)
    const path = str(row, "path")
    if (!path) return []
    return [
      {
        path,
        type: str(row, "type"),
        movePath: str(row, "movePath"),
        additions: num(row, "additions") ?? 0,
        deletions: num(row, "deletions") ?? 0,
      },
    ]
  })

  for (const file of parsed) {
    const body = byPath.get(file.path)
    if (body) {
      build.sections.push({
        id: `res-diff-${file.path}`,
        kind: "diff",
        path: file.movePath ? `${file.path} → ${file.movePath}` : file.path,
        patch: body,
        additions: file.additions,
        deletions: file.deletions,
        status: file.type === "add" ? "added" : file.type === "delete" ? "deleted" : "modified",
      })
      byPath.delete(file.path)
    }
  }

  const undiffed = parsed.filter((file) => !chunks.some((chunk) => chunk.path === file.path))
  if (undiffed.length)
    build.sections.push({
      id: "res-files",
      kind: "rows",
      label: t("oxpActivity.detail.section.files"),
      rows: undiffed.map((file) => ({
        id: file.path,
        primary: file.movePath ? `${file.path} → ${file.movePath}` : file.path,
        secondary: file.type,
        trailing: file.additions || file.deletions ? `+${file.additions} −${file.deletions}` : undefined,
        truncate: "start" as const,
      })),
    })

  if (!patch && parsed.length === 0) {
    const patchText = str(build.args, "patchText")
    if (patchText)
      build.sections.push({ id: "res-patchtext", kind: "code", label: t("oxpActivity.detail.section.patch"), filename: "change.diff", body: patchText })
  }
}

function gitOutcome(build: Build) {
  const mode = str(build.metadata, "mode") ?? str(build.args, "mode") ?? "status"
  const exitCode = num(build.metadata, "exitCode")
  const items = [
    ...field("oxpActivity.field.mode", mode),
    ...field("oxpActivity.field.root", str(build.metadata, "root"), true),
    ...field("oxpActivity.field.exitCode", exitCode === undefined ? undefined : String(exitCode)),
  ]
  if (items.length) build.sections.push({ id: "res-fields", kind: "fields", items })
  if (build.output)
    build.sections.push({ id: "res-git", kind: "git", label: t("oxpActivity.detail.section.result"), mode, output: build.output })
}

function workerOutcome(build: Build) {
  const structured = build.structured
  const workers = Array.isArray(structured?.workers) ? structured!.workers : undefined
  const batches = Array.isArray(structured?.batches) ? structured!.batches : undefined

  const items = [
    ...field("oxpActivity.field.workerID", str(structured, "workerID"), true),
    ...field("oxpActivity.field.batchID", str(structured, "batchID") ?? str(structured, "batchRef"), true),
    ...field("oxpActivity.field.agent", str(structured, "agent")),
    ...field("oxpActivity.field.model", modelLabel(structured)),
    ...field("oxpActivity.field.title", str(structured, "title")),
  ]
  if (items.length) build.sections.push({ id: "res-fields", kind: "fields", items })

  if (workers?.length) {
    build.sections.push({
      id: "res-workers",
      kind: "rows",
      label: t("oxpActivity.detail.section.workers"),
      rows: workers.flatMap((entry, index) => {
        const row = asRecord(entry)
        const id = str(row, "workerID") ?? str(row, "id")
        if (!id) return []
        const execution = asRecord(row?.execution)
        const running = bool(execution, "running") === true
        const owned = bool(execution, "owned") === true
        return [
          {
            id,
            primary: str(row, "title") ?? id,
            secondary: str(row, "agent") ?? modelLabel(row),
            trailing: running
              ? "running"
              : owned
                ? "owned"
                : bool(row, "archived") === true
                  ? "archived"
                  : "idle",
            tone: running ? ("accent" as const) : undefined,
            mono: false,
            sessionID: id,
          },
        ]
      }),
      limit: 8,
    })
  }

  if (batches?.length)
    build.sections.push({
      id: "res-batches",
      kind: "rows",
      label: t("oxpActivity.detail.section.batches"),
      rows: batches.flatMap((entry, index) => {
        const row = asRecord(entry)
        const id = str(row, "batchID") ?? str(row, "id")
        if (!id) return []
        const members = Array.isArray(row?.memberIDs) ? row!.memberIDs.length : undefined
        return [
          {
            id,
            primary: str(row, "name") ?? id,
            trailing: members === undefined ? undefined : String(members),
            mono: false,
          },
        ]
      }),
    })

  if (!workers && !batches && build.output && build.output.trim().startsWith("{")) {
    const rows = genericRows(structured)
    if (rows) build.sections.push(rows)
  }
}

/**
 * Generic richness for families without a bespoke parser: a single array of
 * object rows is the overwhelmingly common shape (`{sessions:[…]}`,
 * `{messages:[…]}`, `{capabilities:[…]}`), and a row list beats a JSON blob
 * every time.
 */
function genericRows(structured: Record<string, unknown> | undefined): Extract<DetailSection, { kind: "rows" }> | undefined {
  if (!structured) return undefined
  const arrays = Object.entries(structured).filter(
    ([, value]) => Array.isArray(value) && value.length > 0 && value.every((entry) => asRecord(entry) !== undefined),
  )
  if (arrays.length !== 1) return undefined
  const [key, value] = arrays[0] as [string, Record<string, unknown>[]]
  const rows = value.flatMap((entry, index) => {
    const row = asRecord(entry)
    if (!row) return []
    const primary = str(row, "title") ?? str(row, "name") ?? str(row, "id") ?? str(row, "capability") ?? str(row, "path")
    if (!primary) return []
    return [
      {
        id: str(row, "id") ?? `${key}-${index}`,
        primary,
        secondary: str(row, "description") ?? str(row, "agent") ?? str(row, "summary"),
        trailing: str(row, "status") ?? str(row, "role") ?? undefined,
        mono: false,
      },
    ]
  })
  if (rows.length === 0) return undefined
  return { id: `res-${key}`, kind: "rows", label: text(humanizeKey(key)), rows, limit: 10 }
}

function fieldsFrom(source: Record<string, unknown> | undefined, skip: readonly string[] = []): Field[] {
  if (!source) return []
  const items: Field[] = []
  for (const [key, value] of Object.entries(source)) {
    if (skip.includes(key) || key === "detailTruncated" || key === "diff" || key === "output") continue
    const rendered = scalar(value)
    if (rendered === undefined) continue
    items.push({ label: text(humanizeKey(key)), value: rendered, mono: /id$|path|dir|ref|hash/i.test(key) })
    if (items.length >= 12) break
  }
  return items
}

function humanizeKey(key: string) {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

/**
 * The two facts a collapsed row can upgrade itself with once a payload happens
 * to be cached. Kept separate from `buildDetail` so the row never has to build
 * (or hold) the whole section list to read them.
 */
export function detailHints(item: OxpInvocationInfo, detail: OxpInvocationDetailInfo | undefined) {
  const args = asRecord(asRecord(detail?.request)?.args)
  if (!args) return undefined
  const summary = summaryOf(item)
  const tool = effectiveTool(item.tool, str(summary, "capability") ?? str(args, "capability"))
  if (tool === "process") {
    const command = str(args, "command")
    return command ? { command } : undefined
  }
  if (tool === "find") {
    const query = str(args, "grep") ?? str(args, "glob")
    return query ? { query } : undefined
  }
  return undefined
}

export function buildDetail(item: OxpInvocationInfo, detail: OxpInvocationDetailInfo | undefined): DetailModel {
  const request = asRecord(detail?.request)
  const outcome = asRecord(detail?.outcome)
  const args = asRecord(request?.args)
  const metadata = asRecord(outcome?.metadata)
  const structured = asRecord(outcome?.structured)
  const output = typeof outcome?.output === "string" ? outcome.output : undefined
  const summary = summaryOf(item)

  const build: Build = {
    item,
    tool: effectiveTool(item.tool, str(summary, "capability") ?? str(args, "capability")),
    args,
    outcome,
    metadata,
    structured,
    output,
    sections: [],
  }

  if (detail && (request || outcome)) {
    requestSections(build)
    outcomeSections(build)
  }

  const diagnostics: Field[] = [
    { label: t("oxpActivity.field.status"), value: t(statusKey(item.status)) },
    { label: t("oxpActivity.field.plane"), value: t(`oxpActivity.plane.${item.plane}` as OxpTextKey) },
    ...field("oxpActivity.field.root", item.rootAlias, true),
    ...field("oxpActivity.field.started", new Date(numeric(item.startedAt)).toLocaleString()),
    ...field("oxpActivity.field.epoch", item.observedEpoch === undefined ? undefined : String(numeric(item.observedEpoch))),
    ...field("oxpActivity.field.mutation", mutationLabel(item)),
    ...field("oxpActivity.field.invocation", item.id, true),
    ...field("oxpActivity.field.hostRun", item.hostRunID, true),
  ]
  return {
    empty: !detail || (!request && !outcome),
    sections: build.sections,
    diagnostics,
    truncated: request?.detailTruncated === true || outcome?.detailTruncated === true,
    command: build.command,
    query: build.query,
  }
}

function mutationLabel(item: OxpInvocationInfo) {
  if (item.mutationCommitted) return "committed"
  if (item.mutationAttempted) return "attempted"
  return undefined
}
