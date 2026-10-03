import type { OxpActivityStatus, OxpInvocationInfo } from "@opencode-ai/sdk/v2/client"
import type { IconProps } from "@opencode-ai/ui/icon"
import type { dict } from "@/i18n/en"

/**
 * Presentation model for the OXP activity transcript.
 *
 * Everything here is pure so the timeline's identity, outcome, ordering and
 * filtering rules are testable without a renderer. Copy is emitted as `Phrase`
 * descriptors rather than resolved strings: the components own `language.t` /
 * `language.plural`, which keeps this file free of i18n plumbing and keeps the
 * keys type-checked against the dictionary.
 */

export type OxpTextKey = keyof typeof dict

export type OxpPluralKey =
  | "oxpActivity.calls"
  | "oxpActivity.concurrent"
  | "oxpActivity.result.edits"
  | "oxpActivity.result.entries"
  | "oxpActivity.result.files"
  | "oxpActivity.result.lines"
  | "oxpActivity.result.matches"
  | "oxpActivity.result.workers"

export type Phrase =
  | { kind: "text"; value: string }
  | { kind: "t"; key: OxpTextKey; params?: Record<string, string | number> }
  | { kind: "plural"; key: OxpPluralKey; count: number }

export const text = (value: string): Phrase => ({ kind: "text", value })
export const t = (key: OxpTextKey, params?: Record<string, string | number>): Phrase => ({ kind: "t", key, params })
export const plural = (key: OxpPluralKey, count: number): Phrase => ({ kind: "plural", key, count })

/* ── Numbers and time ────────────────────────────────────────────────────── */

/** SDK numerics widen to `number | "NaN" | "Infinity" | …`; collapse them once, here. */
export function numeric(value: unknown, fallback = 0) {
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

export function elapsedMs(item: OxpInvocationInfo, now: number) {
  const start = numeric(item.startedAt)
  const end = item.completedAt === undefined ? now : numeric(item.completedAt, now)
  return Math.max(0, end - start)
}

/**
 * Durations read as one glance, not as a unit conversion exercise: sub-second
 * work stays in milliseconds, a test run reads in seconds, a long delegation in
 * minutes. Always three significant characters or fewer so the right-hand column
 * of a dense transcript never reflows.
 */
export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value)) return "—"
  const units = ["B", "KB", "MB", "GB"]
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

export function relativePhrase(at: unknown, now: number): Phrase {
  const value = numeric(at)
  if (value <= 0) return text("—")
  const diff = Math.max(0, now - value)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t("oxpActivity.relative.now")
  if (minutes < 60) return t("oxpActivity.relative.minutes", { value: minutes })
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 24) return t("oxpActivity.relative.hours", { value: hours })
  return t("oxpActivity.relative.days", { value: Math.floor(diff / 86_400_000) })
}

/* ── Status ──────────────────────────────────────────────────────────────── */

export const FAILURE_STATUSES: ReadonlySet<OxpActivityStatus> = new Set<OxpActivityStatus>([
  "cancelled_before_commit",
  "cancelled_after_commit",
  "denied",
  "conflict",
  "failed",
  "ambiguous_external_result",
  "interrupted",
])

export function isFailure(item: Pick<OxpInvocationInfo, "status">) {
  return FAILURE_STATUSES.has(item.status)
}

export function isRunning(item: Pick<OxpInvocationInfo, "status">) {
  return item.status === "running"
}

export function statusKey(status: OxpActivityStatus): OxpTextKey {
  return `oxpActivity.status.${status}` as OxpTextKey
}

/** What `BasicTool` needs in `status` to pick its badge/title treatment. */
export function toolStatus(item: Pick<OxpInvocationInfo, "status">) {
  if (isRunning(item)) return "running"
  if (isFailure(item)) return "error"
  return "completed"
}

/* ── Safe summary access ─────────────────────────────────────────────────── */

export type SafeSummary = Record<string, unknown>

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function summaryOf(item: OxpInvocationInfo): SafeSummary | undefined {
  return asRecord(item.safeSummary)
}

export function str(source: Record<string, unknown> | undefined, key: string) {
  const value = source?.[key]
  return typeof value === "string" && value ? value : undefined
}

export function num(source: Record<string, unknown> | undefined, key: string) {
  const value = source?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function bool(source: Record<string, unknown> | undefined, key: string) {
  const value = source?.[key]
  return typeof value === "boolean" ? value : undefined
}

export type SummaryFile = {
  path: string
  type?: string
  movePath?: string
  additions: number
  deletions: number
}

export function summaryFiles(summary: SafeSummary | undefined): SummaryFile[] {
  const raw = summary?.files
  if (!Array.isArray(raw)) return []
  return raw.flatMap((value) => {
    const row = asRecord(value)
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
}

export function modelLabel(summary: Record<string, unknown> | undefined) {
  const model = asRecord(summary?.model)
  const providerID = str(model, "providerID")
  const modelID = str(model, "modelID")
  if (!providerID || !modelID) return undefined
  const variant = str(model, "variant")
  return `${providerID}/${modelID}${variant ? ` · ${variant}` : ""}`
}

/* ── Tool identity ───────────────────────────────────────────────────────── */

export type OxpIcon = IconProps["name"]

/**
 * `capability.call` proxies the real tool, so a capability row would otherwise
 * read "Capability · test.run" forever. Resolve the delegated family from the
 * broker's canonical capability id and present the row as the operation the user
 * actually cares about.
 */
export function effectiveTool(tool: string, capability?: string) {
  if (tool !== "capability" || !capability) return tool
  const head = capability.split(/[./]/)[0] ?? ""
  switch (head) {
    case "read":
    case "find":
    case "edit":
    case "write":
    case "patch":
    case "process":
    case "git":
      return head
    default:
      return tool
  }
}

function humanize(tool: string) {
  return tool
    .replace(/^openfork_/, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase())
}

export type ToolIdentity = {
  icon: OxpIcon
  title: Phrase
  subtitle?: string
  subtitleMono?: boolean
  subtitleTruncate?: "start" | "end"
}

/**
 * Identity mirrors the session timeline's own `getToolInfo`: same icon, same
 * word, same truncation rule per family, so a column of OXP rows scans exactly
 * like a column of native tool rows.
 *
 * `command` is only present once a row's detail payload has been fetched, so the
 * collapsed row degrades to the working directory rather than forcing an eager
 * fetch for every row on screen.
 */
export function toolIdentity(item: OxpInvocationInfo, hints?: { command?: string; query?: string }): ToolIdentity {
  const summary = summaryOf(item)
  const action = item.action ?? str(summary, "action")
  const tool = effectiveTool(item.tool, str(summary, "capability"))

  switch (tool) {
    case "read": {
      const path = str(summary, "path")
      const directory = bool(summary, "directory") === true
      return {
        icon: directory ? "bullet-list" : "glasses",
        title: t(directory ? "oxpActivity.tool.list" : "oxpActivity.tool.read"),
        subtitle: path ?? item.rootAlias,
        subtitleTruncate: "start",
      }
    }
    case "find": {
      const glob = str(summary, "kind") === "glob"
      return {
        icon: "magnifying-glass-menu",
        title: t(glob ? "oxpActivity.tool.findFiles" : "oxpActivity.tool.search"),
        subtitle: hints?.query ?? str(summary, "pattern") ?? item.rootAlias,
        subtitleMono: true,
      }
    }
    case "edit":
    case "write": {
      const files = summaryFiles(summary)
      return {
        icon: "code-lines",
        title: t(tool === "edit" ? "oxpActivity.tool.edit" : "oxpActivity.tool.write"),
        subtitle: files[0]?.path ?? item.rootAlias,
        subtitleTruncate: "start",
      }
    }
    case "patch": {
      const files = summaryFiles(summary)
      return {
        icon: "code-lines",
        title: t("oxpActivity.tool.patch"),
        subtitle: files.length === 1 ? files[0]!.path : undefined,
        subtitleTruncate: "start",
      }
    }
    case "process": {
      const start = action === "start" || action === undefined
      return {
        icon: "console",
        title: t(start ? "oxpActivity.tool.command" : `oxpActivity.tool.process.${action}` as OxpTextKey),
        subtitle: hints?.command ?? str(summary, "handle") ?? str(summary, "workdir") ?? item.rootAlias,
        subtitleMono: true,
      }
    }
    case "git":
      return {
        icon: "branch",
        title: t("oxpActivity.tool.git"),
        subtitle: str(summary, "mode") ?? str(summary, "branch") ?? str(summary, "ref") ?? item.rootAlias,
      }
    case "openfork_worker": {
      const workers = num(summary, "workerCount")
      return {
        icon: "subagent",
        title: t(workers !== undefined && workers > 1 ? "oxpActivity.tool.workers" : "oxpActivity.tool.worker"),
        subtitle: str(summary, "agent") ?? str(summary, "workerID") ?? str(summary, "batchID") ?? actionLabel(action),
      }
    }
    case "openfork_session":
      return {
        icon: "speech-bubble",
        title: t("oxpActivity.tool.session"),
        subtitle: str(summary, "sessionID") ?? actionLabel(action),
      }
    case "openfork_request":
      return {
        icon: "bubble-5",
        title: t("oxpActivity.tool.request"),
        subtitle: str(summary, "requestID") ?? str(summary, "sessionID") ?? actionLabel(action),
      }
    case "openfork_info":
      return { icon: "status", title: t("oxpActivity.tool.info"), subtitle: actionLabel(action) }
    case "openai_files":
      return { icon: "cloud-upload", title: t("oxpActivity.tool.files"), subtitle: actionLabel(action) }
    case "capability": {
      const namespace = str(summary, "namespace")
      const capability = str(summary, "capability")
      return {
        icon: "mcp",
        title: t(namespace === "mcp" ? "oxpActivity.tool.mcp" : "oxpActivity.tool.capability"),
        subtitle: capability ?? actionLabel(action),
        subtitleMono: true,
      }
    }
    default:
      return { icon: "mcp", title: text(humanize(item.tool)), subtitle: actionLabel(action) }
  }
}

function actionLabel(action: string | undefined) {
  return action ? action.replaceAll("_", " ") : undefined
}

/* ── Outcome facts ───────────────────────────────────────────────────────── */

export type InvocationFacts = {
  facts: Phrase[]
  changes?: { additions: number; deletions: number }
}

/**
 * The collapsed row must answer what the call *returned*, not only what it was
 * asked to do — a search that found 0 matches and one that found 40 are the same
 * row otherwise. Mutations report their diff counts instead, which is the same
 * contract the session timeline uses.
 */
export function invocationFacts(item: OxpInvocationInfo): InvocationFacts {
  const summary = summaryOf(item)
  const tool = effectiveTool(item.tool, str(summary, "capability"))
  const facts: Phrase[] = []

  if (item.errorCode) facts.push(text(errorCodeLabel(item.errorCode)))

  const files = summaryFiles(summary)
  const changes = files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  )

  switch (tool) {
    case "find": {
      const count = num(summary, "count")
      if (count !== undefined)
        facts.push(plural(str(summary, "kind") === "glob" ? "oxpActivity.result.files" : "oxpActivity.result.matches", count))
      break
    }
    case "read": {
      const lines = num(summary, "lines")
      const entries = num(summary, "entries")
      const targets = num(summary, "targets")
      if (lines !== undefined) facts.push(plural("oxpActivity.result.lines", lines))
      if (entries !== undefined) facts.push(plural("oxpActivity.result.entries", entries))
      if (targets !== undefined && targets > 1) facts.push(plural("oxpActivity.result.files", targets))
      break
    }
    case "edit":
    case "write": {
      if (bool(summary, "changed") === false) facts.push(t("oxpActivity.result.noChange"))
      break
    }
    case "patch": {
      const fileCount = num(summary, "fileCount")
      if (fileCount !== undefined && files.length !== 1) facts.push(plural("oxpActivity.result.files", fileCount))
      if (bool(summary, "applied") === false) facts.push(t("oxpActivity.result.planned"))
      break
    }
    case "process": {
      const exitCode = num(summary, "exitCode")
      if (bool(summary, "running") === true) facts.push(t("oxpActivity.result.running"))
      else if (exitCode !== undefined) facts.push(t("oxpActivity.result.exit", { code: exitCode }))
      const bytes = num(summary, "outputBytes")
      if (bytes !== undefined && bytes > 0) facts.push(text(formatBytes(bytes)))
      break
    }
    case "git": {
      const changed = num(summary, "files")
      if (changed !== undefined) facts.push(plural("oxpActivity.result.files", changed))
      break
    }
    case "openfork_worker": {
      const workers = num(summary, "workerCount")
      if (workers !== undefined) facts.push(plural("oxpActivity.result.workers", workers))
      const model = modelLabel(summary)
      if (model) facts.push(text(model))
      break
    }
    default:
      break
  }

  if (
    bool(summary, "truncated") === true ||
    bool(summary, "pageTruncated") === true ||
    bool(summary, "summaryTruncated") === true ||
    bool(summary, "filesTruncated") === true
  )
    facts.push(t("oxpActivity.result.truncated"))

  return {
    facts: facts.slice(0, 3),
    changes: changes.additions > 0 || changes.deletions > 0 ? changes : undefined,
  }
}

/** `OXP_AUTH_DENIED` reads as shouting; `Auth denied` reads as a result. */
export function errorCodeLabel(code: string) {
  const body = code.replace(/^OXP_/, "").replaceAll("_", " ").toLowerCase()
  return body.charAt(0).toUpperCase() + body.slice(1)
}

/* ── Filtering ───────────────────────────────────────────────────────────── */

export type OxpFilter = "all" | "tools" | "workers" | "changes" | "errors"

export const OXP_FILTERS: ReadonlyArray<{ id: OxpFilter; key: OxpTextKey }> = [
  { id: "all", key: "oxpActivity.filter.all" },
  { id: "tools", key: "oxpActivity.filter.tools" },
  { id: "workers", key: "oxpActivity.filter.workers" },
  { id: "changes", key: "oxpActivity.filter.changes" },
  { id: "errors", key: "oxpActivity.filter.errors" },
]

function isWorkerish(item: OxpInvocationInfo) {
  return (
    item.plane !== "augmentation" ||
    item.links.some((link) => link.kind === "worker_session" || link.kind === "worker_group")
  )
}

export function matchesFilter(item: OxpInvocationInfo, filter: OxpFilter) {
  switch (filter) {
    case "all":
      return true
    case "tools":
      return !isWorkerish(item)
    case "workers":
      return isWorkerish(item)
    case "changes":
      return item.mutationAttempted || item.mutationCommitted
    case "errors":
      return isFailure(item)
  }
}

/**
 * Free-text filtering reads the compact projection only. Detail payloads stay
 * lazy, so typing in the filter box must never become a reason to fetch them.
 */
export function matchesQuery(item: OxpInvocationInfo, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const summary = summaryOf(item)
  const haystack: Array<string | undefined> = [
    item.tool,
    item.action,
    item.rootAlias,
    item.errorCode,
    item.status,
    str(summary, "path"),
    str(summary, "pattern"),
    str(summary, "include"),
    str(summary, "workdir"),
    str(summary, "handle"),
    str(summary, "mode"),
    str(summary, "branch"),
    str(summary, "ref"),
    str(summary, "agent"),
    str(summary, "capability"),
    str(summary, "namespace"),
    str(summary, "sessionID"),
    str(summary, "workerID"),
    ...summaryFiles(summary).map((file) => file.path),
    ...item.links.map((link) => link.label ?? link.ref),
  ]
  return haystack.some((value) => value !== undefined && value.toLowerCase().includes(needle))
}

/* ── Timeline shape ──────────────────────────────────────────────────────── */

export type TimelineEntry =
  | { kind: "day"; id: string; at: number }
  | { kind: "marker"; id: string; label: Phrase }
  | { kind: "invocation"; id: string; item: OxpInvocationInfo; concurrent: boolean }

function dayKey(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/**
 * Oldest first, the way a session transcript reads.
 *
 * The store keeps invocations newest-first because that is the pagination
 * order; reversing here (rather than in the store) keeps "load older" a pure
 * prepend and leaves the cache shape untouched.
 */
export function ascending(items: readonly OxpInvocationInfo[]) {
  return [...items].sort(
    (left, right) => numeric(left.startedAt) - numeric(right.startedAt) || left.id.localeCompare(right.id),
  )
}

/**
 * Chronological entries with the structural breaks a reader needs: a day rule,
 * a host-restart rule, an epoch rule, and the 20-minute handoff advisory.
 *
 * Overlapping calls are flagged rather than laid out in lanes. A lane layout
 * turns the transcript into a Gantt chart and destroys the single-column scan
 * that makes it readable; the flag is enough to explain a duration that runs
 * past the next row's start.
 */
export function timelineEntries(ordered: readonly OxpInvocationInfo[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let previousDay: string | undefined
  let previousHostRun: string | undefined
  let previousEpoch: number | undefined
  let furthestEnd = Number.NEGATIVE_INFINITY

  for (const item of ordered) {
    const startedAt = numeric(item.startedAt)
    const day = dayKey(startedAt)
    if (day !== previousDay) {
      entries.push({ kind: "day", id: `day:${item.id}`, at: startedAt })
      previousDay = day
    }

    const epoch = item.observedEpoch === undefined ? undefined : numeric(item.observedEpoch)
    if (previousHostRun !== undefined && item.hostRunID !== previousHostRun) {
      entries.push({ kind: "marker", id: `host:${item.id}`, label: t("oxpActivity.divider.hostRun") })
    } else if (previousEpoch !== undefined && epoch !== undefined && epoch !== previousEpoch) {
      entries.push({
        kind: "marker",
        id: `epoch:${item.id}`,
        label: t("oxpActivity.divider.epoch", { epoch }),
      })
    }
    previousHostRun = item.hostRunID
    if (epoch !== undefined) previousEpoch = epoch

    if (item.continuityMarker === "handoff_advisory") {
      entries.push({ kind: "marker", id: `handoff:${item.id}`, label: t("oxpActivity.divider.handoff") })
    }

    // A still-running call is open-ended, so letting it extend the overlap
    // window would paint every row beneath a long-lived background process with
    // a concurrency rail forever. A running row already reads as running; only
    // settled spans decide whether a *later* call overlapped something.
    const concurrent = startedAt < furthestEnd
    if (item.completedAt !== undefined) {
      const end = numeric(item.completedAt, startedAt)
      if (end > furthestEnd) furthestEnd = end
    }

    entries.push({ kind: "invocation", id: item.id, item, concurrent })
  }

  return entries
}

/* ── Header summary ──────────────────────────────────────────────────────── */

export type ActivitySpan = { firstSeenAt: number; lastSeenAt: number }

export function spanMs(activity: ActivitySpan) {
  return Math.max(0, numeric(activity.lastSeenAt) - numeric(activity.firstSeenAt))
}

/* ── Links ───────────────────────────────────────────────────────────────── */

export type LinkKind = OxpInvocationInfo["links"][number]["kind"]

export function linkKindKey(kind: LinkKind): OxpTextKey {
  return `oxpActivity.link.${kind}` as OxpTextKey
}

export function linkIcon(kind: LinkKind): OxpIcon {
  switch (kind) {
    case "session":
      return "speech-bubble"
    case "worker_session":
    case "worker_group":
      return "subagent"
    case "scheduled_task":
      return "status"
    case "process":
      return "console"
    case "root":
      return "folder"
    case "external_mcp":
      return "mcp"
    case "file_transfer":
      return "cloud-upload"
  }
}

export function isOpenableLink(kind: LinkKind) {
  return kind === "session" || kind === "worker_session" || kind === "scheduled_task"
}
