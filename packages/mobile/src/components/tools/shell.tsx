import { Show, createMemo, createSignal } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { CopyChip, LiveTimer, Section, inputString, stripAnsi } from "./shared"
import { CappedCode } from "./shared"

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

export function ShellToolBody(props: { part: ToolPart }) {
  const command = createMemo(() => inputString(props.part, "command", "script", "description") ?? "")
  const background = createMemo(() => shellMeta(props.part).background === true)
  const rawOutput = createMemo(() => {
    const state = props.part.state
    const source = state.status === "error" ? (state as { error?: string }).error : (state as { output?: string }).output
    return stripAnsi(source ?? "").replace(/\r\n?/g, "\n")
  })
  return (
    <div class="shell-body">
      <Show when={command()}>
        <Section label="Command" action={<CopyChip text={() => command()} />}>
          <div class="shell-command">
            <span class="shell-prompt" aria-hidden="true">$</span>
            <CappedCode text={() => command()} />
          </div>
        </Section>
      </Show>
      <Show when={background()}>
        <div class="shell-bg-banner">
          <span class="bg-dot pulse" />
          Background job — keeps running after this reply
        </div>
      </Show>
      <Show when={rawOutput().trim().length > 0}>
        <Section label="Output" action={<CopyChip text={() => rawOutput()} />}>
          <div class="shell-output">
            <CappedCode text={rawOutput} />
          </div>
        </Section>
      </Show>
      <Show when={rawOutput().trim().length === 0 && props.part.state.status === "running"}>
        <div class="shell-running-note"><span class="status-dot blue pulse" /> Running…</div>
      </Show>
    </div>
  )
}
