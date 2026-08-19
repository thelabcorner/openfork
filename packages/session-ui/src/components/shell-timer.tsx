import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"

function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}

function Hourglass(props: { spinning: boolean }) {
  return (
    <svg
      data-slot="shell-timer-hourglass"
      data-spinning={props.spinning ? "true" : undefined}
      width="11"
      height="11"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M3 1.75H9M3 10.25H9M3.4 1.75C3.4 3.35 4.3 4.35 6 4.75C7.7 4.35 8.6 3.35 8.6 1.75M3.4 10.25C3.4 8.65 4.3 7.65 6 7.25C7.7 7.65 8.6 8.65 8.6 10.25"
        stroke="currentColor"
        stroke-width="0.9"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
    </svg>
  )
}

/**
 * Live-ticking elapsed/timeout badge for long-running shell commands.
 * Freezes on the final duration once `running` goes false so completed
 * cards keep showing how long the command actually took.
 */
export function ShellTimer(props: { startedAt: number; timeoutMs?: number; running: boolean; endedAt?: number }) {
  const i18n = useI18n()
  const [now, setNow] = createSignal(Date.now())

  const interval = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(interval))

  const elapsed = createMemo(() => {
    const end = props.running ? now() : (props.endedAt ?? now())
    return Math.max(0, end - props.startedAt)
  })

  const remaining = createMemo(() => {
    if (props.timeoutMs === undefined) return undefined
    return props.timeoutMs - elapsed()
  })

  const ratio = createMemo(() => {
    if (props.timeoutMs === undefined || props.timeoutMs <= 0) return 0
    return elapsed() / props.timeoutMs
  })

  const urgency = createMemo<"normal" | "warning" | "danger">(() => {
    if (!props.running) return "normal"
    const value = ratio()
    if (value >= 0.95) return "danger"
    if (value >= 0.8) return "warning"
    return "normal"
  })

  return (
    <span data-component="shell-timer-group">
      <span data-component="shell-timer" data-running={props.running ? "true" : undefined} data-urgency={urgency()}>
        <Hourglass spinning={props.running} />
        <span data-slot="shell-timer-elapsed">{formatDuration(elapsed())}</span>
      </span>
      <Show when={props.running && remaining() !== undefined}>
        <span data-component="shell-timer-remaining-badge" data-urgency={urgency()}>
          {remaining()! > 0
            ? i18n.t("ui.tool.shell.timeoutIn", { duration: formatDuration(remaining()!) })
            : i18n.t("ui.tool.shell.timingOut")}
        </span>
      </Show>
    </span>
  )
}
