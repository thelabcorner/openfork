import { createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { colorFor } from "./usage-gauge-v2"
import type { FreeUsageReport } from "@/utils/openrouter-free-usage"

const statusTone = (status: FreeUsageReport["free"]["status"]) => {
  if (status === "depleted" || status === "terminal" || status === "critical") return "danger" as const
  if (status === "low" || status === "draining") return "warning" as const
  return "success" as const
}

const statusLabelKey = (status: FreeUsageReport["free"]["status"]) => {
  switch (status) {
    case "healthy":
      return "openrouter.free.status.healthy"
    case "draining":
      return "openrouter.free.status.draining"
    case "low":
      return "openrouter.free.status.low"
    case "critical":
      return "openrouter.free.status.critical"
    case "terminal":
      return "openrouter.free.status.terminal"
    case "depleted":
      return "openrouter.free.status.depleted"
  }
}

function formatNumber(value: number, locale: string | undefined) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

function formatCountdown(seconds: number, language: ReturnType<typeof useLanguage>) {
  if (seconds <= 0) return language.t("usage.duration.zero")
  const totalSeconds = Math.floor(seconds)
  const s = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const m = totalMinutes % 60
  const totalHours = Math.floor(totalMinutes / 60)
  const h = totalHours % 24
  const d = Math.floor(totalHours / 24)
  if (d > 0) return language.t("usage.duration.daysHoursSeconds", { days: d, hours: h, seconds: s })
  if (totalHours > 0) return language.t("usage.duration.hoursMinutesSeconds", { hours: totalHours, minutes: m, seconds: s })
  return language.t("usage.duration.minutesSeconds", { minutes: m, seconds: s })
}

export function FreeUsageBar(props: { report: FreeUsageReport; compact?: boolean }) {
  const language = useLanguage()
  const tone = () => statusTone(props.report.free.status)
  const percent = () => Math.round(props.report.free.remainingPercent * 10) / 10
  const resetSeconds = () => props.report.free.window.secondsUntilReset
  const intl = () => language.intl()

  return (
    <div class="flex flex-col gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-2.5">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-[10px] font-[600] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
          {language.t("openrouter.free.title")}
        </span>
        <span class="text-[10px] font-[520] tabular-nums" style={{ color: colorFor(tone()) }}>
          {language.t(statusLabelKey(props.report.free.status))}
        </span>
      </div>

      <div class="flex items-baseline justify-between gap-2">
        <span class="text-[13px] font-[650] leading-4 tabular-nums text-v2-text-text-base">
          {formatNumber(props.report.free.remaining, intl())} / {formatNumber(props.report.free.limit, intl())}
        </span>
        <span class="text-[10px] font-[600] leading-3 tabular-nums" style={{ color: colorFor(tone()) }}>
          {percent()}%
        </span>
      </div>

      <div class="h-1.5 w-full overflow-hidden rounded-full bg-v2-background-bg-layer-03">
        <div
          class="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${Math.max(0, Math.min(100, percent()))}%`, "background-color": colorFor(tone()) }}
        />
      </div>

      <div class="grid grid-cols-2 gap-1.5 text-[10px] leading-3">
        <div class="flex flex-col gap-0.5 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2 py-1.5">
          <span class="text-[9px] font-[500] uppercase tracking-[0.02em] text-v2-text-text-faint">
            {language.t("openrouter.free.used")}
          </span>
          <span class="text-[11px] font-[600] tabular-nums text-v2-text-text-base">
            {formatNumber(props.report.free.used, intl())}
          </span>
          <span class="text-[9px] font-[440] text-v2-text-text-faint">
            {formatNumber(props.report.free.tokens.total, intl())} tokens
          </span>
        </div>
        <div class="flex flex-col gap-0.5 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2 py-1.5">
          <span class="text-[9px] font-[500] uppercase tracking-[0.02em] text-v2-text-text-faint">
            {language.t("openrouter.free.reset")}
          </span>
          <span class="text-[11px] font-[600] tabular-nums text-v2-text-text-base">
            {formatCountdown(resetSeconds(), language)}
          </span>
          <span class="truncate text-[9px] font-[440] text-v2-text-text-faint" title={props.report.free.window.resetsAt}>
            {new Date(props.report.free.window.resetsAt).toLocaleTimeString()}
          </span>
        </div>
      </div>

      <Show when={!props.compact}>
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between text-[10px] font-[440] leading-3 text-v2-text-text-muted">
            <span>{language.t("openrouter.free.burnRate")}</span>
            <span class="font-[520] tabular-nums text-v2-text-text-base">
              {props.report.free.projection.requestsPerHour.toFixed(1)}/h · {props.report.free.rate.observedRequestsPerMinute.toFixed(2)}/m
            </span>
          </div>
          <div class="flex items-center justify-between text-[10px] font-[440] leading-3 text-v2-text-text-muted">
            <span>{language.t("openrouter.free.sustainable")}</span>
            <span class="font-[520] tabular-nums text-v2-text-text-base">
              {props.report.free.projection.sustainableRequestsPerHour.toFixed(1)}/h
            </span>
          </div>
          <Show when={props.report.free.projection.willExhaustBeforeReset}>
            <div class="rounded-md bg-v2-state-bg-danger px-2 py-1 text-[10px] font-[520] leading-3 text-v2-state-fg-danger">
              {language.t("openrouter.free.willExhaust", {
                at: props.report.free.projection.estimatedExhaustionAt
                  ? new Date(props.report.free.projection.estimatedExhaustionAt).toLocaleTimeString()
                  : language.t("openrouter.free.beforeReset"),
              })}
            </div>
          </Show>
          <div class="flex items-center justify-between text-[10px] font-[440] leading-3 text-v2-text-text-muted">
            <span>{language.t("openrouter.free.value")}</span>
            <span class="font-[520] tabular-nums text-v2-text-text-base">
              ${props.report.free.value.equivalentPaidValueUsd.toFixed(2)} ·{" "}
              {formatNumber(props.report.free.value.valuedRequests, intl())} valued
            </span>
          </div>
          <div class="flex items-center justify-between text-[9px] font-[440] leading-3 text-v2-text-text-faint">
            <span>
              {props.report.free.tier.source === "credits-api"
                ? `$${props.report.free.tier.totalCreditsPurchased ?? 0} credits → ${props.report.free.limit}/day`
                : `${props.report.free.limit}/day (override)`}
            </span>
            <Show when={props.report.source.stale}>
              <span class="rounded bg-v2-state-bg-warning px-1 text-v2-state-fg-warning">{language.t("openrouter.free.stale")}</span>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

export function FreeUsageModelsTable(props: { report: FreeUsageReport }) {
  const language = useLanguage()
  const models = () => [...props.report.free.models].sort((a, b) => b.requests - a.requests)
  const [expanded, setExpanded] = createSignal(false)
  const visible = () => (expanded() ? models() : models().slice(0, 5))

  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-[10px] font-[600] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
          {language.t("openrouter.free.models")}
        </span>
        <span class="text-[10px] font-[520] tabular-nums text-v2-text-text-muted">
          {models().length} models
        </span>
      </div>
      <div class="flex flex-col overflow-hidden rounded-md border border-v2-border-border-muted">
        <div class="grid grid-cols-[minmax(0,1fr)_40px_56px_56px] gap-1 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1 text-[8px] font-[600] uppercase leading-3 tracking-[0.03em] text-v2-text-text-faint">
          <span>{language.t("openrouter.free.model")}</span>
          <span class="text-right">{language.t("openrouter.free.requests")}</span>
          <span class="text-right">{language.t("openrouter.free.tokens")}</span>
          <span class="text-right">{language.t("openrouter.free.value")}</span>
        </div>
        <Show when={models().length > 0} fallback={<div class="px-2 py-3 text-center text-[10px] font-[440] text-v2-text-text-faint">{language.t("openrouter.free.models.empty")}</div>}>
          <For each={visible()}>
            {(m) => (
              <div class="grid grid-cols-[minmax(0,1fr)_40px_56px_56px] items-center gap-1 border-b border-v2-border-border-muted px-2 py-1 last:border-0">
                <span class="min-w-0 truncate text-[10px] font-[480] leading-3.5 text-v2-text-text-base" title={m.model}>
                  {m.model}
                </span>
                <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">{m.requests}</span>
                <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">{m.tokens.total.toLocaleString(language.intl())}</span>
                <span class="text-right text-[10px] font-[520] tabular-nums text-v2-text-text-base">
                  {m.value.equivalentPaidValueUsd !== null ? `$${m.value.equivalentPaidValueUsd.toFixed(2)}` : "—"}
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>
      <Show when={models().length > 5}>
        <button
          type="button"
          class="self-center text-[10px] font-[520] leading-3 text-v2-text-text-accent hover:underline"
          onClick={() => setExpanded(!expanded())}
        >
          {expanded() ? language.t("common.showLess") : language.t("common.showMore", { count: models().length - 5 })}
        </button>
      </Show>
    </div>
  )
}
