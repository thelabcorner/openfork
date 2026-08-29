import { createMemo, createSignal, For, Show, Switch, Match, type Accessor, type JSX } from "solid-js"
import { ResizeHandle, type ResizeHandlePairSide } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useLanguage } from "@/context/language"
import { useNow } from "@/hooks/use-now"
import { useLimits, type LimitProvider } from "@/hooks/use-limits"
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
  resolveTierGate,
  tierGateState,
  forkWindowToUsageWindow,
  type TierGate,
} from "@/utils/limits-format"
import type { ForkCredentialInfo, ForkCredentialUsage, ForkWindowUsage } from "@/utils/fork-client"
import type { FreeUsageReport } from "@/utils/openrouter-free-usage"

type Tone = ReturnType<typeof toneForRemaining>

/**
 * One continuous, column-aligned list — the same six-column rhythm (dot ·
 * label · meter · left% · reset · trailing) runs from the top-level provider
 * rows down through every nested window row, so the pane reads as one dense
 * table. Windows are never hidden behind a click here: a provider's
 * 5h/weekly/monthly rows render unconditionally under its header. Only the
 * Go per-key drill-down (rarely needed, potentially many keys) stays behind
 * a toggle.
 */
const GRID_COLS = "grid-cols-[14px_minmax(0,1fr)_auto_46px_88px_16px]"

function remainingOf(w: { remainingPercent: number | null; usedPercent: number | null }): number | null {
  const r = w.remainingPercent
  if (r !== null && r !== undefined && Number.isFinite(r)) return formatRemainingPercent(r)
  const u = w.usedPercent
  if (u !== null && u !== undefined && Number.isFinite(u)) return formatRemainingPercent(100 - u)
  return null
}

/**
 * The free-usage report ships `window.secondsUntilReset` as a snapshot from
 * whenever it was last fetched — feeding that straight into a countdown
 * freezes it between polls instead of ticking every second like every other
 * clock on the pane. `window.resetsAt` is a fixed point in time (an ISO
 * string); converting it once here lets the shared `now` do the ticking, the
 * same way every other reset on this pane already works.
 */
function openRouterFreeResetAt(report: FreeUsageReport): number | null {
  const ms = new Date(report.free.window.resetsAt).getTime()
  return Number.isFinite(ms) ? ms : null
}

type GlobalBucketKey = "5h" | "weekly" | "monthly"

/**
 * Maps an arbitrary provider window onto one of the three cadences everyone
 * actually thinks in. Exact window lengths (18,000s / 604,800s) cover
 * Claude/Codex/Go. xAI's window is keyed "billing_cycle" but actually resets
 * weekly, not monthly — the label describes billing, not the reset cadence,
 * so it's bucketed by real-world behavior rather than taken at face value.
 * Anything else (credits/balances, NVIDIA's 1-minute burst window) doesn't
 * belong to any of the three and is excluded.
 */
function bucketForWindow(key: string, windowSeconds: number | null | undefined): GlobalBucketKey | null {
  if (windowSeconds === 18_000) return "5h"
  if (windowSeconds === 604_800) return "weekly"
  if (windowSeconds !== null && windowSeconds !== undefined && windowSeconds >= 2_000_000 && windowSeconds <= 2_764_800) return "monthly"
  const lower = key.toLowerCase()
  if (lower === "5h") return "5h"
  if (lower === "weekly" || lower === "billing_cycle") return "weekly"
  if (lower === "monthly") return "monthly"
  return null
}

interface GlobalBucketAcc {
  weightedSum: number
  weight: number
  minResetAt: number | null
  maxResetAt: number | null
}

function accumulateBucket(acc: GlobalBucketAcc, remaining: number | null, weight: number, resetAt: number | null | undefined) {
  if (remaining !== null && Number.isFinite(remaining)) {
    acc.weightedSum += remaining * weight
    acc.weight += weight
  }
  if (resetAt !== null && resetAt !== undefined && Number.isFinite(resetAt)) {
    acc.minResetAt = acc.minResetAt === null ? resetAt : Math.min(acc.minResetAt, resetAt)
    acc.maxResetAt = acc.maxResetAt === null ? resetAt : Math.max(acc.maxResetAt, resetAt)
  }
}

function formatResetRange(now: number, minResetAt: number | null, maxResetAt: number | null, t: Parameters<typeof formatCountdownSeconds>[1]): string {
  if (minResetAt === null || maxResetAt === null) return ""
  const minSeconds = Math.max(0, Math.round((minResetAt - now) / 1000))
  const maxSeconds = Math.max(0, Math.round((maxResetAt - now) / 1000))
  const soonest = formatCountdownSeconds(minSeconds, t)
  if (Math.abs(maxSeconds - minSeconds) < 30) return soonest
  return `${soonest} – ${formatCountdownSeconds(maxSeconds, t)}`
}

function ToneDot(props: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      class="inline-flex size-1.5 shrink-0 rounded-full"
      classList={{ "animate-pulse": !!props.pulse }}
      style={{ "background-color": colorForTone(props.tone) }}
      aria-hidden="true"
    />
  )
}

function StatePill(props: { tone?: Tone; children: JSX.Element }) {
  const color = () => (props.tone ? colorForTone(props.tone) : "var(--v2-text-text-faint)")
  return (
    <span
      class="inline-flex max-w-[96px] shrink-0 items-center truncate rounded-[3px] px-1 py-0.5 text-[7px] font-[700] uppercase leading-none tracking-[0.04em]"
      style={{
        color: color(),
        "background-color": props.tone
          ? `color-mix(in srgb, ${color()} 12%, transparent)`
          : "var(--v2-background-bg-layer-03)",
      }}
    >
      {props.children}
    </span>
  )
}

/**
 * One element, not one-per-segment — the "drained" look is a static CSS mask
 * (painted once, zero reactive cost); the only thing that updates per data
 * change is a single two-stop gradient marking the boundary. Drains
 * left→right: the lit color is pinned to the right edge and the dark/drained
 * region eats in from the left as `remaining` falls — it never grows toward
 * "full".
 */
function DrainMeter(props: { remaining: number | null; tone: Tone; dense?: boolean }) {
  const boundary = createMemo(() => {
    const r = props.remaining
    if (r === null || r === undefined || !Number.isFinite(r)) return 100
    const clamped = Math.max(0, Math.min(100, r))
    if (clamped <= 0) return 100
    return Math.min(98, 100 - clamped)
  })

  return (
    <div
      class="w-[64px] shrink-0 rounded-[1px] [mask-image:repeating-linear-gradient(to_right,#000_0,#000_3px,transparent_3px,transparent_5px)] [-webkit-mask-image:repeating-linear-gradient(to_right,#000_0,#000_3px,transparent_3px,transparent_5px)]"
      classList={{ "h-2.5": props.dense, "h-3": !props.dense }}
      style={{
        background: `linear-gradient(to right, var(--v2-background-bg-layer-03) ${boundary()}%, ${colorForTone(props.tone)} ${boundary()}%)`,
        opacity: props.remaining === null ? 0.4 : 1,
      }}
      aria-hidden="true"
    />
  )
}

function CountdownText(props: { now: number; resetAt: number | null; resetAfterSeconds?: number | null }) {
  const language = useLanguage()
  const seconds = createMemo(() => {
    if (props.resetAt !== null && props.resetAt !== undefined && Number.isFinite(props.resetAt)) {
      return Math.max(0, Math.round((props.resetAt - props.now) / 1000))
    }
    if (props.resetAfterSeconds !== null && props.resetAfterSeconds !== undefined && Number.isFinite(props.resetAfterSeconds)) {
      return Math.max(0, Math.round(props.resetAfterSeconds))
    }
    return null
  })
  return (
    <span
      class="truncate text-[9.5px] leading-none tabular-nums text-v2-text-text-faint"
      title={props.resetAt ? formatResetDate(props.resetAt, language.intl()) : undefined}
    >
      <Show when={seconds() !== null} fallback={<span class="opacity-45">{language.t("limits.reset.never")}</span>}>
        {formatCountdownSeconds(seconds()!, language.t)}
      </Show>
    </span>
  )
}

/** One window row — 5h / weekly / monthly / free-tier / credits. Always rendered, never behind a click. */
function WindowRow(props: {
  now: number
  guide: "branch" | "leaf"
  depth?: number
  label: string
  tag?: JSX.Element
  remaining: number | null
  valueLabel?: string | null
  used?: number | null
  tone: Tone
  resetAt: number | null
  resetAfterSeconds?: number | null
  dim?: boolean
  /** Summary rows (e.g. a Go key's header line) show the percent but no bar — only the actual 5h/weekly/monthly rows underneath drain. */
  noMeter?: boolean
}) {
  const language = useLanguage()
  const title = () =>
    props.used !== null && props.used !== undefined
      ? `${formatPercent(props.used, language.intl())} ${language.t("limits.usedSubtle")}`
      : undefined
  const indent = () => `${((props.depth ?? 1) - 1) * 14}px`

  return (
    <div
      class={`grid ${GRID_COLS} items-center gap-2 px-2.5 py-2 transition-colors hover:bg-v2-overlay-simple-overlay-hover`}
      classList={{ "opacity-55": !!props.dim }}
      title={title()}
    >
      <div class="col-span-2 flex min-w-0 items-center gap-1.5" style={{ "padding-left": indent() }}>
        <span class="w-[14px] shrink-0 text-center text-[10px] leading-none text-v2-text-text-faint opacity-45">
          {props.guide === "branch" ? "├" : "└"}
        </span>
        <span class="min-w-0 truncate text-[10px] font-[560] leading-3 text-v2-text-text-base">{props.label}</span>
        <Show when={props.tag}>{props.tag}</Show>
      </div>
      <Show when={!props.noMeter} fallback={<span />}>
        <DrainMeter remaining={props.remaining} tone={props.tone} dense />
      </Show>
      <Show
        when={props.remaining !== null}
        fallback={
          <span class="col-span-2 truncate text-right text-[9.5px] font-[560] tabular-nums text-v2-text-text-base" title={props.valueLabel ?? undefined}>
            {props.valueLabel ?? "—"}
          </span>
        }
      >
        <span class="text-right text-[10.5px] font-[700] leading-none tabular-nums" style={{ color: colorForTone(props.tone) }}>
          {formatPercent(props.remaining, language.intl())}
        </span>
        <div class="flex justify-end">
          <CountdownText now={props.now} resetAt={props.resetAt} resetAfterSeconds={props.resetAfterSeconds} />
        </div>
      </Show>
      <span />
    </div>
  )
}

function ProviderGroup(props: { provider: LimitProvider; now: number; openRouterFree?: FreeUsageReport }) {
  const language = useLanguage()
  const result = () => props.provider.result
  const windows = () => props.provider.windowsSorted
  const gate = () => props.provider.gate
  const worstRemaining = () => props.provider.worstRemaining
  const tone = () => props.provider.tone
  const blocked = () => worstRemaining() !== null && worstRemaining()! <= 0
  const hardError = createMemo(() => !result().ok && windows().length === 0)
  const staleError = createMemo(() => !result().ok && !hardError())
  const rowTone = createMemo<Tone>(() => (hardError() ? "danger" : tone()))

  return (
    <div class="overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-base">
      <div class={`grid ${GRID_COLS} items-center gap-2 bg-v2-background-bg-layer-01 px-2.5 py-2`}>
        <ToneDot tone={rowTone()} pulse={blocked()} />
        <div class="flex min-w-0 items-center gap-1.5">
          <ProviderIcon id={result().providerId} class="size-3.5 shrink-0 opacity-85" />
          <span class="min-w-0 truncate text-[11px] font-[650] leading-3 text-v2-text-text-base">{result().providerName}</span>
          <Show when={result().planLabel}>
            <span class="hidden shrink-0 truncate text-[8px] font-[560] uppercase leading-none tracking-[0.03em] text-v2-text-text-faint sm:inline">
              {result().planLabel}
            </span>
          </Show>
          <Show when={staleError()}>
            <StatePill tone="danger">{language.t("limits.state.error")}</StatePill>
          </Show>
        </div>
        <span />
        <span />
        <span />
        <span />
      </div>

      {/*
        Always visible: on a 429 (or any transient fetch error) the hook keeps
        serving the last-good `usage` it cached with `ok: false` layered on
        top, so the header/windows above already reflect the stale-but-real
        numbers — the whole point is you never lose your bearings just
        because one poll failed.
      */}
      <Show when={hardError() || staleError()}>
        <div class="flex items-center gap-1.5 border-t border-v2-border-border-muted/60 bg-v2-state-bg-danger/15 px-2.5 py-1 pl-[30px] text-[9px] leading-3 text-v2-state-fg-danger">
          <Icon name="warning" size="small" class="size-2.5 shrink-0" />
          <span class="min-w-0 truncate">
            <Show when={staleError()}>
              <span class="text-v2-text-text-faint">{language.t("limits.stale.notice", { age: formatAge(result().fetchedAt, props.now, language.t) })} · </span>
            </Show>
            {result().error ?? language.t("limits.error")}
          </span>
        </div>
      </Show>

      <div class="flex flex-col divide-y divide-v2-border-border-muted/50 border-t border-v2-border-border-muted/50 empty:border-t-0">
        <For each={windows()}>
          {([key, w], index) => {
            const remaining = remainingOf(w)
            const rTone = toneForRemaining(remaining)
            const state = tierGateState(key, remaining, gate())
            const isLast = () => index() === windows().length - 1 && !props.openRouterFree
            return (
              <WindowRow
                now={props.now}
                guide={isLast() ? "leaf" : "branch"}
                label={displayWindowLabel(key, language.t)}
                tag={
                  <Show when={state === "binding"}>
                    <StatePill tone={rTone}>{language.t("limits.gate.limiting")}</StatePill>
                  </Show>
                }
                remaining={remaining}
                valueLabel={w.valueLabel}
                used={w.usedPercent}
                tone={rTone}
                resetAt={w.resetAt}
                resetAfterSeconds={w.resetAfterSeconds}
                dim={state === "gated"}
              />
            )
          }}
        </For>
        <Show when={!!props.openRouterFree}>
          <WindowRow
            now={props.now}
            guide="leaf"
            label={language.t("openrouter.free.title")}
            remaining={Math.round(props.openRouterFree!.free.remainingPercent * 10) / 10}
            used={100 - props.openRouterFree!.free.remainingPercent}
            tone={toneForRemaining(props.openRouterFree!.free.remainingPercent)}
            resetAt={openRouterFreeResetAt(props.openRouterFree!)}
          />
        </Show>
      </div>
    </div>
  )
}

function mapForkWindows(usage: ForkWindowUsage[]) {
  return usage.map((w) => {
    const mapped = forkWindowToUsageWindow(w)
    const key = mapped.windowSeconds === 18_000 ? "5h" : mapped.windowSeconds === 604_800 ? "weekly" : "monthly"
    return { key, mapped }
  })
}

function GoGroup(props: {
  aggregate: ForkWindowUsage[]
  byCredential: ForkCredentialUsage[]
  credentials: ForkCredentialInfo[]
  now: number
  keysExpanded: boolean
  onToggleKeys: () => void
}) {
  const language = useLanguage()
  const aggregateWindows = createMemo(() => mapForkWindows(props.aggregate))
  const aggregateGate = createMemo<TierGate>(() => resolveTierGate(aggregateWindows().map(({ key, mapped }) => [key, mapped])))
  const aggregateRemaining = () => aggregateGate().effectiveRemaining
  const aggregateTone = () => toneForRemaining(aggregateRemaining())
  const keyCount = () => Math.max(props.credentials.length, props.byCredential.length)

  return (
    <div class="overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-base">
      <div class={`grid ${GRID_COLS} items-center gap-2 bg-v2-background-bg-layer-01 px-2.5 py-2`}>
        <ToneDot tone={aggregateTone()} pulse={aggregateRemaining() !== null && aggregateRemaining()! <= 0} />
        <div class="flex min-w-0 items-center gap-1.5">
          <ProviderIcon id="opencode-go" class="size-3.5 shrink-0 opacity-85" />
          <span class="min-w-0 truncate text-[11px] font-[650] leading-3 text-v2-text-text-base">OpenCode Go</span>
          <span class="hidden shrink-0 text-[8px] font-[560] uppercase leading-none tracking-[0.03em] text-v2-text-text-faint sm:inline">
            {language.t("limits.go.keys", { count: keyCount(), plural: keyCount() === 1 ? "" : "s" })}
          </span>
        </div>
        <span />
        <span />
        <span />
        <span />
      </div>

      <div class="flex flex-col divide-y divide-v2-border-border-muted/50 border-t border-v2-border-border-muted/50">
        <For each={aggregateWindows()}>
          {({ key, mapped }, index) => (
            <WindowRow
              now={props.now}
              guide={index() === aggregateWindows().length - 1 && props.byCredential.length === 0 ? "leaf" : "branch"}
              label={displayWindowLabel(key, language.t)}
              tag={
                <Show when={tierGateState(key, mapped.remainingPercent, aggregateGate()) === "binding"}>
                  <StatePill tone={toneForRemaining(mapped.remainingPercent)}>{language.t("limits.gate.limiting")}</StatePill>
                </Show>
              }
              remaining={mapped.remainingPercent}
              used={mapped.usedPercent}
              tone={toneForRemaining(mapped.remainingPercent)}
              resetAt={mapped.resetAt}
              dim={tierGateState(key, mapped.remainingPercent, aggregateGate()) === "gated"}
            />
          )}
        </For>
      </div>

      <Show when={props.byCredential.length > 0}>
        <div class="border-t border-v2-border-border-muted/50">
          <button
            type="button"
            class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[9px] font-[600] uppercase leading-3 tracking-[0.04em] text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover"
            aria-expanded={props.keysExpanded}
            onClick={props.onToggleKeys}
          >
            <Icon name="chevron-down" size="small" class="size-2.5 transition-transform" classList={{ "-rotate-90": !props.keysExpanded }} />
            {language.t("limits.go.perKey")}
            <span class="font-[440] normal-case tracking-normal">{keyCount()}</span>
          </button>
          <Show when={props.keysExpanded}>
            <For each={props.byCredential}>
              {(credential) => {
                const windows = createMemo(() => mapForkWindows(credential.windows))
                const gate = createMemo(() => resolveTierGate(windows().map(({ key, mapped }) => [key, mapped])))
                const info = props.credentials.find((item) => item.id === credential.credentialID)
                return (
                  <>
                    <WindowRow
                      now={props.now}
                      guide="branch"
                      label={info?.label ?? credential.credentialID}
                      tag={
                        <Show when={info?.active}>
                          <StatePill tone="success">{language.t("dialog.credential.active")}</StatePill>
                        </Show>
                      }
                      remaining={gate().effectiveRemaining}
                      tone={toneForRemaining(gate().effectiveRemaining)}
                      resetAt={windows().find(({ key }) => key === gate().bindingKey)?.mapped.resetAt ?? null}
                      noMeter
                    />
                    <For each={windows()}>
                      {({ key, mapped }, index) => (
                        <WindowRow
                          now={props.now}
                          guide={index() === windows().length - 1 ? "leaf" : "branch"}
                          depth={2}
                          label={displayWindowLabel(key, language.t)}
                          remaining={mapped.remainingPercent}
                          used={mapped.usedPercent}
                          tone={toneForRemaining(mapped.remainingPercent)}
                          resetAt={mapped.resetAt}
                          dim={tierGateState(key, mapped.remainingPercent, gate()) === "gated"}
                        />
                      )}
                    </For>
                  </>
                )
              }}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  )
}

type Entry = { key: string; sort: number; kind: "provider"; provider: LimitProvider } | { key: string; sort: number; kind: "go" }

export function LimitsPanelContent(props: { active?: Accessor<boolean> }) {
  const language = useLanguage()
  const now = useNow(() => props.active?.() ?? true)
  const { providers, goAggregate, goByCredential, goCredentials, openRouterFree, isLoading, hasError, error, refresh, isCoolingDown, cooldownRemainingMs } = useLimits({ now })

  const showGoAggregate = createMemo(() => goAggregate().length > 0 || goByCredential().length > 0)
  const goGate = createMemo<TierGate>(() => {
    const windows = mapForkWindows(goAggregate())
    return resolveTierGate(windows.map(({ key, mapped }) => [key, mapped]))
  })

  // Urgency-first: the group that needs attention first is the group at the top.
  const entries = createMemo<Entry[]>(() => {
    const list = providers()
    if (!list) return []
    const items: Entry[] = list
      .filter((p) => p.result.providerId !== "opencode-go")
      .map((p) => ({
        key: `p:${p.result.providerId}`,
        sort: p.worstRemaining !== null ? p.worstRemaining : p.result.ok ? Number.POSITIVE_INFINITY : -1,
        kind: "provider" as const,
        provider: p,
      }))
    if (showGoAggregate()) {
      const r = goGate().effectiveRemaining
      items.push({ key: "go", sort: r !== null ? r : Number.POSITIVE_INFINITY, kind: "go" as const })
    }
    return items.sort((a, b) => a.sort - b.sort)
  })

  /**
   * The "ultimate" view: every provider's window folded into whichever of
   * the three real-world cadences it belongs to, weighted-averaged together.
   * NVIDIA is excluded outright (its 1-minute burst window isn't in the same
   * conversation as 5h/weekly/monthly anyway, but it's excluded explicitly
   * rather than relying on that coincidence). OpenRouter's free tier resets
   * daily — roughly five 5-hour windows — so it counts toward the global
   * 5-hour bucket at 1/5 weight: present, but correctly discounted rather
   * than treated as equivalent to an actual 5h rate limit.
   */
  const globalBuckets = createMemo(() => {
    const acc: Record<GlobalBucketKey, GlobalBucketAcc> = {
      "5h": { weightedSum: 0, weight: 0, minResetAt: null, maxResetAt: null },
      weekly: { weightedSum: 0, weight: 0, minResetAt: null, maxResetAt: null },
      monthly: { weightedSum: 0, weight: 0, minResetAt: null, maxResetAt: null },
    }
    for (const p of providers() ?? []) {
      if (p.result.providerId === "nvidia" || p.result.providerId === "opencode-go") continue
      for (const [key, w] of p.windowsSorted) {
        const bucket = bucketForWindow(key, w.windowSeconds)
        if (!bucket) continue
        accumulateBucket(acc[bucket], remainingOf(w), 1, w.resetAt)
      }
    }
    for (const { key, mapped } of mapForkWindows(goAggregate())) {
      const bucket = bucketForWindow(key, mapped.windowSeconds)
      if (!bucket) continue
      accumulateBucket(acc[bucket], mapped.remainingPercent, 1, mapped.resetAt)
    }
    const free = openRouterFree()
    if (free) {
      accumulateBucket(acc["5h"], free.free.remainingPercent, 0.2, openRouterFreeResetAt(free))
    }
    return acc
  })

  const globalBucketList = createMemo(() => {
    const acc = globalBuckets()
    return (["5h", "weekly", "monthly"] as const)
      .map((bucket) => {
        const b = acc[bucket]
        const remaining = b.weight > 0 ? b.weightedSum / b.weight : null
        return { bucket, remaining, tone: toneForRemaining(remaining), minResetAt: b.minResetAt, maxResetAt: b.maxResetAt }
      })
      .filter((b) => b.remaining !== null)
  })

  const [goKeysExpanded, setGoKeysExpanded] = createSignal(true)

  return (
    <div class="flex h-full min-h-0 flex-col">
      {/*
        The "ultimate limit viewer": every provider's window folded into
        whichever real-world cadence it belongs to (see globalBuckets above),
        so this reads as "how much of my overall 5h/weekly/monthly capacity
        is left" rather than a single flattened number. The reset column is
        a range, not one countdown — the contributing clocks don't all start
        at the same wall-clock moment, so "resets in 1h – 4h" is the honest
        answer, not a fake single figure.
      */}
      <div class="flex shrink-0 flex-col gap-1 border-b border-v2-border-border-muted bg-v2-background-bg-base px-2.5 py-2">
        <div class="flex items-center justify-between gap-2">
          <span class="shrink-0 text-[9px] font-[700] uppercase leading-none tracking-[0.08em] text-v2-text-text-faint">
            {language.t("limits.panel.subtitle")}
          </span>
          <TooltipV2 value={isCoolingDown() ? `${Math.ceil(cooldownRemainingMs() / 1000)}s` : language.t("limits.refresh")}>
            <button
              type="button"
              class="flex size-5 shrink-0 items-center justify-center rounded border border-v2-border-border-muted text-v2-icon-icon-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base disabled:opacity-50"
              disabled={isCoolingDown() || isLoading()}
              onClick={refresh}
              aria-label={language.t("limits.refresh")}
            >
              <Show
                when={isLoading()}
                fallback={
                  <Show when={isCoolingDown()} fallback={<Icon name="outline-reset" size="small" class="size-3" />}>
                    <span class="text-[10px] font-[560] leading-none tabular-nums">{Math.ceil(cooldownRemainingMs() / 1000)}</span>
                  </Show>
                }
              >
                <Spinner class="size-3" />
              </Show>
            </button>
          </TooltipV2>
        </div>
        <Show
          when={providers() !== undefined}
          fallback={<span class="text-[10px] text-v2-text-text-faint">{language.t("limits.loading")}</span>}
        >
          <Show
            when={globalBucketList().length > 0}
            fallback={<span class="text-[10px] font-[480] text-v2-text-text-faint">{language.t("limits.allHealthy")}</span>}
          >
            <For each={globalBucketList()}>
              {(bucket) => (
                <div class="flex items-center gap-2">
                  <span class="w-12 shrink-0 truncate text-[9.5px] font-[650] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
                    {displayWindowLabel(bucket.bucket, language.t)}
                  </span>
                  <DrainMeter remaining={bucket.remaining} tone={bucket.tone} dense />
                  <span class="w-10 shrink-0 text-right text-[10.5px] font-[750] leading-none tabular-nums" style={{ color: colorForTone(bucket.tone) }}>
                    {formatPercent(bucket.remaining, language.intl())}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-right text-[9px] leading-3 text-v2-text-text-faint">
                    {formatResetRange(now(), bucket.minResetAt, bucket.maxResetAt, language.t)}
                  </span>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>

      <ScrollView class="min-h-0 flex-1">
        <div class="flex flex-col gap-2 p-2.5">
          <Switch>
            <Match when={isLoading() && !providers()}>
              <div class="flex items-center gap-2 px-3 py-8 text-[10px] text-v2-text-text-faint">
                <Spinner class="size-3" />
                {language.t("limits.loading")}
              </div>
            </Match>
            <Match when={hasError() && !providers()}>
              <div class="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
                <span class="text-[10px] font-[650] text-v2-state-fg-danger">{language.t("limits.error")}</span>
                <span class="max-w-full truncate text-[9px] text-v2-text-text-faint">{String(error() ?? "")}</span>
                <button
                  type="button"
                  class="mt-1 rounded border border-v2-border-border-muted px-2 py-1 text-[9px] font-[600] text-v2-text-text-base transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                  onClick={refresh}
                >
                  {language.t("limits.error.retry")}
                </button>
              </div>
            </Match>
            <Match when={providers() && entries().length === 0}>
              <div class="px-3 py-8 text-center text-[10px] text-v2-text-text-faint">{language.t("limits.empty")}</div>
            </Match>
            <Match when={providers()}>
              <div class={`grid ${GRID_COLS} items-center gap-2 px-2.5 pb-1 text-[8px] font-[650] uppercase leading-none tracking-[0.06em] text-v2-text-text-faint`}>
                <span />
                <span>{language.t("limits.column.provider")}</span>
                <span>{language.t("limits.column.meter")}</span>
                <span class="text-right">{language.t("limits.column.remaining")}</span>
                <span class="text-right">{language.t("limits.column.reset")}</span>
                <span />
              </div>
              <For each={entries()}>
                {(entry) => {
                  if (entry.kind === "go") {
                    return (
                      <GoGroup
                        aggregate={goAggregate()}
                        byCredential={goByCredential()}
                        credentials={goCredentials()}
                        now={now()}
                        keysExpanded={goKeysExpanded()}
                        onToggleKeys={() => setGoKeysExpanded((v) => !v)}
                      />
                    )
                  }
                  return (
                    <ProviderGroup
                      provider={entry.provider}
                      now={now()}
                      openRouterFree={entry.provider.result.providerId === "openrouter" ? openRouterFree() : undefined}
                    />
                  )
                }}
              </For>
              <div class="px-1 pt-1 text-[9px] font-[440] leading-3 text-v2-text-text-faint">
                {language.t("limits.updatedAgo", { age: formatAge(providers()?.[0]?.result?.fetchedAt ?? Date.now(), now(), language.t) })}
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
      class="flex h-full min-h-0 shrink-0 self-stretch flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"
      classList={{ hidden: !props.opened }}
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
