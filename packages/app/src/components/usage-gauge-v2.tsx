import { type Component, For } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import type { ForkWindowUsage } from "@/utils/fork-client"

const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 })

const percent = (window: ForkWindowUsage) => {
  if (window.estimatedPercent !== undefined) return Math.max(0, Math.min(100, window.estimatedPercent))
  if (window.limitUSD <= 0) return 0
  return Math.round(Math.max(0, Math.min(100, (window.spentUSD / window.limitUSD) * 100)) * 10) / 10
}

const toneFor = (pct: number) => {
  if (pct >= 100) return "danger"
  if (pct >= 75) return "warning"
  return "success"
}

const colorFor = (tone: "danger" | "warning" | "success") => {
  if (tone === "danger") return "var(--v2-state-fg-danger)"
  if (tone === "warning") return "var(--v2-state-fg-warning)"
  return "var(--v2-state-fg-success)"
}

const formatPercent = (window: ForkWindowUsage, pct: number) =>
  window.estimatedPercent !== undefined && pct % 1 !== 0
    ? pct.toFixed(2)
    : pct.toFixed(pct % 1 === 0 ? 0 : 1)

const formatCountdown = (
  language: ReturnType<typeof useLanguage>,
  ms: number,
) => {
  if (ms <= 0) return language.t("usage.duration.zero")
  const totalMinutes = Math.ceil(ms / 60000)
  const day = Math.floor(totalMinutes / 1440)
  const hour = Math.floor((totalMinutes % 1440) / 60)
  const minute = totalMinutes % 60
  if (day > 0) return language.t("usage.duration.daysHours", { days: day, hours: hour })
  if (hour > 0) return language.t("usage.duration.hoursMinutes", { hours: hour, minutes: minute })
  return language.t("usage.duration.minutes", { minutes: minute })
}

const formatResetDate = (ms: number) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms))

function UsageWindowRow(props: { window: ForkWindowUsage; label: string; now: number }) {
  const language = useLanguage()
  const pct = () => percent(props.window)
  const tone = () => toneFor(pct())
  const resetRemaining = () => Math.max(0, props.window.resetsAt - props.now)
  const clearsAt = () => props.window.clearsAt ?? props.window.resetsAt
  const clearRemaining = () => Math.max(0, clearsAt() - props.now)

  return (
    <div class="grid grid-cols-[78px_minmax(0,1fr)_88px] items-center gap-2.5">
      <div class="min-w-0">
        <div class="truncate text-[11px] font-[560] leading-3.5 text-v2-text-text-base">{props.label}</div>
        <div class="mt-0.5 truncate text-[10px] font-[440] leading-3 text-v2-text-text-faint">
          {language.plural("usage.calls", props.window.callsInWindow)}
        </div>
      </div>
      <div class="min-w-0">
        <div class="mb-1 flex items-baseline justify-between gap-2">
          <span class="text-[10px] font-[440] leading-3 tabular-nums text-v2-text-text-muted">
            {usd.format(props.window.spentUSD)} / {usd.format(props.window.limitUSD)}
          </span>
          <span class="text-[10px] font-[600] leading-3 tabular-nums" style={{ color: colorFor(tone()) }}>
            {formatPercent(props.window, pct())}%
          </span>
        </div>
        <div class="h-1 overflow-hidden rounded-full bg-v2-background-bg-layer-03">
          <div
            class="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${Math.min(pct(), 100)}%`, "background-color": colorFor(tone()) }}
          />
        </div>
      </div>
      <div class="min-w-0 text-right" title={formatResetDate(props.window.resetsAt)}>
        <div class="flex items-center justify-end gap-1 text-[9px] font-[530] uppercase leading-3 text-v2-text-text-faint">
          <IconV2 name="outline-reset" size="small" class="size-3" />
          {language.t("usage.reset")}
        </div>
        <div class="text-[10px] font-[520] leading-3.5 tabular-nums text-v2-text-text-base">
          {formatCountdown(language, resetRemaining())}
        </div>
        <div class="truncate text-[9px] font-[440] leading-3 text-v2-text-text-faint">
          {props.window.label === "5h" && clearsAt() !== props.window.resetsAt
            ? `${language.t("usage.clear")} ${formatCountdown(language, clearRemaining())}`
            : formatResetDate(props.window.resetsAt)}
        </div>
      </div>
    </div>
  )
}

export const UsageBreakdownV2: Component<{ windows: ForkWindowUsage[]; now: number }> = (props) => {
  const language = useLanguage()
  const labelFor = (label: ForkWindowUsage["label"]) =>
    label === "5h" ? language.t("usage.window.5h") : label === "week" ? language.t("usage.window.week") : language.t("usage.window.month")

  return (
    <div class="flex flex-col gap-2 pt-1.5">
      <For each={props.windows}>{(window) => <UsageWindowRow window={window} label={labelFor(window.label)} now={props.now} />}</For>
    </div>
  )
}
