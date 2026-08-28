import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { formatTimer, fileDir, fileName } from "../../format"
import { IconCheckCircle, IconCopy } from "../../icons"

// ANSI escape stripper. Uses an explicit non-capturing group anchored by
// the two possible CSI introducers (0x1B ESC and 0x9B SSA) so the
// resulting regex is valid even when the build toolchain rewrites Unicode
// escapes in template-literal strings.
const ANSI_INTRODUCER = `\u001B${String.fromCharCode(0x9b)}`
const ANSI_CSI_RE = new RegExp(
  `[${ANSI_INTRODUCER}][\\[\\]()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?[\\x40-\\x7e])`,
  "g",
)

export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_RE, "")
}

export function inputString(part: ToolPart, ...keys: string[]): string | undefined {
  const input = part.state.input as Record<string, unknown> | undefined
  if (!input) return undefined
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

function splitPath(path: string): { dir: string; base: string } {
  return { dir: fileDir(path), base: fileName(path) }
}

export function PathLabel(props: { path: string; class?: string }) {
  const parts = () => splitPath(props.path)
  return (
    <span class={`path-label ${props.class ?? ""}`}>
      <Show when={parts().dir}><span class="path-dir">{parts().dir}</span></Show>
      <span class="path-base">{parts().base}</span>
    </span>
  )
}

export function Section(props: { label: string; action?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="tool-section">
      <div class="tool-section-head">
        <span class="tool-section-label">{props.label}</span>
        <Show when={props.action}>{props.action}</Show>
      </div>
      {props.children}
    </div>
  )
}

export function CopyChip(props: { text: () => string }) {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => timer && clearTimeout(timer))
  const copy = async (event: MouseEvent) => {
    event.stopPropagation()
    try {
      await navigator.clipboard?.writeText(props.text())
      setCopied(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard may be unavailable (permission/no https); the chip stays a no-op.
    }
  }
  return (
    <button class={`tool-copy-chip ${copied() ? "done" : ""}`} onClick={copy} title={copied() ? "Copied" : "Copy"}>
      <Show when={copied()} fallback={<IconCopy size={10} />}>
        <IconCheckCircle size={10} />
      </Show>
    </button>
  )
}

// Lines capped with progressive reveal keeps huge read/patch bodies cheap on
// mobile GPUs — DOM nodes grow only when the user asks for more.
const MAX_RENDERED_LINES = 300

export function CappedCode(props: { text: () => string; class?: string }) {
  const [expanded, setExpanded] = createSignal(false)
  const total = createMemo(() => props.text().split("\n").length)
  const visible = createMemo(() => {
    const all = props.text()
    if (expanded() || total() <= MAX_RENDERED_LINES) return all
    return all.split("\n").slice(0, MAX_RENDERED_LINES).join("\n")
  })
  return (
    <div class={`capped-code ${props.class ?? ""}`}>
      <pre>{visible()}</pre>
      <Show when={!expanded() && total() > MAX_RENDERED_LINES}>
        <button class="capped-code-more" onClick={() => setExpanded(true)}>
          Show {total() - MAX_RENDERED_LINES} more lines
        </button>
      </Show>
    </div>
  )
}

export function DiffStat(props: { additions: number; deletions: number; compact?: boolean }) {
  return (
    <span class={`diff-stat tnum ${props.compact ? "compact" : ""}`}>
      <Show when={props.additions > 0}><span class="add">+{props.additions}</span></Show>
      <Show when={props.deletions > 0}><span class="del">−{props.deletions}</span></Show>
    </span>
  )
}

const MARKS: Record<string, { cls: string; label: string }> = {
  added: { cls: "added", label: "A" },
  deleted: { cls: "deleted", label: "D" },
  modified: { cls: "modified", label: "M" },
}

export function ChangeMark(props: { status?: string }) {
  const mark = () => MARKS[props.status ?? ""] ?? MARKS.modified!
  return (
    <span class={`change-mark ${mark().cls}`}>{mark().label}</span>
  )
}

// Live duration ticker while a shell/background call runs; frozen once done.
export function LiveTimer(props: { start: () => number | undefined; end?: () => number | undefined }) {
  const [tick, setTick] = createSignal(0)
  let handle: ReturnType<typeof setInterval> | undefined
  const running = () => !props.end?.()
  createEffect(() => {
    if (!running()) return
    handle = setInterval(() => setTick((n) => n + 1), 1000)
    onCleanup(() => {
      if (handle) clearInterval(handle)
      handle = undefined
    })
  })
  const seconds = createMemo(() => {
    void tick()
    const start = props.start()
    if (start === undefined) return undefined
    const end = props.end?.() ?? Date.now()
    return Math.max(0, Math.round((end - start) / 1000))
  })
  return (
    <Show when={seconds() !== undefined}>
      <span class={`live-timer tnum ${running() ? "running" : ""}`}>{formatTimer(seconds()!)}</span>
    </Show>
  )
}

export function EmptyNote(props: { children: JSX.Element }) {
  return <div class="tool-empty-note">{props.children}</div>
}
