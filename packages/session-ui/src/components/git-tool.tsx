import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Icon } from "@opencode-ai/ui/icon"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { resolveFileDiff } from "./session-diff"
import { Markdown } from "./markdown"
import { SmartToolOutput } from "./tool-output"
import { ToolFileAccordion } from "./message-part"
import { ToolBadge, ToolBoundedList, ToolEmpty, ToolPath, ToolRow, ToolStats } from "./tool-parts"

function unescapeXml(text: string) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

function extractTag(text: string, name: string) {
  const match = new RegExp(`<${name}([^>]*)>([\\s\\S]*?)<\\/${name}>`).exec(text)
  if (!match) return undefined
  const attrs: Record<string, string> = {}
  for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = attr[2]!
  return { attrs, inner: match[2]! }
}

function extractStatusTag(text: string) {
  if (/<status\s+clean="true"\s*\/>/.test(text)) return { attrs: { clean: "true" }, inner: "" }
  return extractTag(text, "status")
}

function extractAll(text: string, tag: string) {
  return [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g"))].map((m) => unescapeXml(m[1]!))
}

type StatusEntry = { code: string; path: string }

function parseStatusEntries(lines: string[]): StatusEntry[] {
  return lines
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
    .filter((entry) => entry.path.length > 0)
}

type StatusTone = "add" | "modify" | "delete" | "untracked" | "conflict" | "neutral"

function statusTone(code: string): StatusTone {
  if (code.includes("U") || code === "AA" || code === "DD") return "conflict"
  if (code === "??") return "untracked"
  if (code.includes("A")) return "add"
  if (code.includes("D")) return "delete"
  if (code.includes("M") || code.includes("R") || code.includes("C")) return "modify"
  return "neutral"
}

const TONE_ORDER: StatusTone[] = ["conflict", "modify", "add", "delete", "untracked", "neutral"]

const TONE_BADGE: Record<StatusTone, "danger" | "warning" | "success" | "accent" | "neutral"> = {
  conflict: "danger",
  modify: "warning",
  add: "success",
  delete: "danger",
  untracked: "neutral",
  neutral: "neutral",
}

/**
 * Status is grouped by change kind and bounded.
 *
 * A repo mid-refactor can report 200+ paths; the previous rendering emitted one
 * unbounded row each, which buried everything after it in the conversation. The
 * counts are the headline, the paths are on demand.
 */
function GitStatusList(props: { entries: StatusEntry[] }) {
  const i18n = useI18n()

  const groups = createMemo(() => {
    const byTone = new Map<StatusTone, StatusEntry[]>()
    for (const entry of props.entries) {
      const tone = statusTone(entry.code)
      const list = byTone.get(tone) ?? []
      list.push(entry)
      byTone.set(tone, list)
    }
    return TONE_ORDER.flatMap((tone) => {
      const items = byTone.get(tone)
      return items?.length ? [{ tone, items }] : []
    })
  })

  const stats = createMemo(() =>
    groups().map((group) => ({
      label: i18n.t(`ui.tool.git.tone.${group.tone}` as never),
      value: String(group.items.length),
      tone: TONE_BADGE[group.tone] === "neutral" ? undefined : (TONE_BADGE[group.tone] as any),
    })),
  )

  return (
    <Show
      when={props.entries.length > 0}
      fallback={<ToolEmpty>{i18n.t("ui.tool.git.clean")}</ToolEmpty>}
    >
      <ToolStats items={stats()} />
      <ToolBoundedList items={props.entries} limit={10} scroll>
        {(entry) => (
          <ToolRow
            lead={<ToolBadge tone={TONE_BADGE[statusTone(entry.code)]} mono>{entry.code.trim() || "?"}</ToolBadge>}
            primary={<ToolPath path={entry.path} />}
            truncate="start"
          />
        )}
      </ToolBoundedList>
    </Show>
  )
}

const LOG_LINE = /^(\S+)\s*(\(.*?\))?\s*(.*)$/

function GitCommitList(props: { commits: string[] }) {
  const i18n = useI18n()
  return (
    <Show
      when={props.commits.length > 0}
      fallback={<div data-component="git-empty-state">{i18n.t("ui.tool.git.noCommits")}</div>}
    >
      <div data-component="git-log-list">
        <For each={props.commits}>
          {(line) => {
            const match = LOG_LINE.exec(line)
            const hash = match?.[1] ?? line
            const decoration = match?.[2]
            const subject = match?.[3] ?? ""
            return (
              <div data-slot="git-log-row">
                <span data-slot="git-log-hash">{hash}</span>
                <Show when={decoration}>
                  <span data-slot="git-log-decoration">{decoration!.slice(1, -1)}</span>
                </Show>
                <span data-slot="git-log-subject">{subject}</span>
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )
}

const DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/m

function countChanges(patch: string) {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions++
    else if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

function splitDiffFiles(diffText: string) {
  const trimmed = diffText.trim()
  if (!trimmed) return []
  return trimmed
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((segment) => {
      const header = DIFF_HEADER.exec(segment)
      return { file: header?.[2] ?? header?.[1] ?? "file", patch: segment, ...countChanges(segment) }
    })
}

function GitDiffFile(props: { file: string; patch: string; additions: number; deletions: number }) {
  const fileComponent = useFileComponent()
  const fileDiff = createMemo(() => resolveFileDiff({ file: props.file, patch: props.patch }))
  return (
    <ToolFileAccordion
      path={props.file}
      actions={<DiffChanges changes={{ additions: props.additions, deletions: props.deletions }} />}
    >
      <div data-component="git-diff-content">
        <Dynamic component={fileComponent} mode="diff" fileDiff={fileDiff()} hunkSeparators="simple" />
      </div>
    </ToolFileAccordion>
  )
}

function GitDiffView(props: { diffText: string }) {
  const i18n = useI18n()
  const files = createMemo(() => splitDiffFiles(props.diffText))
  return (
    <Show
      when={files().length > 0}
      fallback={<div data-component="git-empty-state">{i18n.t("ui.tool.git.noDiff")}</div>}
    >
      <div data-component="git-diff-list">
        <For each={files()}>
          {(file) => (
            <GitDiffFile file={file.file} patch={file.patch} additions={file.additions} deletions={file.deletions} />
          )}
        </For>
      </div>
    </Show>
  )
}

function GitStatusMode(props: { output: string }) {
  const tag = createMemo(() => extractStatusTag(props.output))
  return <GitStatusList entries={parseStatusEntries(extractAll(tag()?.inner ?? "", "entry"))} />
}

function GitSummaryMode(props: { output: string }) {
  const i18n = useI18n()
  const summary = createMemo(() => extractTag(props.output, "summary"))
  const recent = createMemo(() => extractTag(props.output, "recent"))
  const branch = createMemo(() => summary()?.attrs.branch)
  const entries = createMemo(() => parseStatusEntries(extractAll(summary()?.inner ?? "", "entry")))
  const commits = createMemo(() => extractAll(recent()?.inner ?? "", "commit"))

  return (
    <div data-component="git-summary">
      <Show when={branch()}>
        <div data-slot="git-branch-badge">
          <Icon name="branch" size="small" />
          <span>{branch()}</span>
        </div>
      </Show>
      <GitStatusList entries={entries()} />
      <Show when={commits().length > 0}>
        <div data-slot="git-summary-label">{i18n.t("ui.tool.git.recent")}</div>
        <GitCommitList commits={commits()} />
      </Show>
    </div>
  )
}

function GitDiffMode(props: { output: string }) {
  const tag = createMemo(() => extractTag(props.output, "diff"))
  return <GitDiffView diffText={unescapeXml(tag()?.inner ?? "")} />
}

function GitLogMode(props: { output: string }) {
  const tag = createMemo(() => extractTag(props.output, "log"))
  const lines = createMemo(() =>
    unescapeXml(tag()?.inner ?? "")
      .trim()
      .split("\n")
      .filter(Boolean),
  )
  return <GitCommitList commits={lines()} />
}

function GitRawMode(props: { output: string; tag: string }) {
  const tag = createMemo(() => extractTag(props.output, props.tag))
  return <pre data-component="git-raw">{unescapeXml(tag()?.inner ?? "").trim()}</pre>
}

function GitCommitMode(props: { output: string }) {
  const tag = createMemo(() => extractTag(props.output, "commit"))
  const applied = createMemo(() => tag()?.attrs.applied === "true")
  const hash = createMemo(() => extractTag(tag()?.inner ?? "", "commit")?.inner)
  const status = createMemo(() => extractStatusTag(tag()?.inner ?? ""))

  return (
    <div data-component="git-commit-result" data-applied={applied() ? "true" : undefined}>
      <Show when={hash()}>
        <div data-slot="git-commit-hash">
          <Icon name={applied() ? "circle-check" : "branch"} size="small" />
          <span>{unescapeXml(hash()!)}</span>
        </div>
      </Show>
      <Show when={status()}>
        <GitStatusList entries={parseStatusEntries(extractAll(status()!.inner, "entry"))} />
      </Show>
      <Show when={!applied()}>
        <pre data-component="git-raw">{unescapeXml(tag()?.inner ?? "").trim()}</pre>
      </Show>
    </div>
  )
}

function GitWorktreeChangeMode(props: { output: string; wrapper: string }) {
  const tag = createMemo(() => extractTag(props.output, props.wrapper))
  const status = createMemo(() => extractStatusTag(tag()?.inner ?? ""))
  return <GitStatusList entries={parseStatusEntries(extractAll(status()?.inner ?? "", "entry"))} />
}

export function GitOutput(props: { mode: string; output: string }) {
  return (
    <Switch fallback={<SmartToolOutput output={props.output} />}>
      <Match when={props.mode === "status"}>
        <GitStatusMode output={props.output} />
      </Match>
      <Match when={props.mode === "summary"}>
        <GitSummaryMode output={props.output} />
      </Match>
      <Match when={props.mode === "diff"}>
        <GitDiffMode output={props.output} />
      </Match>
      <Match when={props.mode === "log"}>
        <GitLogMode output={props.output} />
      </Match>
      <Match when={props.mode === "show"}>
        <GitRawMode output={props.output} tag="show" />
      </Match>
      <Match when={props.mode === "shell"}>
        <GitRawMode output={props.output} tag="git-shell" />
      </Match>
      <Match when={props.mode === "commit"}>
        <GitCommitMode output={props.output} />
      </Match>
      <Match when={props.mode === "stage"}>
        <GitWorktreeChangeMode output={props.output} wrapper="staged" />
      </Match>
      <Match when={props.mode === "unstage"}>
        <GitWorktreeChangeMode output={props.output} wrapper="unstaged" />
      </Match>
      <Match when={props.mode === "restore"}>
        <GitWorktreeChangeMode output={props.output} wrapper="restored" />
      </Match>
      <Match when={props.mode === "help"}>
        <Markdown text={props.output} />
      </Match>
    </Switch>
  )
}
