import { createMemo, createResource, createSignal, For, Show, Switch, Match, onCleanup } from "solid-js"
import { ResizeHandle, type ResizeHandlePairSide } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useNow } from "@/hooks/use-now"
import { useLimits } from "@/hooks/use-limits"
import { LIMITS_PANEL_WIDTH_MAX, LIMITS_PANEL_WIDTH_MIN, type LimitsPanelState } from "./limits-panel-state"
import {
  toneForRemaining,
  colorForTone,
  formatPercent,
  formatRemainingPercent,
  formatResetDate,
  formatAge,
  formatCountdownSeconds,
  displayWindowLabel,
  sortWindows,
  worstRemainingFromWindows,
} from "@/utils/limits-format"

type UsageWindow = {
  usedPercent: number | null
  remainingPercent: number | null
  windowSeconds: number | null
  resetAt: number | null
  resetAfterSeconds: number | null
  valueLabel: string | null
}

type ProviderResult = {
  providerId: string
  providerName: string
  ok: boolean
  configured: boolean
  error?: string
  planLabel?: string | null
  usage: { windows: Record<string, UsageWindow>; models?: Record<string, { windows: Record<string, UsageWindow> }> } | null
  fetchedAt: number
}

function WindowRow(props: { label: string; window: UsageWindow; now: number }) {
  const language = useLanguage()
  const used = () => props.window.usedPercent
  const remaining = createMemo(() => {
    const r = props.window.remainingPercent
    if (r !== null && r !== undefined && Number.isFinite(r)) return formatRemainingPercent(r)
    const u = used()
    if (u !== null && Number.isFinite(u)) return formatRemainingPercent(100 - u)
    return null
  })
  const tone = createMemo(() => toneForRemaining(remaining()))
  const isCredits = () => {
    const w = props.window
    return w.valueLabel !== null && w.valueLabel !== undefined && w.valueLabel !== "" && remaining() === null && (w.usedPercent === null || w.usedPercent === undefined)
  }
  const resetSeconds = createMemo(() => {
    const w = props.window
    if (w.resetAt !== null && w.resetAt !== undefined && Number.isFinite(w.resetAt)) {
      return Math.max(0, Math.round((w.resetAt - props.now) / 1000))
    }
    if (w.resetAfterSeconds !== null && w.resetAfterSeconds !== undefined && Number.isFinite(w.resetAfterSeconds)) {
      return Math.max(0, Math.round(w.resetAfterSeconds))
    }
    return null
  })
  const resetAt = () => props.window.resetAt
  const hasReset = () => resetSeconds() !== null || resetAt() !== null

  return (
    <Show
      when={!isCredits()}
      fallback={
        <div class="flex items-center justify-between gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5 py-2">
          <span class="text-[10px] font-[600] uppercase leading-3 tracking-[0.03em] text-v2-text-text-faint">
            {displayWindowLabel(props.label, language.t)}
          </span>
          <span class="truncate text-right text-[11px] font-[560] leading-3 tabular-nums text-v2-text-text-base" title={props.window.valueLabel ?? ""}>
            {props.window.valueLabel}
          </span>
        </div>
      }
    >
      <div class="flex flex-col gap-1.5 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5 py-2">
        {/* Row 1: label + countdown */}
        <div class="flex items-center justify-between gap-2">
          <span class="min-w-0 truncate text-[10px] font-[600] uppercase leading-3 tracking-[0.03em] text-v2-text-text-faint">
            {displayWindowLabel(props.label, language.t)}
          </span>
          <Show
            when={hasReset()}
            fallback={<span class="shrink-0 text-[9px] font-[440] leading-3 text-v2-text-text-faint">{language.t("limits.reset.never")}</span>}
          >
            <span class="flex shrink-0 items-center gap-1 text-[9px] font-[520] leading-3 tabular-nums text-v2-text-text-faint" title={resetAt() ? formatResetDate(resetAt()!, language.intl()) : undefined}>
              <Icon name="outline-reset" size="small" class="size-3 shrink-0 opacity-70" />
              <Show when={resetSeconds() !== null} fallback={<span>{language.t("limits.reset.soon")}</span>}>
                <span class="tabular-nums">{formatCountdownSeconds(resetSeconds()!, language.t)}</span>
              </Show>
            </span>
          </Show>
        </div>

        {/* Row 2: anxiety-inducing remaining vs used */}
        <div class="flex items-baseline justify-between gap-2">
          <div class="flex min-w-0 items-baseline gap-1.5">
            <Show when={remaining() !== null} fallback={<span class="text-[11px] font-[560] tabular-nums text-v2-text-text-muted">—</span>}>
              <span class="text-[13px] font-[700] leading-none tabular-nums tracking-[-0.01em]" style={{ color: colorForTone(tone()) }}>
                {formatPercent(remaining(), language.intl())}
              </span>
              <span class="text-[9px] font-[600] uppercase leading-3 tracking-[0.03em]" style={{ color: colorForTone(tone()) }}>
                {language.t("limits.remainingLabel")}
              </span>
            </Show>
            <Show when={used() !== null}>
              <span class="hidden text-[10px] font-[440] leading-3 tabular-nums text-v2-text-text-faint sm:inline">
                · {formatPercent(used(), language.intl())} {language.t("limits.usedSubtle")}
              </span>
            </Show>
          </div>
          <Show when={resetAt()}>
            <span class="shrink-0 truncate text-right text-[10px] font-[440] leading-3 tabular-nums text-v2-text-text-faint" title={formatResetDate(resetAt()!, language.intl())}>
              {formatResetDate(resetAt()!, language.intl())}
            </span>
          </Show>
        </div>

        {/* Row 3: depletion bar — filled = used (anxiety grows as bar fills) */}
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-v2-background-bg-layer-03">
          <div
            class="h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${Math.max(2, Math.min(100, used() ?? (remaining() !== null ? 100 - remaining()! : 0)))}%`,
              "background-color": colorForTone(tone()),
              opacity: remaining() === null ? "0.35" : "1",
            }}
          />
        </div>

        <Show when={remaining() !== null && used() !== null}>
          <div class="flex items-center justify-between gap-2 text-[9px] leading-3">
            <span class="tabular-nums text-v2-text-text-faint">{formatPercent(used(), language.intl())} used</span>
            <span class="tabular-nums font-[520]" style={{ color: colorForTone(tone()) }}>
              {remaining()! <= 10 ? language.t("limits.critical") : remaining()! <= 30 ? language.t("limits.atRisk") : language.t("limits.healthy")}
            </span>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function ProviderCard(props: { result: ProviderResult; now: number }) {
  const language = useLanguage()
  const windows = createMemo(() => {
    const usage = props.result.usage
    if (!usage) return [] as Array<[string, UsageWindow]>
    return sortWindows(Object.entries(usage.windows) as Array<[string, UsageWindow]>)
  })
  const worstRemaining = createMemo(() => worstRemainingFromWindows(windows()))
  const tone = createMemo(() => toneForRemaining(worstRemaining()))

  return (
    <div class="flex flex-col overflow-hidden rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-base">
      {/* Provider header — dense, zinc, linear-esque */}
      <div class="flex items-center gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5 py-2">
        <ProviderIcon id={props.result.providerId} class="size-4 shrink-0 opacity-80" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="truncate text-[11px] font-[600] leading-3 text-v2-text-text-base">{props.result.providerName}</span>
            <Show when={props.result.planLabel}>
              <span class="max-w-[90px] truncate rounded bg-v2-background-bg-layer-03 px-1 py-0.5 text-[8px] font-[600] uppercase leading-none tracking-[0.03em] text-v2-text-text-faint">
                {props.result.planLabel}
              </span>
            </Show>
            <Show when={worstRemaining() !== null}>
              <span
                class="hidden h-1.5 w-1.5 shrink-0 rounded-full sm:inline-flex"
                style={{ "background-color": colorForTone(tone()) }}
                aria-hidden="true"
              />
            </Show>
          </div>
          <div class="flex items-center gap-1 text-[9px] font-[440] leading-3 text-v2-text-text-faint">
            <span class="truncate">{formatAge(props.result.fetchedAt, props.now, language.t)}</span>
            <span class="opacity-40">·</span>
            <span class="shrink-0 capitalize">
              <Switch>
                <Match when={!props.result.configured}>{language.t("limits.state.notConfigured")}</Match>
                <Match when={props.result.ok}>{language.t("limits.state.ok")}</Match>
                <Match when={true}>{language.t("limits.state.error")}</Match>
              </Switch>
            </span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <Show when={worstRemaining() !== null}>
            <TooltipV2 value={`${formatPercent(worstRemaining(), language.intl())} ${language.t("limits.remainingLabel")}`}>
              <span
                class="rounded-md px-1.5 py-1 text-[10px] font-[700] leading-3 tabular-nums"
                style={{
                  color: colorForTone(tone()),
                  "background-color": `color-mix(in srgb, ${colorForTone(tone())} 12%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${colorForTone(tone())} 18%, transparent)`,
                }}
              >
                {formatPercent(worstRemaining(), language.intl())}
              </span>
            </TooltipV2>
          </Show>
          <Show when={!props.result.configured}>
            <span class="rounded bg-v2-background-bg-layer-03 px-1.5 py-1 text-[9px] font-[600] uppercase leading-none tracking-[0.03em] text-v2-text-text-faint">
              {language.t("limits.state.notConfigured")}
            </span>
          </Show>
        </div>
      </div>

      <div class="flex flex-col gap-1.5 p-2">
        <Switch>
          <Match when={!props.result.configured}>
            <div class="rounded-md border border-dashed border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5 py-3 text-center">
              <div class="text-[10px] font-[500] leading-3 text-v2-text-text-muted">{language.t("limits.notConfiguredHint")}</div>
            </div>
          </Match>
          <Match when={!props.result.ok}>
            <div class="rounded-md border border-v2-border-border-muted bg-v2-state-bg-danger/40 px-2.5 py-2.5">
              <div class="flex items-center gap-1.5 text-[10px] font-[600] leading-3 text-v2-state-fg-danger">
                <Icon name="warning" size="small" class="size-3 shrink-0" />
                {props.result.error ?? language.t("limits.error")}
              </div>
            </div>
          </Match>
          <Match when={windows().length === 0}>
            <div class="px-2 py-3 text-center text-[10px] font-[440] leading-3 text-v2-text-text-faint">{language.t("limits.error")}</div>
          </Match>
          <Match when={true}>
            <For each={windows()}>{([key, w]) => <WindowRow label={key} window={w} now={props.now} />}</For>
          </Match>
        </Switch>
      </div>
    </div>
  )
}

function LimitsPanelContent() {
  const language = useLanguage()
  const now = useNow()
  const { providers, goByCredential, openRouterFree, isLoading, hasError, error, refresh, isCoolingDown, cooldownRemainingMs } = useLimits()

  const sortedQuotas = providers
  const atRiskCount = createMemo(() => {
    const list = sortedQuotas()
    if (!list || list.length === 0) return 0
    let count = 0
    for (const provider of list) {
      const w = provider.windowsSorted
      for (const [, win] of w) {
        const r = win.remainingPercent ?? (win.usedPercent !== null ? 100 - win.usedPercent : null)
        if (r !== null && r <= 30) {
          count += 1
          break
        }
      }
    }
    return count
  })

  const refreshButtonDisabled = () => isCoolingDown() || isLoading()
  const refreshClick = () => refresh()

  const onFocus = () => {
    if (document.hidden) return
    if (isCoolingDown()) return
    setTimeout(() => {
      if (isCoolingDown()) return
      refresh()
    }, 200)
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus)
    onCleanup(() => window.removeEventListener("focus", onFocus))
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      {/* Subheader — dense, professional, zinc */}
      <div class="flex shrink-0 items-center justify-between gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-base px-2.5 py-2">
        <div class="min-w-0">
          <div class="text-[10px] font-[600] uppercase leading-3 tracking-[0.04em] text-v2-text-text-faint">
            {language.t("limits.panel.subtitle")}
          </div>
          <Show
            when={!isLoading() && sortedQuotas()}
            fallback={<div class="text-[11px] font-[500] leading-3 text-v2-text-text-muted">{language.t("limits.loading")}</div>}
          >
            <div class="flex items-center gap-1.5 text-[11px] font-[440] leading-3">
              <Show
                when={atRiskCount() === 0}
                fallback={<span class="font-[520] text-v2-state-fg-warning">{language.t("limits.attentionNeeded", { count: atRiskCount(), plural: atRiskCount() === 1 ? "" : "s" })}</span>}
              >
                <span class="text-v2-text-text-faint">{language.t("limits.allHealthy")}</span>
              </Show>
              <span class="text-v2-text-text-faint">·</span>
              <span class="tabular-nums text-v2-text-text-muted">{sortedQuotas()!.length} providers</span>
            </div>
          </Show>
        </div>
        <TooltipV2 value={isCoolingDown() ? `${Math.ceil(cooldownRemainingMs() / 1000)}s` : language.t("limits.refresh")}>
          <button
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 text-v2-icon-icon-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base disabled:opacity-50"
            disabled={isCoolingDown() || isLoading()}
            onClick={refresh}
            aria-label={language.t("limits.refresh")}
          >
            <Show when={isLoading()} fallback={<Show when={isCoolingDown()} fallback={<Icon name="outline-reset" size="small" class="size-3.5" />}>
              <span class="text-[10px] font-[560] leading-none tabular-nums">{Math.ceil(cooldownRemainingMs() / 1000)}</span>
            </Show>}>
              <Spinner class="size-3.5" />
            </Show>
          </button>
        </TooltipV2>
      </div>

      <ScrollView class="min-h-0 flex-1">
        <div class="flex flex-col gap-2.5 p-2.5">
          <Switch>
            <Match when={isLoading() && !sortedQuotas()}>
              <div class="flex items-center justify-center gap-2 py-12 text-[11px] font-[440] text-v2-text-text-faint">
                <Spinner class="size-3.5 text-v2-icon-icon-muted" />
                {language.t("limits.loading")}
              </div>
            </Match>
            <Match when={hasError() && !sortedQuotas()}>
              <div class="flex flex-col items-center gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-3 py-8 text-center">
                <span class="text-[11px] font-[600] leading-3 text-v2-state-fg-danger">{language.t("limits.error")}</span>
                <span class="max-w-full truncate text-[10px] leading-3 text-v2-text-text-faint">
                  {String(error() ?? "")}
                </span>
                <button
                  type="button"
                  class="mt-1 rounded-md bg-v2-background-bg-layer-03 px-2.5 py-1 text-[10px] font-[560] leading-3 text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
                  onClick={refresh}
                >
                  {language.t("limits.error.retry")}
                </button>
              </div>
            </Match>
            <Match when={sortedQuotas() && sortedQuotas()!.length === 0}>
              <div class="rounded-md border border-dashed border-v2-border-border-muted bg-v2-background-bg-layer-01 px-3 py-8 text-center text-[11px] font-[440] text-v2-text-text-faint">
                {language.t("limits.empty")}
              </div>
            </Match>
            <Match when={sortedQuotas()}>
              <For each={sortedQuotas()!}>{(provider) => <ProviderCard result={provider.result} now={now()} />}</For>
              <div class="px-1 pt-1 text-[9px] font-[440] leading-3 text-v2-text-text-faint">
                {language.t("limits.subtitle")} · <span class="tabular-nums">{formatAge(sortedQuotas()![0]?.result?.fetchedAt ?? Date.now(), now(), language.t)}</span> ago
              </div>
            </Match>
          </Switch>
        </div>
      </ScrollView>
    </div>
  )
}

export function LimitsPanel(props: {
  state: LimitsPanelState
  opened: boolean
  onClose: () => void
  pair?: { left: ResizeHandlePairSide | ResizeHandlePairSide[]; right: ResizeHandlePairSide }
}) {
  const language = useLanguage()
  return (
    <div
      id="limits-panel"
      class="flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"
      style={{ width: `${props.state.sidebarWidth()}px` }}
      data-limits-panel
    >
      <div class="flex h-8 shrink-0 items-center gap-1 border-b border-v2-border-border-base bg-v2-background-bg-base px-1.5">
        <span class="min-w-0 flex-1 truncate px-1 text-[11px] leading-none text-v2-text-text-muted">
          {language.t("limits.panel.title")}
        </span>
        <TooltipV2 value={language.t("common.collapse")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            onClick={props.onClose}
            aria-label={language.t("common.collapse")}
            icon={<Icon name="close" />}
          />
        </TooltipV2>
      </div>
      <div class="relative min-h-0 flex-1 overflow-hidden">
        <Show when={props.state.visible()}>
          <LimitsPanelContent />
        </Show>
      </div>
      <ResizeHandle
        direction="horizontal"
        edge="start"
        size={props.state.sidebarWidth()}
        min={LIMITS_PANEL_WIDTH_MIN}
        max={LIMITS_PANEL_WIDTH_MAX}
        onResize={props.state.resizeSidebar}
        pair={props.pair}
      />
    </div>
  )
}
