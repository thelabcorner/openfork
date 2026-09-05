import type { Component } from "solid-js"
import { Show } from "solid-js"
import type { JSX } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import {
  IconArchive,
  IconBot,
  IconBrain,
  IconCheckCircle,
  IconDatabase,
  IconEye,
  IconFileEdit,
  IconFolder,
  IconGitBranch,
  IconGlobe,
  IconGrid,
  IconPackage,
  IconRotateCcw,
  IconSearch,
  IconShieldCheck,
  IconTerminal,
  IconWrench,
  IconZap,
} from "../../icons"
import { fileDir, fileName as baseName } from "../../format"
import { inputString } from "./shared"
import type { DiffCounts } from "./edit"
import { EditToolBody, HeadDiffStat, WriteToolBody } from "./edit"
import { PatchToolBody, patchFilesOf } from "./patch"
import { GlobToolBody, GrepToolBody, ReadToolBody, parseGlobOutput, parseGrepOutput } from "./search"
import { FetchDetail, TaskSummary, TodoToolBody, WebSearchBody, webSearchLabel } from "./misc"
import { ShellExitBadge, ShellHeadTimer, ShellToolBody } from "./shell"
import {
  ArchiveBody,
  BackgroundBody,
  CheckpointBody,
  GenericBody,
  GitBody,
  JsonBody,
  LspBody,
  MemoryBody,
  MonitorBody,
  ProjectBody,
  RefactorBody,
  SessionBody,
  SkillBody,
  SymbolsBody,
  TestBody,
  TypecheckBody,
  partMetadata,
  partOutput,
} from "./builtins"
import { WebfetchBody } from "./webfetch"
import { Chip } from "./primitives"
import { parseCheckpoints, parseGit, parseJsonValidate, parseSymbols, parseTest, parseTypecheck } from "./parse"

export type KillShellFn = (input: {
  sessionID: string
  callID?: string
  jobId?: string
}) => Promise<{ killed?: boolean } | undefined>

export type RowContext = {
  part: ToolPart
  killShell?: KillShellFn
}

export type ToolDescriptor = {
  icon: Component<{ size?: number }>
  title: (part: ToolPart) => string
  detail?: (part: ToolPart) => JSX.Element
  meta?: Component<RowContext>
  body?: (ctx: RowContext) => JSX.Element
  /** Pure status row — no chevron, no expandable body. */
  hideDetails?: boolean
  /** Optional visibility gate (e.g. question tools render once resolved). */
  shouldRender?: (part: ToolPart) => boolean
}

const LABELS: Record<string, string> = {
  read: "Read",
  list: "List",
  glob: "Glob",
  grep: "Grep",
  shell: "Shell",
  bash: "Shell",
  edit: "Edit",
  write: "Write",
  patch: "Patch",
  apply_patch: "Patch",
  multiedit: "Edit",
  task: "Task",
  todowrite: "Todos",
  todoread: "Todos",
  webfetch: "Fetch",
  fetch: "Fetch",
  git: "Git",
  sqlite: "SQLite",
  sympy: "SymPy",
  json: "JSON",
  archive: "Archive",
  background: "Background",
  skill: "Skill",
  question: "Asked",
  typecheck: "Types",
  test: "Test",
  memory: "Memory",
  session: "Session",
  project: "Project",
  symbols: "Symbols",
  monitor: "Monitor",
  checkpoint: "Checkpoint",
  lsp: "LSP",
  refactor: "Refactor",
  websearch: "Search",
}

// Server-side tool names fold onto their primary renderer wherever they differ.
export const TOOL_ALIASES: Record<string, string> = {
  bash: "shell",
  apply_patch: "patch",
  multiedit: "edit",
  fetch: "webfetch",
}

export function labelFor(partOrTool: ToolPart | string): string {
  const tool = typeof partOrTool === "string" ? partOrTool : partOrTool.tool
  return LABELS[tool] ?? (tool ? tool.charAt(0).toUpperCase() + tool.slice(1) : "Tool")
}

function outputOf(part: ToolPart): string {
  const state = part.state
  const out =
    state.status === "completed" || state.status === "error" ? (state as { output?: string }).output : undefined
  return (out ?? "").replace(/\r\n/g, "\n")
}

// --- collapsed-head detail renderers -------------------------------------------------

function FilePathDetail(props: { part: ToolPart }) {
  const path = () => inputString(props.part, "filePath", "path") ?? ""
  const description = () => {
    const input = props.part.state.input as Record<string, unknown> | undefined
    return typeof input?.description === "string" ? input.description : ""
  }
  return (
    <Show when={path()} fallback={<Show when={description()}><span>{description()}</span></Show>}>
      <span class="detail-path">
        <span class="dir">{fileDir(path())}</span>
        <span class="base">{baseName(path())}</span>
      </span>
    </Show>
  )
}

function PatternDetail(props: { part: ToolPart }) {
  const raw = () => {
    const input = props.part.state.input as Record<string, unknown> | undefined
    const candidate = input?.pattern ?? input?.include ?? input?.query ?? input?.filePath ?? input?.path
    return typeof candidate === "string" ? candidate : ""
  }
  return (
    <Show when={raw()}>
      <code class="detail-pattern">{raw()}</code>
    </Show>
  )
}

function CommandDetail(props: { part: ToolPart }) {
  const line = () => {
    const command = inputString(props.part, "command", "script")
    if (!command) return ""
    const flat = command.replace(/\s+/g, " ").trim()
    return flat.length > 72 ? flat.slice(0, 71) + "…" : flat
  }
  return (
    <Show when={line()}>
      <code class="detail-command">{line()}</code>
    </Show>
  )
}

function TaskDetail(props: { part: ToolPart }) {
  const agent = () => inputString(props.part, "subagentType", "agent") ?? ""
  const desc = () => {
    const input = props.part.state.input as Record<string, unknown> | undefined
    const candidate = input?.description ?? input?.prompt
    if (typeof candidate !== "string") return ""
    return candidate.length > 64 ? candidate.slice(0, 63) + "…" : candidate
  }
  return (
    <span class="detail-task">
      <Show when={agent()}>
        <span class="agent">{agent()}</span>
      </Show>
      <Show when={desc()}>
        <span class="desc">{desc()}</span>
      </Show>
    </span>
  )
}

// --- collapsed-head meta chips -------------------------------------------------------

function GrepMeta(props: RowContext) {
  const result = () => parseGrepOutput(outputOf(props.part))
  return <Show when={result()}>{(value) => <span class="count-pill tnum">{value().total}</span>}</Show>
}

function GlobMeta(props: RowContext) {
  const count = () => parseGlobOutput(outputOf(props.part))?.files.length
  return <Show when={count()}>{(n) => <span class="count-pill tnum">{n()}</span>}</Show>
}

function PatchMeta(props: RowContext) {
  const totals = (): DiffCounts => {
    let additions = 0
    let deletions = 0
    for (const file of patchFilesOf(props.part)) {
      additions += file.counts.additions
      deletions += file.counts.deletions
    }
    return { additions, deletions }
  }
  return (
    <Show when={totals().additions > 0 || totals().deletions > 0}>
      <span class="diff-stat compact tnum">
        <Show when={totals().additions > 0}>
          <span class="add">+{totals().additions}</span>
        </Show>
        <Show when={totals().deletions > 0}>
          <span class="del">−{totals().deletions}</span>
        </Show>
      </span>
    </Show>
  )
}

function ShellMeta(props: RowContext) {
  return (
    <>
      <ShellHeadTimer part={props.part} />
      <ShellExitBadge part={props.part} />
    </>
  )
}

// --- outcome chips ---------------------------------------------------------------------
// The collapsed row reports what a call *returned*, not just what it was asked
// to do: 3 errors, 12 symbols, valid, +4 -1. Without this you have to expand a
// row to learn it did nothing.

function CountMeta(props: { value: () => string | undefined; tone?: "ok" | "warn" | "bad" | "accent" }) {
  return <Show when={props.value()}>{(text) => <Chip tone={props.tone ?? "accent"}>{text()}</Chip>}</Show>
}

function ReadMeta(props: RowContext) {
  const total = () => {
    const display = partMetadata(props.part).display as { totalLines?: unknown } | undefined
    const value = display?.totalLines
    return typeof value === "number" ? `${value} lines` : undefined
  }
  return <CountMeta value={total} tone="accent" />
}

function TypecheckMeta(props: RowContext) {
  const parsed = () => parseTypecheck(partOutput(props.part))
  return (
    <Show when={parsed()}>
      {(result) => (
        <Chip tone={result().diagnostics.length ? "bad" : "ok"}>
          {result().diagnostics.length ? `${result().diagnostics.length} errors` : "clean"}
        </Chip>
      )}
    </Show>
  )
}

function TestMeta(props: RowContext) {
  const meta = () => partMetadata(props.part)
  const num = (key: string) => {
    const value = meta()[key]
    return typeof value === "number" ? value : undefined
  }
  return (
    <Show when={num("passed") !== undefined || num("failed") !== undefined}>
      <span class="test-meta tnum">
        <Show when={num("passed")}>
          <span class="ok">{num("passed")}</span>
        </Show>
        <Show when={num("failed")}>
          <span class="bad">{num("failed")}</span>
        </Show>
      </span>
    </Show>
  )
}

function SymbolsMeta(props: RowContext) {
  const count = () => {
    const n = parseSymbols(partOutput(props.part)).length
    return n ? String(n) : undefined
  }
  return <CountMeta value={count} />
}

function JsonMeta(props: RowContext) {
  const parsed = () => parseJsonValidate(partOutput(props.part))
  return (
    <Show when={parsed()}>{(result) => <Chip tone={result().ok ? "ok" : "bad"}>{result().ok ? "valid" : "invalid"}</Chip>}</Show>
  )
}

function GitMeta(props: RowContext) {
  const mode = () => {
    const input = props.part.state.input as Record<string, unknown> | undefined
    return typeof input?.mode === "string" ? input.mode : "status"
  }
  const count = () => {
    const parsed = parseGit(mode(), partOutput(props.part))
    if (!parsed) return undefined
    if (parsed.mode === "status") return parsed.entries.length ? `${parsed.entries.length} changed` : "clean"
    if (parsed.mode === "summary") return parsed.entries.length ? `${parsed.entries.length} changed` : "clean"
    if (parsed.mode === "log") return `${parsed.commits.length} commits`
    return undefined
  }
  return <CountMeta value={count} />
}

function CheckpointMeta(props: RowContext) {
  const count = () => {
    const parsed = parseCheckpoints(partOutput(props.part))
    return parsed && parsed.list.length ? String(parsed.list.length) : undefined
  }
  return <CountMeta value={count} />
}

function TestFilesMeta(props: RowContext) {
  const count = () => {
    const parsed = parseTest(partOutput(props.part))
    return parsed?.kind === "list" && parsed.files.length ? `${parsed.files.length} files` : undefined
  }
  return <CountMeta value={count} />
}

// --- background jobs -------------------------------------------------------------------

function BackgroundMeta(props: RowContext) {
  const status = () => {
    const meta = ((props.part.state as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>
    return typeof meta.status === "string" ? meta.status : undefined
  }
  const exit = () => {
    const meta = ((props.part.state as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>
    return typeof meta.exit === "number" ? meta.exit : undefined
  }
  return (
    <>
      <Show when={status()}>
        {(value) => <span class={`job-badge ${value()}`}>{value()}</span>}
      </Show>
      <Show when={exit() !== undefined && status() !== "running"}>
        <span class={`exit-badge tnum ${exit() === 0 ? "ok" : "fail"}`}>exit {exit()}</span>
      </Show>
      <ShellHeadTimer part={props.part} />
    </>
  )
}

// --- question -------------------------------------------------------------------------

type QuestionEntry = { question: string; answer: string }

function questionsOf(part: ToolPart): QuestionEntry[] {
  const meta = ((part.state as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>
  const answers = Array.isArray(meta.answers) ? (meta.answers as unknown[]) : []
  const input = part.state.input as { questions?: unknown } | undefined
  const list = Array.isArray(input?.questions) ? (input!.questions as unknown[]) : []
  const out: QuestionEntry[] = []
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as { question?: unknown } | undefined
    const question = entry && typeof entry.question === "string" ? entry.question : ""
    if (!question) continue
    const answerRaw = answers[i]
    out.push({
      question,
      answer: Array.isArray(answerRaw) ? answerRaw.filter(Boolean).map(String).join(", ") : "",
    })
  }
  return out
}

function QuestionsBody(props: { part: ToolPart }) {
  const entries = questionsOf(props.part)
  return (
    <div class="qa-list">
      {entries.map((entry) => (
        <div class="qa-row">
          <span class="q">{entry.question}</span>
          <span class="a">{entry.answer || "—"}</span>
        </div>
      ))}
    </div>
  )
}

function questionResolved(part: ToolPart): boolean {
  const meta = ((part.state as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>
  return Array.isArray(meta.answers) && (meta.answers as unknown[]).length > 0
}

// --- registry table -------------------------------------------------------------------

const DESCRIPTORS: Record<string, ToolDescriptor> = {
  read: {
    icon: IconEye,
    title: labelFor,
    detail: (part) => <FilePathDetail part={part} />,
    meta: ReadMeta,
    body: (ctx) => <ReadToolBody part={ctx.part} />,
  },
  glob: {
    icon: IconSearch,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    meta: GlobMeta,
    body: (ctx) => <GlobToolBody part={ctx.part} />,
  },
  grep: {
    icon: IconSearch,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    meta: GrepMeta,
    body: (ctx) => <GrepToolBody part={ctx.part} />,
  },
  shell: {
    icon: IconTerminal,
    title: labelFor,
    detail: (part) => <CommandDetail part={part} />,
    meta: ShellMeta,
    body: (ctx) => <ShellToolBody part={ctx.part} />,
  },
  edit: {
    icon: IconFileEdit,
    title: labelFor,
    detail: (part) => <FilePathDetail part={part} />,
    meta: (ctx) => <HeadDiffStat part={ctx.part} />,
    body: (ctx) => <EditToolBody part={ctx.part} />,
  },
  write: {
    icon: IconFileEdit,
    title: labelFor,
    detail: (part) => <FilePathDetail part={part} />,
    meta: (ctx) => <HeadDiffStat part={ctx.part} />,
    body: (ctx) => <WriteToolBody part={ctx.part} />,
  },
  patch: {
    icon: IconGitBranch,
    title: labelFor,
    meta: PatchMeta,
    body: (ctx) => <PatchToolBody part={ctx.part} />,
  },
  task: {
    icon: IconBot,
    title: labelFor,
    detail: (part) => <TaskDetail part={part} />,
    body: (ctx) => <TaskSummary part={ctx.part} />,
  },
  todowrite: {
    icon: IconWrench,
    title: labelFor,
    detail: () => <span class="detail-plain">Updated the todo list</span>,
    body: (ctx) => <TodoToolBody part={ctx.part} />,
  },
  todoread: {
    icon: IconWrench,
    title: labelFor,
    detail: () => <span class="detail-plain">Read the current todos</span>,
    body: (ctx) => <TodoToolBody part={ctx.part} />,
  },
  webfetch: {
    icon: IconGlobe,
    title: labelFor,
    detail: (part) => <FetchDetail part={part} />,
    body: (ctx) => <WebfetchBody part={ctx.part} />,
  },
  websearch: {
    icon: IconGlobe,
    title: webSearchLabel,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <WebSearchBody part={ctx.part} />,
  },
  background: {
    icon: IconZap,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    meta: BackgroundMeta,
    body: (ctx) => <BackgroundBody part={ctx.part} />,
  },
  question: {
    icon: IconBot,
    title: labelFor,
    detail: () => <span class="detail-plain">Answered questions</span>,
    body: (ctx) => <QuestionsBody part={ctx.part} />,
    shouldRender: questionResolved,
  },
  git: {
    icon: IconGitBranch,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    meta: GitMeta,
    body: (ctx) => <GitBody part={ctx.part} />,
  },
  sqlite: {
    icon: IconDatabase,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <GenericBody part={ctx.part} />,
  },
  sympy: {
    icon: IconWrench,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <GenericBody part={ctx.part} />,
  },
  skill: {
    icon: IconBrain,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <SkillBody part={ctx.part} />,
  },
  typecheck: {
    icon: IconShieldCheck,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    meta: TypecheckMeta,
    body: (ctx) => <TypecheckBody part={ctx.part} />,
  },
  test: {
    icon: IconCheckCircle,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    meta: (ctx) => (
      <>
        <TestMeta part={ctx.part} />
        <TestFilesMeta part={ctx.part} />
      </>
    ),
    body: (ctx) => <TestBody part={ctx.part} />,
  },
  memory: {
    icon: IconBrain,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <MemoryBody part={ctx.part} />,
  },
  session: {
    icon: IconBot,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <SessionBody part={ctx.part} />,
  },
  project: {
    icon: IconFolder,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <ProjectBody part={ctx.part} />,
  },
  symbols: {
    icon: IconGrid,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    meta: SymbolsMeta,
    body: (ctx) => <SymbolsBody part={ctx.part} />,
  },
  monitor: {
    icon: IconEye,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <MonitorBody part={ctx.part} />,
  },
  checkpoint: {
    icon: IconRotateCcw,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    meta: CheckpointMeta,
    body: (ctx) => <CheckpointBody part={ctx.part} />,
  },
  archive: {
    icon: IconArchive,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <ArchiveBody part={ctx.part} />,
  },
  json: {
    icon: IconPackage,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    meta: JsonMeta,
    body: (ctx) => <JsonBody part={ctx.part} />,
  },
  lsp: {
    icon: IconSearch,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <LspBody part={ctx.part} />,
  },
  refactor: {
    icon: IconWrench,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <RefactorBody part={ctx.part} />,
  },
  list: {
    icon: IconSearch,
    title: labelFor,
    detail: (part) => <PatternDetail part={part} />,
    body: (ctx) => <GenericBody part={ctx.part} />,
  },
}

/** Resolves a descriptor for a tool name, folding aliases onto their primary key. */
export function resolveDescriptor(tool: string): { name: string; descriptor: ToolDescriptor | undefined } {
  const name = TOOL_ALIASES[tool] ?? tool
  return { name, descriptor: DESCRIPTORS[name] }
}
