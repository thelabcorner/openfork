import type {
  OxpActivityStatus,
  OxpInvocationInfo,
} from "@opencode-ai/sdk/v2/client"
import { BasicToolV2 } from "@opencode-ai/session-ui/v2/basic-tool-v2"
import { Button } from "@opencode-ai/ui/button"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { DiffChanges } from "@opencode-ai/ui/v2/diff-changes-v2"
import { useNavigate, useParams } from "@solidjs/router"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { useOxpActivity } from "@/context/oxp-activity"
import { useServerSDK } from "@/context/server-sdk"
import { legacySessionHref } from "@/utils/session-route"

type TimelineFilter =
  | "all"
  | "augmentation"
  | "supervision"
  | "delegation"
  | "mutations"
  | "errors"
  | "workers"

const FILTERS: ReadonlyArray<{ id: TimelineFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "augmentation", label: "Augmentation" },
  { id: "supervision", label: "Supervision" },
  { id: "delegation", label: "Delegation" },
  { id: "mutations", label: "Mutations" },
  { id: "errors", label: "Errors" },
  { id: "workers", label: "Workers" },
]

const failureStatuses = new Set<OxpActivityStatus>([
  "cancelled_before_commit",
  "cancelled_after_commit",
  "denied",
  "conflict",
  "failed",
  "ambiguous_external_result",
  "interrupted",
])

function numeric(value: unknown, fallback = 0) {
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

function formatTime(value: unknown) {
  const time = numeric(value)
  return time > 0 ? new Date(time).toLocaleString() : "—"
}

function durationLabel(item: OxpInvocationInfo, now: number) {
  const start = numeric(item.startedAt)
  const end = item.completedAt === undefined ? now : numeric(item.completedAt, now)
  const ms = Math.max(0, end - start)
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = Math.floor(seconds / 60)
  const tail = Math.floor(seconds % 60)
  return `${minutes}m ${String(tail).padStart(2, "0")}s`
}

function statusLabel(status: OxpActivityStatus) {
  return status.replaceAll("_", " ")
}

function linkKindLabel(kind: OxpInvocationInfo["links"][number]["kind"]) {
  switch (kind) {
    case "session":
      return "Session"
    case "worker_session":
      return "Worker"
    case "worker_group":
      return "Worker group"
    case "scheduled_task":
      return "Scheduled task"
    case "process":
      return "Process"
    case "root":
      return "Root"
    case "external_mcp":
      return "External MCP"
    case "file_transfer":
      return "File"
  }
}

type SafeSummary = Record<string, unknown>
type SafeFileSummary = {
  path: string
  type?: string
  movePath?: string
  additions: number
  deletions: number
}

function asRecord(value: unknown): SafeSummary | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SafeSummary)
    : undefined
}

function safeSummaryOf(item: OxpInvocationInfo) {
  return asRecord((item as OxpInvocationInfo & { safeSummary?: unknown }).safeSummary)
}

function summaryText(summary: SafeSummary | undefined, key: string) {
  const value = summary?.[key]
  return typeof value === "string" && value ? value : undefined
}

function summaryNumber(summary: SafeSummary | undefined, key: string) {
  const value = summary?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function summaryBoolean(summary: SafeSummary | undefined, key: string) {
  const value = summary?.[key]
  return typeof value === "boolean" ? value : undefined
}

function summaryFiles(summary: SafeSummary | undefined): SafeFileSummary[] {
  if (!Array.isArray(summary?.files)) return []
  return summary.files.flatMap((value) => {
    const row = asRecord(value)
    const path = summaryText(row, "path")
    if (!path) return []
    return [{
      path,
      type: summaryText(row, "type"),
      movePath: summaryText(row, "movePath"),
      additions: summaryNumber(row, "additions") ?? 0,
      deletions: summaryNumber(row, "deletions") ?? 0,
    }]
  })
}

function summaryModel(summary: SafeSummary | undefined) {
  const model = asRecord(summary?.model)
  const providerID = summaryText(model, "providerID")
  const modelID = summaryText(model, "modelID")
  const variant = summaryText(model, "variant")
  if (!providerID || !modelID) return
  return `${providerID}/${modelID}${variant ? ` · ${variant}` : ""}`
}

function summaryRows(summary: SafeSummary | undefined) {
  const rows: Array<{ label: string; value: string }> = []
  const addText = (key: string, label: string) => {
    const value = summaryText(summary, key)
    if (value) rows.push({ label, value })
  }
  const addNumber = (key: string, label: string) => {
    const value = summaryNumber(summary, key)
    if (value !== undefined) rows.push({ label, value: value.toLocaleString() })
  }
  const addBoolean = (key: string, label: string) => {
    const value = summaryBoolean(summary, key)
    if (value !== undefined) rows.push({ label, value: value ? "Yes" : "No" })
  }

  addText("path", "Path")
  addText("kind", "Search")
  addText("pattern", "Pattern")
  addText("include", "Include")
  addText("root", "Root")
  addText("strategy", "Strategy")
  addText("format", "Format")
  addText("handle", "Handle")
  addText("workdir", "Working directory")
  addText("mode", "Mode")
  addText("branch", "Branch")
  addText("ref", "Ref")
  addText("workerID", "Worker")
  addText("batchID", "Worker group")
  addText("sessionID", "Session")
  addText("requestID", "Request")
  addText("agent", "Agent")
  addText("namespace", "Namespace")
  addText("capability", "Capability")
  addNumber("count", "Results")
  addNumber("lines", "Lines")
  addNumber("offset", "Offset")
  addNumber("entries", "Entries")
  addNumber("fileCount", "Files")
  addNumber("workerCount", "Workers")
  addNumber("exitCode", "Exit code")
  addNumber("outputBytes", "Output bytes")
  addNumber("retainedBytes", "Retained bytes")
  addNumber("bytes", "Bytes")
  addBoolean("directory", "Directory")
  addBoolean("attachment", "Attachment")
  addBoolean("applied", "Applied")
  addBoolean("changed", "Changed")
  addBoolean("running", "Running")
  const model = summaryModel(summary)
  if (model) rows.push({ label: "Model", value: model })
  return rows
}

function toolTitle(item: OxpInvocationInfo) {
  const base = item.tool
    .replace(/^openfork_/, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase())
  return item.action ? `${base} · ${item.action.replaceAll("_", " ")}` : base
}

function invocationPresentation(item: OxpInvocationInfo) {
  const summary = safeSummaryOf(item)
  const files = summaryFiles(summary)
  const changes = files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  )
  const changed = changes.additions > 0 || changes.deletions > 0

  let subtitle = item.rootAlias
  if (item.tool === "read") subtitle = summaryText(summary, "path") ?? subtitle
  else if (item.tool === "find") {
    const kind = summaryText(summary, "kind")
    const pattern = summaryText(summary, "pattern")
    subtitle = [kind, pattern].filter(Boolean).join(" · ") || subtitle
  } else if (item.tool === "edit" || item.tool === "write" || item.tool === "patch") {
    subtitle = files.length === 1 ? files[0]!.path : files.length > 1 ? `${files.length} files` : subtitle
  } else if (item.tool === "process") {
    subtitle = summaryText(summary, "handle") ?? summaryText(summary, "workdir") ?? subtitle
  } else if (item.tool === "git") {
    subtitle =
      summaryText(summary, "branch") ??
      summaryText(summary, "ref") ??
      summaryText(summary, "workdir") ??
      subtitle
  } else if (item.tool === "openfork_worker") {
    subtitle =
      summaryText(summary, "workerID") ??
      summaryText(summary, "batchID") ??
      (summaryNumber(summary, "workerCount") ? `${summaryNumber(summary, "workerCount")} workers` : subtitle)
  } else if (item.tool === "openfork_session") {
    subtitle = summaryText(summary, "sessionID") ?? subtitle
  } else if (item.tool === "openfork_request") {
    subtitle = summaryText(summary, "requestID") ?? summaryText(summary, "sessionID") ?? subtitle
  } else if (item.tool === "capability") {
    const namespace = summaryText(summary, "namespace")
    const capability = summaryText(summary, "capability")
    subtitle = [namespace, capability].filter(Boolean).join(" / ") || subtitle
  }

  const args: string[] = []
  const count = summaryNumber(summary, "count")
  const lines = summaryNumber(summary, "lines")
  const entries = summaryNumber(summary, "entries")
  const applied = summaryNumber(summary, "applied")
  const outputBytes = summaryNumber(summary, "outputBytes")
  const exitCode = summaryNumber(summary, "exitCode")
  const model = summaryModel(summary)
  if (count !== undefined) args.push(`${count} results`)
  if (lines !== undefined) args.push(`${lines} lines`)
  if (entries !== undefined) args.push(`${entries} entries`)
  if (applied !== undefined) args.push(`${applied} edits`)
  if (outputBytes !== undefined) args.push(`${outputBytes.toLocaleString()} B`)
  if (exitCode !== undefined) args.push(`exit ${exitCode}`)
  if (model) args.push(model)
  if (
    summaryBoolean(summary, "truncated") ||
    summaryBoolean(summary, "pageTruncated") ||
    summaryBoolean(summary, "summaryTruncated") ||
    summaryBoolean(summary, "filesTruncated")
  )
    args.push("truncated")

  return {
    summary,
    files,
    rows: summaryRows(summary),
    changes: changed ? changes : undefined,
    subtitle,
    args,
  }
}

function filterMatches(item: OxpInvocationInfo, filter: TimelineFilter) {
  if (filter === "all") return true
  if (
    filter === "augmentation" ||
    filter === "supervision" ||
    filter === "delegation"
  )
    return item.plane === filter
  if (filter === "mutations")
    return item.mutationAttempted || item.mutationCommitted
  if (filter === "errors") return failureStatuses.has(item.status)
  return (
    item.tool === "openfork_worker" ||
    item.links.some(
      (link) =>
        link.kind === "worker_session" || link.kind === "worker_group",
    )
  )
}

function timelineGeometry(items: readonly OxpInvocationInfo[], now: number) {
  const ordered = [...items].sort(
    (left, right) =>
      numeric(left.startedAt) - numeric(right.startedAt) ||
      left.id.localeCompare(right.id),
  )
  const laneEnds: number[] = []
  const lanes = new Map<string, number>()
  const overlaps = new Set<string>()
  let furthestEnd = Number.NEGATIVE_INFINITY
  let furthestID: string | undefined

  for (const item of ordered) {
    const start = numeric(item.startedAt)
    const end =
      item.completedAt === undefined ? now : numeric(item.completedAt, now)
    let lane = laneEnds.findIndex((candidate) => candidate <= start)
    if (lane < 0) lane = laneEnds.length
    laneEnds[lane] = Math.max(start, end)
    lanes.set(item.id, lane)

    if (start < furthestEnd && furthestID) {
      overlaps.add(item.id)
      overlaps.add(furthestID)
    }
    if (end > furthestEnd) {
      furthestEnd = end
      furthestID = item.id
    }
  }
  return { lanes, overlaps }
}

function InvocationTimelineItem(props: {
  item: OxpInvocationInfo
  now: number
  lane: number
  overlaps: boolean
  linkBusy?: string
  onOpenSession: (sessionID: string) => void
  onOpenScheduled: () => void
}) {
  const view = createMemo(() => invocationPresentation(props.item))
  const mutation = () =>
    props.item.mutationCommitted
      ? "committed"
      : props.item.mutationAttempted
        ? "attempted"
        : undefined
  const statusTone = () =>
    failureStatuses.has(props.item.status)
      ? "text-v2-state-fg-danger"
      : props.item.status === "running"
        ? "text-v2-state-fg-info"
        : props.item.status === "committed"
          ? "text-v2-state-fg-success"
          : "text-v2-text-text-muted"

  return (
    <div
      class="rounded-[8px] border border-v2-border-border-subtle bg-v2-background-bg-layer-01 px-3 py-1.5"
      classList={{ "border-l-2 border-l-v2-border-border-base": props.overlaps }}
      style={{
        "margin-left": `${Math.min(props.lane * 12, 48)}px`,
        "content-visibility": "auto",
        "contain-intrinsic-size": "84px",
      }}
    >
      <BasicToolV2
        status={props.item.status}
        trigger={{
          title: toolTitle(props.item),
          subtitle: view().subtitle,
          args: view().args,
          changes: view().changes,
          action: (
            <span class={`ml-auto shrink-0 text-[11px] tabular-nums ${statusTone()}`}>
              {durationLabel(props.item, props.now)}
            </span>
          ),
        }}
      >
        <div class="flex min-w-0 flex-col gap-2 border-t border-v2-border-border-subtle pt-2">
          <Show when={view().files.length > 0}>
            <div class="overflow-hidden rounded-[6px] border border-v2-border-border-subtle bg-v2-background-bg-base">
              <For each={view().files}>
                {(file) => (
                  <div class="flex min-w-0 items-center gap-2 border-b border-v2-border-border-subtle px-2.5 py-1.5 last:border-b-0">
                    <span class="min-w-0 flex-1 truncate text-[12px] leading-4 text-v2-text-text-base" title={file.path}>
                      {file.path}
                      <Show when={file.movePath}>
                        {(target) => <span class="text-v2-text-text-muted"> → {target()}</span>}
                      </Show>
                    </span>
                    <Show when={file.type}>
                      {(type) => (
                        <span class="shrink-0 text-[10px] uppercase tracking-[0.04em] text-v2-text-text-faint">
                          {type()}
                        </span>
                      )}
                    </Show>
                    <Show when={file.additions > 0 || file.deletions > 0}>
                      <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="grid grid-cols-2 gap-x-5 gap-y-1 text-[11px] leading-4 sm:grid-cols-4">
            <DetailField label="Status" value={statusLabel(props.item.status)} valueClass={statusTone()} />
            <DetailField label="Plane" value={props.item.plane} />
            <DetailField label="Started" value={formatTime(props.item.startedAt)} />
            <DetailField label="Duration" value={durationLabel(props.item, props.now)} />
            <Show when={props.item.rootAlias}>
              {(root) => <DetailField label="Root" value={root()} />}
            </Show>
            <Show when={props.item.observedEpoch !== undefined}>
              <DetailField label="Epoch" value={String(numeric(props.item.observedEpoch))} />
            </Show>
            <Show when={mutation()}>
              {(value) => <DetailField label="Mutation" value={value()} />}
            </Show>
            <Show when={props.item.errorCode}>
              {(code) => <DetailField label="Error" value={code()} valueClass="text-v2-state-fg-danger" />}
            </Show>
          </div>

          <Show when={view().rows.length > 0}>
            <div class="grid gap-x-5 gap-y-1 rounded-[6px] bg-v2-background-bg-base px-2.5 py-2 text-[11px] leading-4 sm:grid-cols-2">
              <For each={view().rows}>
                {(row) => (
                  <div class="flex min-w-0 gap-2">
                    <span class="w-24 shrink-0 text-[10px] text-v2-text-text-faint">{row.label}</span>
                    <span class="min-w-0 flex-1 truncate text-[11px] tabular-nums text-v2-text-text-muted" title={row.value}>
                      {row.value}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={props.item.links.length > 0}>
            <div class="flex flex-wrap gap-1">
              <For each={props.item.links}>
                {(link) => {
                  const session = link.kind === "session" || link.kind === "worker_session"
                  const task = link.kind === "scheduled_task"
                  const label = () => `${linkKindLabel(link.kind)} · ${link.label ?? link.ref}`
                  return (
                    <Show
                      when={session || task}
                      fallback={
                        <span
                          class="inline-flex h-6 max-w-[340px] items-center truncate rounded-[5px] border border-v2-border-border-subtle bg-v2-background-bg-base px-2 text-[10.5px] text-v2-text-text-muted"
                          title={link.ref}
                        >
                          {label()}
                        </span>
                      }
                    >
                      <button
                        type="button"
                        disabled={session && props.linkBusy === link.ref}
                        class="h-6 max-w-[340px] truncate rounded-[5px] border border-v2-border-border-subtle bg-v2-background-bg-base px-2 text-[10.5px] text-v2-text-text-muted transition-colors hover:border-v2-border-border-base hover:text-v2-text-text-base disabled:opacity-50"
                        title={link.ref}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (session) props.onOpenSession(link.ref)
                          else props.onOpenScheduled()
                        }}
                      >
                        {label()}
                      </button>
                    </Show>
                  )
                }}
              </For>
            </div>
          </Show>

          <div class="flex min-w-0 flex-wrap gap-x-4 gap-y-1 border-t border-v2-border-border-subtle pt-2 text-[10px] text-v2-text-text-faint">
            <span class="truncate" title={props.item.id}>invocation {props.item.id}</span>
            <span class="truncate" title={props.item.hostRunID}>host {props.item.hostRunID}</span>
          </div>
        </div>
      </BasicToolV2>
    </div>
  )
}

function DetailField(props: { label: string; value: string; valueClass?: string }) {
  return (
    <div class="min-w-0">
      <div class="text-[9px] font-[560] uppercase tracking-[0.055em] text-v2-text-text-faint">{props.label}</div>
      <div class={`truncate text-[11px] text-v2-text-text-muted ${props.valueClass ?? ""}`}>{props.value}</div>
    </div>
  )
}

export function OxpActivityPage() {
  const params = useParams<{ activityID: string }>()
  const navigate = useNavigate()
  const store = useOxpActivity()
  const serverSDK = useServerSDK()
  const [filter, setFilter] = createSignal<TimelineFilter>("all")
  const [now, setNow] = createSignal(Date.now())
  const [titleDraft, setTitleDraft] = createSignal("")
  const [editingTitle, setEditingTitle] = createSignal(false)
  const [savingTitle, setSavingTitle] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [busyAction, setBusyAction] = createSignal<"archive" | "delete" | undefined>()
  const [linkBusy, setLinkBusy] = createSignal<string | undefined>()

  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(() => {
    const activityID = params.activityID
    store.ensureLoaded()
    void store.refreshOne(activityID)
    store.ensureInvocations(activityID)
  })

  const summary = createMemo(() => store.activity(params.activityID))
  const detail = createMemo(() => store.detail(params.activityID))

  createEffect(() => {
    const value = summary()
    if (!value || editingTitle()) return
    setTitleDraft(value.title ?? "")
  })

  const geometry = createMemo(() =>
    timelineGeometry(detail()?.items ?? [], now()),
  )
  const visible = createMemo(() =>
    (detail()?.items ?? []).filter((item) => filterMatches(item, filter())),
  )
  const segmentBoundaries = createMemo(() => {
    const items = detail()?.items ?? []
    const boundaries = new Map<string, string>()
    for (let index = 0; index + 1 < items.length; index++) {
      const current = items[index]!
      const older = items[index + 1]!
      if (current.hostRunID !== older.hostRunID) {
        boundaries.set(
          current.id,
          current.observedEpoch === undefined
            ? "Host observation restarted"
            : `Host observation restarted · epoch ${numeric(current.observedEpoch)}`,
        )
        continue
      }
      if (
        current.observedEpoch !== undefined &&
        current.observedEpoch !== older.observedEpoch
      ) {
        boundaries.set(
          current.id,
          `Observed epoch ${numeric(current.observedEpoch)} began`,
        )
      }
    }
    return boundaries
  })

  const saveTitle = async () => {
    setSavingTitle(true)
    try {
      const value = titleDraft().trim()
      await store.rename(params.activityID, value || undefined)
      setEditingTitle(false)
    } finally {
      setSavingTitle(false)
    }
  }

  const archive = async () => {
    setBusyAction("archive")
    try {
      await store.archive(params.activityID, true)
      navigate("/oxp")
    } finally {
      setBusyAction(undefined)
    }
  }

  const remove = async () => {
    setBusyAction("delete")
    try {
      await store.remove(params.activityID)
      navigate("/oxp")
    } finally {
      setBusyAction(undefined)
    }
  }

  const openNativeSession = async (sessionID: string) => {
    setLinkBusy(sessionID)
    try {
      const response = await serverSDK().client.global.sessionGet(
        { sessionID },
        { throwOnError: true },
      )
      const session = response.data
      if (!session?.directory) return
      navigate(legacySessionHref(session.directory, session.id))
    } finally {
      setLinkBusy(undefined)
    }
  }

  return (
    <div
      data-component="oxp-activity-page"
      class="m-2 flex min-h-0 min-w-0 flex-1 self-stretch flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"
    >
      <header class="shrink-0 border-b border-border-weaker-base px-5 py-3">
        <div class="flex min-w-0 items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="mb-1 flex items-center gap-2 text-[10px] font-[600] uppercase tracking-[0.08em] text-text-weak">
              <span>ChatGPT / OXP</span>
              <span class="font-normal normal-case tracking-normal">
                durable activity
              </span>
            </div>
            <Show
              when={editingTitle()}
              fallback={
                <button
                  type="button"
                  class="max-w-full truncate text-left text-14-medium text-text-strong hover:underline"
                  onClick={() => setEditingTitle(true)}
                >
                  {summary()?.title ??
                    summary()?.lastRootAlias ??
                    "ChatGPT activity"}
                </button>
              }
            >
              <div class="flex max-w-[520px] items-center gap-1.5">
                <input
                  value={titleDraft()}
                  maxlength={256}
                  autofocus
                  class="h-7 min-w-0 flex-1 rounded border border-border-base bg-background-base px-2 text-12-regular text-text-strong outline-none focus:border-border-strong"
                  onInput={(event) => setTitleDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveTitle()
                    if (event.key === "Escape") setEditingTitle(false)
                  }}
                />
                <Button
                  size="small"
                  variant="primary"
                  disabled={savingTitle()}
                  onClick={() => void saveTitle()}
                >
                  Save
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => setEditingTitle(false)}
                >
                  Cancel
                </Button>
              </div>
            </Show>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Button
              size="small"
              variant="ghost"
              onClick={() => void store.refreshInvocations(params.activityID)}
            >
              Refresh
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={busyAction() !== undefined}
              onClick={() => void archive()}
            >
              Archive
            </Button>
            <Show
              when={confirmDelete()}
              fallback={
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete history
                </Button>
              }
            >
              <Button
                size="small"
                variant="primary"
                disabled={busyAction() !== undefined}
                onClick={() => void remove()}
              >
                Confirm delete
              </Button>
              <Button
                size="small"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </Show>
          </div>
        </div>

        <Show when={summary()}>
          {(activity) => (
            <div class="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3 xl:grid-cols-6">
              <Metric label="Calls" value={numeric(activity().callCount)} />
              <Metric label="Failures" value={numeric(activity().failureCount)} />
              <Metric
                label="Epochs"
                value={numeric(activity().observedEpochCount)}
              />
              <Metric label="First seen" value={formatTime(activity().firstSeenAt)} />
              <Metric label="Last seen" value={formatTime(activity().lastSeenAt)} />
              <Metric label="Last tool" value={activity().lastTool ?? "—"} />
            </div>
          )}
        </Show>
      </header>

      <div class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border-weaker-base px-5 py-2">
        <For each={FILTERS}>
          {(item) => (
            <button
              type="button"
              class="h-6 shrink-0 rounded px-2 text-[11px] font-[520] transition-colors"
              classList={{
                "bg-surface-base text-text-strong": filter() === item.id,
                "text-text-weak hover:bg-surface-base hover:text-text-strong":
                  filter() !== item.id,
              }}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          )}
        </For>
        <span class="ml-auto shrink-0 text-[10px] tabular-nums text-text-weak">
          {visible().length} loaded
        </span>
      </div>

      <ScrollView class="min-h-0 flex-1">
        <main class="px-5 py-4">
        <Show
          when={summary()}
          fallback={
            <div class="py-10 text-center text-12-regular text-text-weak">
              {store.error() ? "Unable to load OXP activity." : "Loading activity…"}
            </div>
          }
        >
          <Show
            when={visible().length > 0}
            fallback={
              <div class="py-10 text-center text-12-regular text-text-weak">
                {detail()?.loading
                  ? "Loading invocation spans…"
                  : "No invocation spans match this filter."}
              </div>
            }
          >
            <div class="mx-auto flex w-full max-w-[1100px] flex-col gap-1.5">
              <For each={visible()}>
                {(item) => {
                  const lane = () => geometry().lanes.get(item.id) ?? 0
                  const overlaps = () => geometry().overlaps.has(item.id)
                  return (
                    <>
                      <Show when={item.continuityMarker === "handoff_advisory"}>
                        <div
                          class="flex items-center gap-2 py-1 text-[10px] font-[560] uppercase tracking-[0.05em] text-text-weak"
                          style={{
                            "margin-left": `${Math.min(lane() * 12, 48)}px`,
                          }}
                        >
                          <span class="h-px min-w-4 flex-1 bg-border-weaker-base" />
                          <span>Continuity · 20-minute handoff advisory delivered</span>
                          <span class="h-px min-w-4 flex-1 bg-border-weaker-base" />
                        </div>
                      </Show>
                      <InvocationTimelineItem
                        item={item}
                        now={now()}
                        lane={lane()}
                        overlaps={overlaps()}
                        linkBusy={linkBusy()}
                        onOpenSession={(sessionID) => void openNativeSession(sessionID)}
                        onOpenScheduled={() => navigate("/scheduled")}
                      />
                      <Show when={segmentBoundaries().get(item.id)}>
                        {(label) => (
                          <div
                            class="flex items-center gap-2 py-1 text-[10px] font-[520] text-text-weak"
                            style={{
                              "margin-left": `${Math.min(lane() * 12, 48)}px`,
                            }}
                          >
                            <span class="h-px min-w-4 flex-1 bg-border-weaker-base" />
                            <span>{label()}</span>
                            <span class="h-px min-w-4 flex-1 bg-border-weaker-base" />
                          </div>
                        )}
                      </Show>
                    </>
                  )
                }}
              </For>
              <Show when={detail()?.more}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={detail()?.loading}
                  onClick={() => void store.loadMore(params.activityID)}
                >
                  {detail()?.loading ? "Loading…" : "Load older spans"}
                </Button>
              </Show>
              <Show when={detail()?.capped}>
                <div class="py-2 text-center text-[10px] text-text-weak">
                  Renderer history cache is capped at 2,000 spans. Refreshing this activity keeps the newest window bounded.
                </div>
              </Show>
            </div>
          </Show>
        </Show>
        </main>
      </ScrollView>
    </div>
  )
}

export function OxpActivityLandingPage() {
  const navigate = useNavigate()
  const store = useOxpActivity()

  createEffect(() => {
    store.ensureLoaded()
    if (!store.loaded()) return
    const next = store.activities()[0]
    if (next) navigate(`/oxp/activity/${next.id}`, { replace: true })
  })

  return (
    <div
      data-component="oxp-activity-page"
      class="m-2 flex min-h-0 min-w-0 flex-1 self-stretch flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"
    >
      <div class="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <div class="max-w-sm">
          <div class="text-[13px] font-[560] text-v2-text-text-base">
            {store.loading() ? "Loading OXP activity…" : "No OXP activity yet"}
          </div>
          <Show when={!store.loading()}>
            <div class="mt-1 text-[11px] leading-4 text-v2-text-text-muted">
              ChatGPT/OXP tool activity will appear here as soon as this OpenFork instance observes a correlated parent.
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

function Metric(props: { label: string; value: string | number }) {
  return (
    <div class="min-w-0">
      <div class="text-[9.5px] font-[560] uppercase tracking-[0.06em] text-text-weak">
        {props.label}
      </div>
      <div class="truncate text-[11.5px] tabular-nums text-text-strong">
        {props.value}
      </div>
    </div>
  )
}
