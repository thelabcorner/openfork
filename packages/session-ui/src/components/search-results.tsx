import { createMemo, createSignal, For, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { getDirectory as pathDirectory, getFilename } from "@opencode-ai/core/util/path"
import { ToolBoundedList, ToolEmpty, ToolRow, ToolScrollArea } from "./tool-parts"

/**
 * Search/read output presentation shared by the session timeline and any other
 * surface replaying the same tool families.
 *
 * These parsers and renderers used to be private to `message-part.tsx`, which
 * made every other consumer either dump the raw output or grow a second, drifting
 * copy of the same regexes. They are deliberately free of `useData()` and of the
 * tool-part registry so a read-only surface (the OXP activity transcript) can
 * mount them without the session runtime around it; callers that *do* have a
 * project directory pass it in.
 */

export function relativizeProjectPath(path: string, directory?: string) {
  if (!path) return ""
  if (!directory) return path
  if (directory === "/") return path
  if (directory === "\\") return path
  if (path === directory) return ""

  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator
  if (!path.startsWith(prefix)) return path
  return path.slice(directory.length)
}

function directoryOf(path: string, directory?: string) {
  return relativizeProjectPath(pathDirectory(path), directory)
}

/* ── Directory listing ───────────────────────────────────────────────────── */

export function DirectoryOutput(props: { entries: string[] }) {
  return (
    <ToolScrollArea component="directory-output">
      <For each={props.entries}>
        {(entry) => {
          const isDir = entry.endsWith("/")
          const name = isDir ? entry.slice(0, -1) : entry
          return (
            <div data-slot="directory-entry">
              <FileIcon node={{ path: name, type: isDir ? "directory" : "file" }} />
              <span data-slot="directory-entry-name">{entry}</span>
            </div>
          )
        }}
      </For>
    </ToolScrollArea>
  )
}

/* ── Grep ────────────────────────────────────────────────────────────────── */

export type GrepFileGroup = { path: string; matches: { line: number; text: string }[] }
export type GrepResult = { total: number; truncated: boolean; files: GrepFileGroup[] }

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
  return { total: Number(header[1]), truncated: lines[0]!.includes("more matches available"), files }
}

function GrepMatchText(props: { text: string; term?: string }) {
  const parts = createMemo(() => {
    const term = props.term
    if (!term) return [{ text: props.text, match: false }]
    let re: RegExp
    try {
      re = new RegExp(`(${term})`, "gi")
    } catch {
      return [{ text: props.text, match: false }]
    }
    return props.text.split(re).map((chunk, i) => ({ text: chunk, match: i % 2 === 1 }))
  })
  return (
    <For each={parts()}>{(part) => (part.match ? <mark data-slot="grep-match-mark">{part.text}</mark> : part.text)}</For>
  )
}

/**
 * Matches, grouped by file.
 *
 * The old treatment drew a bordered card per file inside the tool card, with
 * 10px gaps between them, so a four-file result was five nested frames. This is
 * one continuous list: a file row, then its matching lines under it.
 *
 * Both axes are bounded. A repo-wide grep can return hundreds of files with
 * dozens of matches each, and an expansion that long is unusable — you scroll
 * past the answer looking for it.
 */
const GREP_LINES_PER_FILE = 4

function GrepGroup(props: { group: GrepFileGroup; pattern?: string; directory?: string }) {
  const i18n = useI18n()
  const [full, setFull] = createSignal(false)
  const visible = createMemo(() => (full() ? props.group.matches : props.group.matches.slice(0, GREP_LINES_PER_FILE)))
  const hidden = createMemo(() => props.group.matches.length - visible().length)

  return (
    <div data-component="grep-group">
      <ToolRow
        lead={<FileIcon node={{ path: props.group.path, type: "file" }} />}
        primary={getFilename(props.group.path)}
        secondary={directoryOf(props.group.path, props.directory)}
        trailing={String(props.group.matches.length)}
        mono={false}
      />
      <For each={visible()}>
        {(match) => (
          <div data-slot="grep-line">
            <span data-slot="grep-line-number">{match.line}</span>
            <code data-slot="grep-line-text">
              <GrepMatchText text={match.text} term={props.pattern} />
            </code>
          </div>
        )}
      </For>
      <Show when={hidden() > 0}>
        <button type="button" data-component="tool-more" onClick={() => setFull(true)}>
          {i18n.t("ui.toolParts.showMore", { count: hidden() })}
        </button>
      </Show>
    </div>
  )
}

export function GrepResults(props: { result: GrepResult; pattern?: string; directory?: string }) {
  const i18n = useI18n()
  return (
    <Show when={props.result.files.length > 0} fallback={<ToolEmpty>{i18n.t("ui.tool.grep.noMatches")}</ToolEmpty>}>
      <div data-component="grep-results">
        <ToolBoundedList items={props.result.files} limit={6} scroll>
          {(group) => <GrepGroup group={group} pattern={props.pattern} directory={props.directory} />}
        </ToolBoundedList>
        <Show when={props.result.truncated}>
          <ToolEmpty>{i18n.t("ui.tool.grep.truncated")}</ToolEmpty>
        </Show>
      </div>
    </Show>
  )
}

/* ── Glob ────────────────────────────────────────────────────────────────── */

export type GlobResult = { files: string[]; truncated: boolean }

export function parseGlobOutput(output: string): GlobResult {
  const lines = output.split("\n")
  if (lines[0]?.trim() === "No files found") return { files: [], truncated: false }
  const files: string[] = []
  let truncated = false
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith("(Results are truncated")) {
      truncated = true
      continue
    }
    files.push(line)
  }
  return { files, truncated }
}

export function GlobResults(props: { result: GlobResult; directory?: string }) {
  const i18n = useI18n()
  return (
    <Show when={props.result.files.length > 0} fallback={<ToolEmpty>{i18n.t("ui.tool.glob.noMatches")}</ToolEmpty>}>
      <ToolBoundedList items={props.result.files} limit={12} scroll>
        {(file) => (
          <ToolRow
            lead={<FileIcon node={{ path: file, type: "file" }} />}
            primary={getFilename(file)}
            secondary={directoryOf(file, props.directory)}
          />
        )}
      </ToolBoundedList>
      <Show when={props.result.truncated}>
        <ToolEmpty>{i18n.t("ui.tool.glob.truncated")}</ToolEmpty>
      </Show>
    </Show>
  )
}

/* ── Read window ─────────────────────────────────────────────────────────
   The native read tool ships a pre-parsed `metadata.display`; the exchange/OXP
   read surface only emits the rendered envelope, so the same window has to be
   recovered from text. The envelope is a stable contract on both sides
   (`packages/opencode/src/exchange/read.ts` and `.../tool/read.ts`), which is
   why this parser is strict about it and returns `undefined` rather than
   guessing. */

export type ReadWindow =
  | {
      type: "file"
      path: string
      text: string
      lineStart: number
      lineEnd: number
      totalLines: number
      truncated: boolean
    }
  | {
      type: "directory"
      path: string
      entries: string[]
      totalEntries: number
      truncated: boolean
    }

const READ_PATH = /^<path(?:\s+(?:lines|entries)="(\d+)")?>([\s\S]*?)<\/path>/
const READ_LINE = /^(\d+): ?([\s\S]*)$/

export function parseReadWindow(output: string): ReadWindow | undefined {
  const head = READ_PATH.exec(output.trimStart())
  if (!head) return undefined
  const total = head[1] === undefined ? undefined : Number(head[1])
  const path = head[2]!.trim()
  const kind = /<type>(file|directory)<\/type>/.exec(output)?.[1]
  if (kind === "directory") {
    const body = /<entries>\n([\s\S]*?)\n?<\/entries>/.exec(output)?.[1]
    if (body === undefined) return undefined
    const rows = body.split("\n")
    const entries: string[] = []
    let truncated = false
    for (const row of rows) {
      if (!row) continue
      if (row.startsWith("(")) {
        truncated = row.startsWith("(Showing")
        continue
      }
      entries.push(row)
    }
    return { type: "directory", path, entries, totalEntries: total ?? entries.length, truncated }
  }
  if (kind !== "file") return undefined
  const body = /<content>\n([\s\S]*?)\n?<\/content>/.exec(output)?.[1]
  if (body === undefined) return undefined

  const lines: string[] = []
  let lineStart = 0
  let lineEnd = 0
  let truncated = false
  for (const row of body.split("\n")) {
    const match = READ_LINE.exec(row)
    if (!match) {
      if (row.startsWith("(")) truncated = !row.startsWith("(End of file")
      continue
    }
    const number = Number(match[1])
    if (lineStart === 0) lineStart = number
    lineEnd = number
    lines.push(match[2] ?? "")
  }
  if (lines.length === 0 && lineStart === 0) return undefined
  return {
    type: "file",
    path,
    text: lines.join("\n"),
    lineStart: lineStart || 1,
    lineEnd: lineEnd || lines.length,
    totalLines: total ?? lines.length,
    truncated,
  }
}
