import { For, Show, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { fileDir as dirName, fileName as fileNameOf } from "../../format"
import { stripAnsi } from "./shared"

type GrepFileGroup = { path: string; matches: { line: number; text: string }[] }
export type GrepResult = { total: number; truncated: boolean; files: GrepFileGroup[] }
export type GlobResult = { files: string[]; truncated: boolean }

function toolOutput(part: ToolPart): string {
  const state = part.state
  const out =
    state.status === "completed" || state.status === "error" ? (state as { output?: string }).output : undefined
  return stripAnsi(out ?? "")
}

export function parseGrepOutput(output: string): GrepResult | undefined {
  const lines = output.split("\n")
  if (lines[0]?.trim() === "No files found") return { total: 0, truncated: false, files: [] }
  const header = /^Found (\d+) matches/.exec(lines[0] ?? "")
  if (!header) return undefined
  const files: GrepFileGroup[] = []
  let current: GrepFileGroup | undefined
  for (const line of lines.slice(1)) {
    if (!line || line.startsWith("(Results truncated")) continue
    const lineMatch = /^ {2}Line (\d+): (.*)$/.exec(line)
    if (lineMatch && current) {
      current.matches.push({ line: Number(lineMatch[1]), text: lineMatch[2] ?? "" })
      continue
    }
    const fileMatch = /^(.+):$/.exec(line)
    if (fileMatch) {
      current = { path: fileMatch[1]!, matches: [] }
      files.push(current)
    }
  }
  return { total: Number(header[1]), truncated: output.includes("more matches available"), files }
}

export function parseGlobOutput(output: string): GlobResult | undefined {
  if (!output) return undefined
  const lines = output.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) return undefined
  if (lines[0]?.trim() === "No files found") return { files: [], truncated: false }
  const files: string[] = []
  let truncated = false
  for (const line of lines) {
    if (line.startsWith("(Results are truncated")) {
      truncated = true
      continue
    }
    files.push(line)
  }
  return { files, truncated }
}

function HighlightedText(props: { text: string; term?: string }) {
  const parts = createMemo(() => {
    if (!props.term) return [{ text: props.text, match: false }]
    let re: RegExp
    try {
      re = new RegExp(`(${props.term})`, "gi")
    } catch {
      return [{ text: props.text, match: false }]
    }
    return props.text.split(re).map((chunk, i) => ({ text: chunk, match: i % 2 === 1 }))
  })
  return <For each={parts()}>{(part) => (part.match ? <mark class="grep-hit">{part.text}</mark> : part.text)}</For>
}

export function GrepToolBody(props: { part: ToolPart }) {
  const result = createMemo(() => parseGrepOutput(toolOutput(props.part)))
  return (
    <Show when={result()} fallback={<pre class="tool-output-pre">{toolOutput(props.part)}</pre>}>
      {(value) => (
        <div class="grep-results">
          <Show when={value().files.length === 0}>
            <div class="tool-empty-note">No matches found.</div>
          </Show>
          <For each={value().files}>
            {(group) => (
              <details class="grep-file" open>
                <summary class="grep-file-head">
                  <span class="grep-path">{fileNameOf(group.path)}</span>
                  <span class="grep-dir">{dirName(group.path)}</span>
                  <span class="count-pill tnum">{group.matches.length}</span>
                </summary>
                <For each={group.matches.slice(0, 50)}>
                  {(match) => (
                    <div class="grep-match-row">
                      <span class="ln tnum">{match.line}</span>
                      <code><HighlightedText text={match.text} term={patternOf(props.part)} /></code>
                    </div>
                  )}
                </For>
              </details>
            )}
          </For>
          <Show when={value().truncated}>
            <div class="tool-truncated-note">More matches available — refine the pattern to see everything.</div>
          </Show>
        </div>
      )}
    </Show>
  )
}

export function GlobToolBody(props: { part: ToolPart }) {
  const result = createMemo(() => parseGlobOutput(toolOutput(props.part)))
  const rows = createMemo<JSX.Element[]>(() =>
    (result()?.files ?? []).slice(0, 200).map((file) => (
      <div class="glob-row">
        <span class="glob-name">{fileNameOf(file)}</span>
        <span class="glob-dir">{dirName(file)}</span>
      </div>
    )),
  )
  const truncated = () => result()?.truncated ?? false
  return (
    <div class="glob-results">
      <Show when={(result()?.files.length ?? 0) > 0} fallback={<div class="tool-empty-note">No files matched this glob.</div>}>
        <For each={rows()}>{(row) => row}</For>
        <Show when={truncated()}>
          <div class="tool-truncated-note">Truncated — narrow the glob pattern for full results.</div>
        </Show>
      </Show>
    </div>
  )
}

function patternOf(part: ToolPart): string | undefined {
  const input = part.state.input as Record<string, unknown> | undefined
  const value = input?.pattern
  return typeof value === "string" ? value : undefined
}

// Read tool preview ----------------------------------------------------------------

type ReadDisplay =
  | { type?: "file"; path?: string; text?: string; lineStart?: number; lineEnd?: number; totalLines?: number; truncated?: boolean }
  | { type: "directory"; path?: string; entries?: unknown }

export function readDisplay(part: ToolPart): ReadDisplay | undefined {
  const meta = ((part.state as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>
  const display = meta.display
  if (!display || typeof display !== "object") return undefined
  return display as ReadDisplay
}

export function ReadToolBody(props: { part: ToolPart }) {
  const display = createMemo(() => readDisplay(props.part))
  const file = createMemo(() => {
    const value = display()
    if (!value || value.type === "directory") return undefined
    return value as Extract<ReadDisplay, { type?: "file" }>
  })
  const entries = createMemo(() => {
    const value = display()
    if (!value || value.type !== "directory" || !Array.isArray(value.entries)) return []
    return value.entries.filter((entry): entry is string => typeof entry === "string")
  })

  return (
    <Show
      when={file()}
      fallback={
        <Show when={entries().length > 0}>
          <div class="dir-listing">
            <For each={entries()}>{(entry) => (
              <div class={`dir-entry ${entry.endsWith("/") ? "is-dir" : ""}`}>
                <span class="dir-entry-mark">{entry.endsWith("/") ? "▸" : "·"}</span>
                <span>{entry.endsWith("/") ? entry.slice(0, -1) : entry}</span>
              </div>
            )}</For>
          </div>
        </Show>
      }
    >
      {(info) => (
        <div class="read-body">
          <div class="read-meta">
            <Show when={info().totalLines !== undefined}>
              <span class="tnum">
                {info().truncated
                  ? `lines ${info().lineStart ?? 1}–${info().lineEnd ?? "?"} of ${info().totalLines}`
                  : `${info().totalLines} lines`}
              </span>
            </Show>
          </div>
          <Show when={info().text} fallback={<div class="tool-empty-note">Empty file.</div>}>
            {(text) => <pre class="read-content"><code>{text()}</code></pre>}
          </Show>
        </div>
      )}
    </Show>
  )
}
