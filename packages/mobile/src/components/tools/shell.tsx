import { For, Show, createMemo, createSignal } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { CopyChip, LiveTimer, Section, inputString, stripAnsi } from "./shared"
import { parseShellOutput, type ParsedShellOutput, type ShellOutputStyle } from "./ansi"
import { tokenizeCommand } from "./command"

export function shellMeta(part: ToolPart): Record<string, unknown> {
  return ((part.state as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>
}

export function ShellHeadTimer(props: { part: ToolPart }) {
  const startedAt = createMemo(() => {
    const meta = shellMeta(props.part)
    const value = typeof meta.startedAt === "number" ? meta.startedAt : undefined
    if (value !== undefined) return value
    const time = (props.part.state as { time?: { start?: number; end?: number } }).time
    return time?.start
  })
  const endedAt = createMemo(() => {
    const meta = shellMeta(props.part)
    if (typeof meta.endedAt === "number") return meta.endedAt
    const time = (props.part.state as { time?: { start?: number; end?: number } }).time
    return time?.end
  })
  return <LiveTimer start={startedAt} end={endedAt} />
}

export function ShellExitBadge(props: { part: ToolPart }) {
  const code = createMemo(() => {
    const meta = shellMeta(props.part)
    const value = typeof meta.exit === "number" ? meta.exit : undefined
    if (value !== undefined) return value
    // Fall back to a trailing "Exit code: N" line some servers emit in output.
    const status = props.part.state.status
    if (status !== "completed") return undefined
    const match = /exit(?:\s+code)?[: ]+(\d+)\s*$/i.exec(stripAnsi((props.part.state as { output?: string }).output ?? "").trimEnd())
    return match ? Number(match[1]) : undefined
  })
  return (
    <Show when={code() !== undefined}>
      <span class={`exit-badge tnum ${code() === 0 ? "ok" : "fail"}`}>exit {code()}</span>
    </Show>
  )
}

export function StopButton(props: {
  running: () => boolean
  onStop: (() => Promise<boolean>) | undefined
}) {
  const [pending, setPending] = createSignal(false)
  const [done, setDone] = createSignal(false)
  const click = async (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
    if (pending() || done() || !props.onStop) return
    setPending(true)
    try {
      const killed = await props.onStop()
      if (killed) setDone(true)
    } catch {
      setPending(false)
    }
    setPending(false)
  }
  return (
    <Show
      when={props.running() && !done()}
      fallback={
        <Show when={done()}>
          <span class="tool-stop-done">stopped</span>
        </Show>
      }
    >
      <button class={`tool-stop-btn ${pending() ? "busy" : ""}`} onClick={click} title="Stop" aria-label="Stop">
        <span class="stop-square" />
      </button>
    </Show>
  )
}

/* ── Command ──────────────────────────────────────────────────────────────
   The desktop renders this through shiki. This app has no monospace and
   already carries a small shell tokenizer, so the command is coloured from the
   app's own palette instead — same information, no grammar download. */

export function CommandLine(props: { command: string }) {
  const tokens = createMemo(() => tokenizeCommand(props.command))
  return (
    <code class="shell-command-code">
      <For each={tokens()}>{(token) => <span class={`cmd-${token.kind}`}>{token.text}</span>}</For>
    </code>
  )
}

/* ── Output ─────────────────────────────────────────────────────────────── */

/**
 * One styled run. Colour and background come from CSS custom properties
 * (mirroring the desktop) so the palette stays in one place; bold/dim/italic
 * and friends are classes, matching how the rest of this app styles state.
 */
function Segment(props: { text: string; style: ShellOutputStyle }) {
  const style = () => {
    const value: Record<string, string> = {}
    if (props.style.foreground) value["--shell-fg"] = props.style.foreground
    if (props.style.background) value["--shell-bg"] = props.style.background
    if (props.style.decoration) value["--shell-decoration"] = props.style.decoration
    return value
  }
  return (
    <span
      class="shell-seg"
      classList={{
        "shell-bold": props.style.bold,
        "shell-dim": props.style.dim,
        "shell-italic": props.style.italic,
        "shell-blink": props.style.blink,
        "shell-inverse": props.style.inverse,
        "shell-hidden": props.style.hidden,
      }}
      style={style()}
    >
      {props.text}
    </span>
  )
}

export function ShellOutput(props: { parsed: () => ParsedShellOutput }) {
  return (
    <code class="shell-output-code">
      <For each={props.parsed().segments}>
        {(segment) => <Segment text={segment.text} style={segment.style} />}
      </For>
    </code>
  )
}

/** How many lines to show before the output asks the reader to expand it. */
const OUTPUT_CLAMP_LINES = 24

export function OutputBlock(props: { parsed: () => ParsedShellOutput; text: () => string }) {
  const [full, setFull] = createSignal(false)
  const lines = createMemo(() => props.text().split("\n").length)
  const clamped = () => !full() && lines() > OUTPUT_CLAMP_LINES

  return (
    <>
      <div class="shell-scroll" classList={{ clamped: clamped() }}>
        <pre class="shell-pre">
          <ShellOutput parsed={props.parsed} />
        </pre>
      </div>
      <Show when={clamped()}>
        <button
          class="shell-more"
          onClick={(event) => {
            event.stopPropagation()
            setFull(true)
          }}
        >
          Show all {lines()} lines
        </button>
      </Show>
    </>
  )
}

/* ── Body ───────────────────────────────────────────────────────────────── */

export function ShellToolBody(props: { part: ToolPart }) {
  const command = createMemo(() => inputString(props.part, "command", "script", "description") ?? "")
  const background = createMemo(() => shellMeta(props.part).background === true)

  const source = createMemo(() => {
    const state = props.part.state
    return state.status === "error" ? (state as { error?: string }).error : (state as { output?: string }).output
  })

  // No stripAnsi here: parseShellOutput consumes the escapes and turns them
  // into styled runs. It also resolves carriage-return line redraws, which
  // stripAnsi never did — that is what collapsed npm/vitest progress spam.
  const parsed = createMemo(() => parseShellOutput(source() ?? ""))
  const text = createMemo(() => parsed().text)
  const hasOutput = () => text().trim().length > 0

  // The copy affordance offers what a terminal would: the command and its
  // output, not the escape codes.
  const copyText = createMemo(() => `$ ${command()}${hasOutput() ? "\n\n" + text() : ""}`)

  return (
    <div class="shell-body" dir="ltr">
      <Show when={command()}>
        <Section label="Command" action={<CopyChip text={copyText} />}>
          <div class="shell-command">
            <span class="shell-prompt" aria-hidden="true">
              $
            </span>
            <CommandLine command={command()} />
          </div>
        </Section>
      </Show>

      <Show when={background()}>
        <div class="shell-bg-banner">
          <span class="bg-dot pulse" />
          <span>Background job — keeps running after this reply</span>
          <ShellHeadTimer part={props.part} />
        </div>
      </Show>

      <Show when={hasOutput()}>
        <Section label="Output">
          <OutputBlock parsed={parsed} text={text} />
        </Section>
      </Show>

      <Show when={!hasOutput() && props.part.state.status === "running"}>
        <div class="shell-running-note">
          <span class="status-dot blue pulse" /> Running…
        </div>
      </Show>
    </div>
  )
}
