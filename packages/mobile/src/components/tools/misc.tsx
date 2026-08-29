import { For, Show, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { IconExternalLink } from "../../icons"
import { CappedCode, EmptyNote, Section, inputString, stripAnsi } from "./shared"
import { safeExternalUrl } from "../../security"

function outputText(part: ToolPart): string {
  const raw =
    part.state.status === "error"
      ? (part.state as { error?: string }).error
      : (part.state as { output?: string }).output
  return stripAnsi(raw ?? "")
}

// Task / subagent -------------------------------------------------------------------

export function TaskSummary(props: { part: ToolPart }) {
  const agent = createMemo(() => inputString(props.part, "subagentType", "agent") ?? "Agent")
  const description = createMemo(() => {
    const input = props.part.state.input as Record<string, unknown> | undefined
    const value = input?.description ?? input?.prompt
    return typeof value === "string" ? value : ""
  })
  const running = () => props.part.state.status === "running" || props.part.state.status === "pending"
  const output = createMemo(() => outputText(props.part))
  const done = () => !running() && output().trim().length > 0

  return (
    <div class="task-card">
      <div class="task-card-head">
        <span class={`task-agent-chip ${running() ? "running" : ""}`}>
          <Show when={running()}>
            <span class="status-dot blue pulse" />
          </Show>
          {agent()}
        </span>
        <span class="task-desc">{description()}</span>
      </div>
      <Show when={done()}>
        <details class="task-result">
          <summary class="task-result-head">Result</summary>
          <CappedCode text={output} class="tool-json-block dimmed" />
        </details>
      </Show>
    </div>
  )
}

// Webfetch ---------------------------------------------------------------------------

export function FetchDetail(props: { part: ToolPart }): JSX.Element {
  const url = createMemo(() => inputString(props.part, "url") ?? "")
  const href = createMemo(() => safeExternalUrl(url()))
  return (
    <Show
      when={href()}
      fallback={<span class="fetch-url"><span>{url()}</span></span>}
    >
      {(safe) => (
        <a class="fetch-url" href={safe()} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          <IconExternalLink size={9} />
          <span>{url()}</span>
        </a>
      )}
    </Show>
  )
}

// Websearch --------------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  exa: "Exa",
  brave: "Brave",
  tavily: "Tavily",
  parallel: "Parallel",
  firecrawl: "Firecrawl",
  duckduckgo: "DuckDuckGo",
  searxng: "SearXNG",
}

export function webSearchLabel(part: ToolPart): string {
  const provider = ((part.state as { metadata?: Record<string, unknown> }).metadata ?? {}).provider
  if (typeof provider === "string") return PROVIDER_LABELS[provider] ?? provider
  return "Web search"
}

export function WebSearchBody(props: { part: ToolPart }) {
  const query = createMemo(() => inputString(props.part, "query") ?? "")
  const output = createMemo(() => outputText(props.part))
  return (
    <Section label="Search results" action={<Show when={query()}><code class="tool-query">{query()}</code></Show>}>
      <Show when={output()} fallback={<EmptyNote>No results recorded.</EmptyNote>}>
        {(text) => <CappedCode text={() => text()} />}
      </Show>
    </Section>
  )
}

// Todos ------------------------------------------------------------------------------

type TodoStatus = "pending" | "in_progress" | "completed"

type TodoItem = { content: string; status: TodoStatus; priority: string | undefined }

function statusOf(value: unknown): TodoStatus {
  if (value === "in_progress") return "in_progress"
  if (value === "completed") return "completed"
  return "pending"
}

function todosOf(part: ToolPart): TodoItem[] {
  const meta = ((part.state as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>
  const candidates: unknown[] = []
  const input = part.state.input as Record<string, unknown> | undefined
  candidates.push(input?.todos)
  candidates.push(meta.todos)
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const items: TodoItem[] = []
    for (const entry of candidate) {
      if (!entry || typeof entry !== "object") continue
      const value = entry as TodoItem & { content?: unknown }
      const content = typeof value.content === "string" ? value.content : undefined
      if (!content) continue
      items.push({
        content,
        status: statusOf(value.status),
        priority: typeof value.priority === "string" ? value.priority : undefined,
      })
    }
    if (items.length > 0) return items
  }
  return []
}

const STATUS_MARK: Record<TodoStatus, JSX.Element> = {
  pending: <span class="todo-mark pending" />,
  in_progress: <span class="todo-mark progress pulse" />,
  completed: <span class="todo-mark completed">✓</span>,
}

export function TodoToolBody(props: { part: ToolPart }) {
  const todos = createMemo(() => todosOf(props.part))
  const doneCount = createMemo(() => todos().filter((t) => t.status === "completed").length)
  return (
    <div class="todo-list">
      <Show when={todos().length > 0} fallback={<EmptyNote>No structured todo data was recorded.</EmptyNote>}>
        <div class="todo-progress tnum">
          <div class="todo-track">
            <div class="todo-fill" style={{ width: `${(doneCount() / Math.max(todos().length, 1)) * 100}%` }} />
          </div>
          <span>{doneCount()}/{todos().length}</span>
        </div>
        <For each={todos()}>
          {(item) => (
            <div class={`todo-row ${item.status}`}>
              {STATUS_MARK[item.status]}
              <span class="todo-text">{item.content}</span>
              <Show when={item.priority}>
                <span class={`todo-priority ${item.priority}`}>{item.priority}</span>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}
