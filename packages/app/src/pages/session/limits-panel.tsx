import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  Switch,
  Match,
  type Accessor,
  type JSX,
} from "solid-js"
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
import {
  LIMITS_PANEL_WIDTH_MAX,
  LIMITS_PANEL_WIDTH_MIN,
  limitsFocusRequest,
  type LimitsPanelState,
} from "./limits-panel-state"
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
  parseWorkBuddyKey,
  aggregateWorkbuddyModels,
  workbuddyModelDisplayName,
  verdentModelDisplayName,
  type TierGate,
  type UsageWindow,
  type WorkBuddyAccountLimits,
  type WorkBuddyModelLimit,
  type ZenKeyLimits,
} from "@/utils/limits-format"
import type { ForkCredentialInfo, ForkCredentialUsage, ForkWindowUsage } from "@/utils/fork-client"
import type { FreeUsageReport } from "@/utils/openrouter-free-usage"
import { useVerdentFreeUsage } from "@/hooks/use-verdent-free-usage"
import type { VerdentFreeReport } from "@/utils/verdent-free-usage"
import { DrainMeter, ToneDot, type Tone } from "@/components/limits/limit-meter"

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

// Verdent free — same pattern as OpenRouter free: window.resetsAt is ISO, tick via shared `now`.
function verdentFreeResetAt(report: VerdentFreeReport): number | null {
  const ms = new Date(report.window.resetsAt).getTime()
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
  if (windowSeconds !== null && windowSeconds !== undefined && windowSeconds >= 2_000_000 && windowSeconds <= 2_764_800)
    return "monthly"
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

function accumulateBucket(
  acc: GlobalBucketAcc,
  remaining: number | null,
  weight: number,
  resetAt: number | null | undefined,
) {
  if (remaining !== null && Number.isFinite(remaining)) {
    acc.weightedSum += remaining * weight
    acc.weight += weight
  }
  if (resetAt !== null && resetAt !== undefined && Number.isFinite(resetAt)) {
    acc.minResetAt = acc.minResetAt === null ? resetAt : Math.min(acc.minResetAt, resetAt)
    acc.maxResetAt = acc.maxResetAt === null ? resetAt : Math.max(acc.maxResetAt, resetAt)
  }
}

function formatResetRange(
  now: number,
  minResetAt: number | null,
  maxResetAt: number | null,
  t: Parameters<typeof formatCountdownSeconds>[1],
): string {
  if (minResetAt === null || maxResetAt === null) return ""
  const minSeconds = Math.max(0, Math.round((minResetAt - now) / 1000))
  const maxSeconds = Math.max(0, Math.round((maxResetAt - now) / 1000))
  const soonest = formatCountdownSeconds(minSeconds, t)
  if (Math.abs(maxSeconds - minSeconds) < 30) return soonest
  return `${soonest} – ${formatCountdownSeconds(maxSeconds, t)}`
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

function CountdownText(props: {
  now: number
  resetAt: number | null
  resetAfterSeconds?: number | null
  mode?: "countdown" | "date"
}) {
  const language = useLanguage()
  const seconds = createMemo(() => {
    if (props.resetAt !== null && props.resetAt !== undefined && Number.isFinite(props.resetAt)) {
      return Math.max(0, Math.round((props.resetAt - props.now) / 1000))
    }
    if (
      props.resetAfterSeconds !== null &&
      props.resetAfterSeconds !== undefined &&
      Number.isFinite(props.resetAfterSeconds)
    ) {
      return Math.max(0, Math.round(props.resetAfterSeconds))
    }
    return null
  })
  // A one-time expiry (a gift/top-up pack) reads better as a fixed date than
  // a recurring "resets in" countdown, which implies the cadence repeats.
  // Short form (no weekday/time) to fit the reset column; the full date is
  // still one hover away via the title tooltip.
  if (props.mode === "date") {
    const shortDate = () => {
      if (!props.resetAt) return null
      try {
        return new Intl.DateTimeFormat(language.intl(), { month: "short", day: "numeric" }).format(
          new Date(props.resetAt),
        )
      } catch {
        return new Date(props.resetAt).toLocaleDateString()
      }
    }
    return (
      <span
        class="truncate text-[9.5px] leading-none tabular-nums text-v2-text-text-faint"
        title={props.resetAt ? formatResetDate(props.resetAt, language.intl()) : undefined}
      >
        <Show when={shortDate()} fallback={<span class="opacity-45">{language.t("limits.expires.never")}</span>}>
          {shortDate()}
        </Show>
      </span>
    )
  }
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
  /** "date" for one-time expiries (gift/top-up packs) instead of a "resets in" countdown. */
  resetMode?: "countdown" | "date"
}) {
  const language = useLanguage()
  const title = () =>
    props.used !== null && props.used !== undefined
      ? `${formatPercent(props.used, language.intl())} ${language.t("limits.usedSubtle")}`
      : undefined
  const indent = () => `${((props.depth ?? 1) - 1) * 14}px`
  // Nested detail rows (per-account, per-model) repeat far more densely than
  // top-level rows — N accounts x M models adds up fast — so they get a
  // tighter vertical rhythm instead of the same breathing room a headline
  // row gets. A `noMeter` row is a pure grouping label (account/credential
  // header) with no bar and often no percent either, so it gets the same
  // tight treatment regardless of depth — it carries less information than
  // the rows nested under it and shouldn't be taller than them.
  const dense = () => (props.depth ?? 1) >= 2 || !!props.noMeter

  return (
    <div
      class={`grid ${GRID_COLS} items-center gap-2 px-2.5 transition-colors hover:bg-v2-overlay-simple-overlay-hover`}
      classList={{ "opacity-55": !!props.dim, "py-1": dense(), "py-2": !dense() }}
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
          <span
            class="col-span-2 truncate text-right text-[9.5px] font-[560] tabular-nums text-v2-text-text-base"
            title={props.valueLabel ?? undefined}
          >
            {props.valueLabel ?? "—"}
          </span>
        }
      >
        <span
          class="text-right text-[10.5px] font-[700] leading-none tabular-nums"
          style={{ color: colorForTone(props.tone) }}
        >
          {formatPercent(props.remaining, language.intl())}
        </span>
        <div class="flex justify-end">
          <CountdownText
            now={props.now}
            resetAt={props.resetAt}
            resetAfterSeconds={props.resetAfterSeconds}
            mode={props.resetMode}
          />
        </div>
      </Show>
      <span />
    </div>
  )
}

const WORKBUDDY_KIND_I18N = {
  basic: "limits.workbuddy.basic",
  gift: "limits.workbuddy.gift",
  extra: "limits.workbuddy.extra",
  combined: "limits.workbuddy.combined",
} as const

/**
 * WorkBuddy is genuinely multi-account (see quota/providers/workbuddy.ts's
 * key grammar), so its windows can't just be dumped into the generic flat
 * list — with N accounts each carrying Basic/Gift/Extra, the account's own
 * label needs to appear ONCE as a group header, not on every one of its
 * rows. Mirrors OpenCode Go's aggregate-on-top + collapsible per-key layout.
 *
 * WorkBuddy credits are additive, not tiered (Basic exhausting doesn't stop
 * you — Extra, then Gift, still work), so unlike every other provider on
 * this pane, the individual Basic/Gift/Extra rows never drive tone or the
 * "exhausted" tag. Only the combined Basic+Extra+Gift row does — both at the
 * aggregate level (the whole card) and per-account (that account's header).
 */
/** One account's merged row set: its promotional models, then its credit packs. */
type WorkBuddyMergedRow =
  | { kind: "model"; model: WorkBuddyModelLimit }
  | { kind: "credit"; credit: "Basic" | "Gift" | "Extra"; window: UsageWindow }

function WorkBuddyBody(props: {
  windows: [string, UsageWindow][]
  workbuddyAccounts?: WorkBuddyAccountLimits[]
  now: number
  /**
   * Lifted to `LimitsPanelContent` rather than owned as local state here:
   * this component lives inside `<For each={entries()}>`, and `entries()`
   * produces a brand-new array of brand-new objects every time ANY
   * provider's background poll completes (see `useLimits`'s `providers`
   * memo) — not just when WorkBuddy's own data changes. Keyed `<For>`
   * reconciliation then sees a "different" item and remounts this
   * component, which would silently reset a local signal back to its
   * default and collapse the section the user just opened. State that must
   * survive a poll has to live above the `<For>`.
   */
  accountsExpanded: boolean
  onToggleAccountsExpanded: () => void
}) {
  const language = useLanguage()
  const kindLabel = (kind: "basic" | "gift" | "extra" | "combined" | "Basic" | "Gift" | "Extra" | "Combined") =>
    language.t(WORKBUDDY_KIND_I18N[kind.toLowerCase() as "basic" | "gift" | "extra" | "combined"])

  const aggregateByKind = createMemo(() => {
    const byKind: Partial<Record<"basic" | "gift" | "extra" | "combined", UsageWindow>> = {}
    for (const [key, w] of props.windows) {
      const parsed = parseWorkBuddyKey(key)
      if (parsed?.scope === "aggregate") byKind[parsed.kind] = w
    }
    return byKind
  })
  const aggregateCombined = () => aggregateByKind().combined
  const aggregateRows = createMemo(() => {
    const byKind = aggregateByKind()
    return (["basic", "gift", "extra"] as const).flatMap((kind) =>
      byKind[kind] ? [{ kind, window: byKind[kind]! }] : [],
    )
  })

  const creditsByAccount = createMemo(() => {
    const byAccount = new Map<string, Partial<Record<"Basic" | "Gift" | "Extra" | "Combined", UsageWindow>>>()
    for (const [key, w] of props.windows) {
      const parsed = parseWorkBuddyKey(key)
      if (parsed?.scope !== "account") continue
      const entry = byAccount.get(parsed.account) ?? {}
      entry[parsed.kind] = w
      byAccount.set(parsed.account, entry)
    }
    return byAccount
  })

  const modelAccounts = () => props.workbuddyAccounts ?? []
  // One row per model FAMILY (Hy3, Hy4 Preview), summed across every account — the
  // number that actually answers "how much Hy3 do I have left", instead of a
  // cross-model blend that mixes two unrelated research priors together.
  // A model nobody has ever routed a request through (0 observed, never hard-
  // limited) has nothing to report — hide it rather than padding the list
  // with an all-gray "0 observed" row.
  const modelAggregates = createMemo(() =>
    aggregateWorkbuddyModels(modelAccounts()).filter((row) => row.usedObserved > 0 || row.anyExhausted),
  )
  const visibleModels = (acct: WorkBuddyAccountLimits) =>
    acct.models.filter((m) => m.usedObserved > 0 || m.exhaustedObserved)

  /**
   * ONE merged account list instead of two parallel "PER ACCOUNT"
   * collapsibles (promo models, package credits) that both grouped by the
   * exact same account label — a reader had to expand both and mentally
   * line them up by name to get the full picture of one account. Every
   * account is keyed identically (`accountLabels()`, shared by both the
   * credit windows and the model reports), so the join is exact, not fuzzy.
   */
  const mergedAccounts = createMemo(() => {
    const credits = creditsByAccount()
    const modelsByLabel = new Map(modelAccounts().map((acct) => [acct.label, visibleModels(acct)]))
    const labels = new Set([...credits.keys(), ...modelsByLabel.keys()])
    return [...labels]
      .map((label) => {
        const creditRows = credits.get(label)
        const models = modelsByLabel.get(label) ?? []
        const combined = creditRows?.Combined
        const combinedRemaining = combined ? remainingOf(combined) : null
        const noCredits = combinedRemaining !== null && combinedRemaining <= 0
        const rows: WorkBuddyMergedRow[] = [
          ...models.map((model): WorkBuddyMergedRow => ({ kind: "model", model })),
          ...(["Basic", "Gift", "Extra"] as const).flatMap((credit): WorkBuddyMergedRow[] =>
            creditRows?.[credit] ? [{ kind: "credit" as const, credit, window: creditRows[credit]! }] : [],
          ),
        ]
        return { label, combinedRemaining, noCredits, resetAt: creditRows?.Basic?.resetAt ?? null, rows }
      })
      .filter((acct) => acct.rows.length > 0)
      .sort((a, b) => a.label.localeCompare(b.label))
  })

  function modelTag(m: WorkBuddyModelLimit): string | null {
    if (m.exhaustedObserved) return language.t("limits.gate.limiting")
    if (m.accuracy === "server-confirmed" && m.remainingPercent !== null && m.remainingPercent <= 0)
      return language.t("limits.gate.limiting")
    return null
  }

  return (
    <>
      {/* Promotional model windows — per-account-per-model (NOT account-global), 24h only. */}
      <Show when={modelAggregates().length > 0}>
        <div class="flex flex-col divide-y divide-v2-border-border-muted/50 border-t border-v2-border-border-muted/50">
          <For each={modelAggregates()}>
            {(row, index) => (
              <WindowRow
                now={props.now}
                guide={index() === modelAggregates().length - 1 ? "leaf" : "branch"}
                label={row.label}
                tag={
                  <span class="flex items-center gap-1">
                    <Show when={row.anyExhausted}>
                      <StatePill tone="danger">{language.t("limits.gate.limiting")}</StatePill>
                    </Show>
                    <Show when={row.confidence !== "high"}>
                      <span class="text-[7px] font-[600] uppercase tracking-[0.03em] text-v2-text-text-faint opacity-60">
                        ~{row.confidence}
                      </span>
                    </Show>
                  </span>
                }
                remaining={row.remainingPercent}
                valueLabel={
                  row.limitEstimate !== null
                    ? `${row.usedObserved} / ~${row.limitEstimate}`
                    : `${row.usedObserved} observed`
                }
                used={row.remainingPercent !== null ? 100 - row.remainingPercent : null}
                tone={toneForRemaining(row.remainingPercent)}
                resetAt={row.resetAt}
              />
            )}
          </For>
        </div>
      </Show>

      <div class="flex flex-col divide-y divide-v2-border-border-muted/50 border-t border-v2-border-border-muted/50">
        <Show when={aggregateCombined()}>
          {(combined) => {
            const remaining = () => remainingOf(combined())
            const rTone = () => toneForRemaining(remaining())
            return (
              <WindowRow
                now={props.now}
                guide="branch"
                label={kindLabel("combined")}
                tag={
                  <Show when={rTone() === "danger"}>
                    <StatePill tone="danger">{language.t("limits.gate.limiting")}</StatePill>
                  </Show>
                }
                remaining={remaining()}
                valueLabel={combined().valueLabel}
                used={combined().usedPercent}
                tone={rTone()}
                resetAt={combined().resetAt}
                resetAfterSeconds={combined().resetAfterSeconds}
              />
            )
          }}
        </Show>
        <For each={aggregateRows()}>
          {(row, index) => {
            const remaining = remainingOf(row.window)
            const rTone = toneForRemaining(remaining)
            return (
              <WindowRow
                now={props.now}
                guide={index() === aggregateRows().length - 1 ? "leaf" : "branch"}
                label={kindLabel(row.kind)}
                remaining={remaining}
                valueLabel={row.window.valueLabel}
                used={row.window.usedPercent}
                tone={rTone}
                resetAt={row.window.resetAt}
                resetAfterSeconds={row.window.resetAfterSeconds}
                resetMode={row.kind === "basic" ? "countdown" : "date"}
              />
            )
          }}
        </For>
      </div>

      {/*
        ONE "per account" collapsible covering both dimensions — a reader
        expands this once and sees everything about that account (its Hy3/
        Hy4 windows AND its Basic/Gift/Extra packs) instead of expanding two
        separate sections and matching accounts up by name across them.
      */}
      <Show when={mergedAccounts().length > 0}>
        <div class="border-t border-v2-border-border-muted/50">
          <button
            type="button"
            class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[9px] font-[600] uppercase leading-3 tracking-[0.04em] text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover"
            aria-expanded={props.accountsExpanded}
            onClick={() => props.onToggleAccountsExpanded()}
          >
            <Icon
              name="chevron-down"
              size="small"
              class="size-2.5 transition-transform"
              classList={{ "-rotate-90": !props.accountsExpanded }}
            />
            {language.t("limits.workbuddy.perAccount")}
            <span class="font-[440] normal-case tracking-normal">{mergedAccounts().length}</span>
          </button>
          <Show when={props.accountsExpanded}>
            <For each={mergedAccounts()}>
              {(acct) => (
                <div class="flex flex-col">
                  {/*
                    Deliberately NOT a worst-of-all-models percentage or a
                    blanket "LIMITING" tag: unlike package credits, each
                    model's 24h window is fully independent (Hy4 hard-limited
                    says nothing about Hy3 on the same account). The Combined
                    credit balance IS a legitimate account-wide figure though
                    (Basic+Gift+Extra are genuinely additive), so that one
                    drives this header row's percent/tone — and doubles as
                    the "No credits" signal, since that's the same 0% case.
                  */}
                  <WindowRow
                    now={props.now}
                    guide="branch"
                    label={acct.label}
                    remaining={acct.combinedRemaining}
                    tone={acct.noCredits ? "danger" : toneForRemaining(acct.combinedRemaining)}
                    resetAt={acct.resetAt}
                    noMeter
                    tag={
                      <Show when={acct.noCredits}>
                        <TooltipV2 value={language.t("model.tooltip.workbuddy.noCredits")}>
                          <span>
                            <StatePill tone="danger">{language.t("model.tag.noCredits")}</StatePill>
                          </span>
                        </TooltipV2>
                      </Show>
                    }
                  />
                  <For each={acct.rows}>
                    {(row, idx) => {
                      const guide = idx() === acct.rows.length - 1 ? "leaf" : "branch"
                      if (row.kind === "credit") {
                        const remaining = remainingOf(row.window)
                        return (
                          <WindowRow
                            now={props.now}
                            guide={guide}
                            depth={2}
                            label={kindLabel(row.credit)}
                            remaining={remaining}
                            valueLabel={row.window.valueLabel}
                            used={row.window.usedPercent}
                            tone={acct.noCredits ? "danger" : toneForRemaining(remaining)}
                            resetAt={row.window.resetAt}
                            resetAfterSeconds={row.window.resetAfterSeconds}
                            resetMode={row.credit === "Basic" ? "countdown" : "date"}
                          />
                        )
                      }
                      const m = row.model
                      const remaining = m.remainingPercent
                      const rTone = acct.noCredits ? "danger" : toneForRemaining(remaining)
                      const exhausted = m.exhaustedObserved || (remaining !== null && remaining <= 0)
                      return (
                        <WindowRow
                          now={props.now}
                          guide={guide}
                          depth={2}
                          label={workbuddyModelDisplayName(m.model)}
                          tag={
                            <span class="flex items-center gap-1">
                              <Show when={acct.noCredits}>
                                <TooltipV2 value={language.t("model.tooltip.workbuddy.noCredits")}>
                                  <span>
                                    <StatePill tone="danger">{language.t("model.tag.noCredits")}</StatePill>
                                  </span>
                                </TooltipV2>
                              </Show>
                              <Show when={!acct.noCredits && modelTag(m)}>
                                <StatePill tone={exhausted ? "danger" : rTone}>{modelTag(m)}</StatePill>
                              </Show>
                              <Show when={m.burnPerHour !== null}>
                                <span class="text-[7px] font-[560] uppercase tracking-[0.03em] text-v2-text-text-faint opacity-60">
                                  {m.burnPerHour!.toFixed(1)}/h
                                </span>
                              </Show>
                              <Show when={m.accuracy === "server-confirmed"}>
                                <span
                                  class="text-[7px] font-[600] uppercase tracking-[0.03em]"
                                  style={{ color: colorForTone("success") }}
                                >
                                  server
                                </span>
                              </Show>
                            </span>
                          }
                          remaining={remaining}
                          valueLabel={
                            m.limitEstimate !== null
                              ? `${m.usedObserved} / ~${m.limitEstimate}`
                              : `${m.usedObserved} observed`
                          }
                          used={m.remainingPercent !== null ? 100 - m.remainingPercent : null}
                          tone={rTone}
                          resetAt={m.resetAt}
                        />
                      )
                    }}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </>
  )
}

/**
 * Verdent — multi-account free tier (400/5h, ~650/week) with per-model
 * entitlement windows. Mirrors WorkBuddy's aggregate + per-account shape:
 *  - Top `All accounts` aggregate (worst 5h/weekly across every enrolled
 *    account, plus the global `windows` windows)
 *  - Per-account collapsible: each account's own 5h/weekly (worst of its
 *    models) + its model rows, each with a stretch bar.
 */
function VerdentBody(props: {
  windows: [string, UsageWindow][]
  verdentAccounts?: WorkBuddyAccountLimits[]
  verdentFree?: VerdentFreeReport
  now: number
  accountsExpanded: boolean
  onToggleAccountsExpanded: () => void
}) {
  const language = useLanguage()
  const accounts = createMemo(() => props.verdentAccounts ?? [])
  const gate = createMemo(() => resolveTierGate(props.windows))
  const visibleModels = (account: WorkBuddyAccountLimits) =>
    account.models.filter((model) => model.usedObserved > 0 || model.exhaustedObserved)

  // Per-account worst 5h/weekly derived from that account's model reports.
  // The global `props.windows` are the server's `verdentFreeProviderResult`
  // estimate (global), not per-account, so use the account-local model
  // reports (governor) for per-account headroom.
  const accountWorst = (account: WorkBuddyAccountLimits): number | null => {
    const vals = account.models
      .map((m) => m.remainingPercent)
      .filter((v): v is number => v !== null && Number.isFinite(v))
    return vals.length ? Math.min(...vals) : null
  }
  const allAccountsWorst = createMemo(() => {
    const vals = accounts()
      .flatMap((a) => a.models.map((m) => m.remainingPercent))
      .filter((v): v is number => v !== null && Number.isFinite(v))
    if (vals.length) return Math.min(...vals)
    const globalVals = props.windows.map(([, w]) => remainingOf(w)).filter((v): v is number => v !== null)
    return globalVals.length ? Math.min(...globalVals) : null
  })

  return (
    <>
      {/* Aggregate — all accounts */}
      <div class="flex flex-col divide-y divide-v2-border-border-muted/50 border-t border-v2-border-border-muted/50">
        <Show
          when={accounts().length > 1}
          fallback={
            <For each={props.windows}>
              {([key, window], index) => {
                const remaining = remainingOf(window)
                const tone = toneForRemaining(remaining)
                const state = tierGateState(key, remaining, gate())
                const isLast = () => index() === props.windows.length - 1 && !props.verdentFree
                return (
                  <WindowRow
                    now={props.now}
                    guide={isLast() ? "leaf" : "branch"}
                    label={displayWindowLabel(key, language.t)}
                    tag={
                      <Show when={state === "binding"}>
                        <StatePill tone={tone}>{language.t("limits.gate.limiting")}</StatePill>
                      </Show>
                    }
                    remaining={remaining}
                    valueLabel={window.valueLabel}
                    used={window.usedPercent}
                    tone={tone}
                    resetAt={window.resetAt}
                    resetAfterSeconds={window.resetAfterSeconds}
                    dim={state === "gated"}
                  />
                )
              }}
            </For>
          }
        >
          <WindowRow
            now={props.now}
            guide={props.windows.length > 0 ? "branch" : "leaf"}
            label={language.t("limits.verdent.aggregate")}
            remaining={allAccountsWorst()}
            tone={toneForRemaining(allAccountsWorst())}
            resetAt={props.windows[0]?.[1]?.resetAt ?? null}
            valueLabel={accounts().length > 0 ? `${accounts().length} ${language.t("limits.verdent.accounts")}` : null}
          />
          <For each={props.windows}>
            {([key, window], index) => {
              const remaining = remainingOf(window)
              const tone = toneForRemaining(remaining)
              const state = tierGateState(key, remaining, gate())
              const isLast = () => index() === props.windows.length - 1 && !props.verdentFree
              return (
                <WindowRow
                  now={props.now}
                  guide={isLast() ? "leaf" : "branch"}
                  depth={2}
                  label={displayWindowLabel(key, language.t)}
                  tag={
                    <Show when={state === "binding"}>
                      <StatePill tone={tone}>{language.t("limits.gate.limiting")}</StatePill>
                    </Show>
                  }
                  remaining={remaining}
                  valueLabel={window.valueLabel}
                  used={window.usedPercent}
                  tone={tone}
                  resetAt={window.resetAt}
                  resetAfterSeconds={window.resetAfterSeconds}
                  dim={state === "gated"}
                />
              )
            }}
          </For>
        </Show>
        <Show when={props.verdentFree}>
          {(free) => (
            <WindowRow
              now={props.now}
              guide="leaf"
              label={language.t("limits.verdent.free")}
              remaining={Math.round(free().remainingPercent * 10) / 10}
              used={free().usedPercent}
              tone={toneForRemaining(free().remainingPercent)}
              resetAt={verdentFreeResetAt(free())}
            />
          )}
        </Show>
      </div>

      <Show when={accounts().length > 0}>
        <div class="border-t border-v2-border-border-muted/50">
          <button
            type="button"
            class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[9px] font-[600] uppercase leading-3 tracking-[0.04em] text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover"
            aria-expanded={props.accountsExpanded}
            onClick={props.onToggleAccountsExpanded}
          >
            <Icon
              name="chevron-down"
              size="small"
              class="size-2.5 transition-transform"
              classList={{ "-rotate-90": !props.accountsExpanded }}
            />
            {language.t("limits.verdent.perAccount")}
            <span class="font-[440] normal-case tracking-normal">{accounts().length}</span>
          </button>
          <Show when={props.accountsExpanded}>
            <For each={accounts()}>
              {(account) => {
                const models = visibleModels(account)
                const worst = accountWorst(account)
                const worstTone = toneForRemaining(worst)
                const limiting = worst !== null && worst <= 0
                // Per-account 5h/weekly derived from this account's models.
                // WorkBuddy has explicit Basic/Gift/Extra windows per account;
                // Verdent's free tier is 5h/weekly per account. Use the worst
                // model headroom for each window as the account-level signal.
                const hasModels = models.length > 0
                return (
                  <div class="flex flex-col">
                    <WindowRow
                      now={props.now}
                      guide="branch"
                      label={account.label}
                      remaining={worst}
                      tone={worstTone}
                      resetAt={models[0]?.resetAt ?? null}
                      tag={
                        <Show when={limiting}>
                          <StatePill tone="danger">{language.t("limits.gate.limiting")}</StatePill>
                        </Show>
                      }
                    />
                    <WindowRow
                      now={props.now}
                      guide={hasModels ? "branch" : "leaf"}
                      depth={2}
                      label={language.t("limits.window.5h.short")}
                      remaining={worst}
                      tone={worstTone}
                      resetAt={models[0]?.resetAt ?? null}
                    />
                    <WindowRow
                      now={props.now}
                      guide={hasModels ? "branch" : "leaf"}
                      depth={2}
                      label={language.t("limits.window.weekly")}
                      remaining={worst}
                      tone={worstTone}
                      resetAt={models[0]?.resetAt ?? null}
                    />
                    <For each={models}>
                      {(model, index) => {
                        const remaining = model.remainingPercent
                        const modelTone = toneForRemaining(remaining)
                        const isLimiting = model.exhaustedObserved || (remaining !== null && remaining <= 0)
                        return (
                          <WindowRow
                            now={props.now}
                            guide={index() === models.length - 1 ? "leaf" : "branch"}
                            depth={2}
                            label={verdentModelDisplayName(model.model)}
                            tag={
                              <Show when={isLimiting}>
                                <StatePill tone="danger">{language.t("limits.gate.limiting")}</StatePill>
                              </Show>
                            }
                            remaining={remaining}
                            valueLabel={
                              model.limitEstimate !== null
                                ? language.t("limits.verdent.estimated", {
                                    used: model.usedObserved,
                                    limit: model.limitEstimate,
                                    unit: model.unit,
                                  })
                                : language.t("limits.verdent.observed", {
                                    used: model.usedObserved,
                                    unit: model.unit,
                                  })
                            }
                            used={remaining !== null ? 100 - remaining : null}
                            tone={modelTone}
                            resetAt={model.resetAt}
                            resetAfterSeconds={model.secondsUntilReset}
                          />
                        )
                      }}
                    </For>
                    <Show when={models.length === 0}>
                      <WindowRow
                        now={props.now}
                        guide="leaf"
                        depth={2}
                        label={language.t("limits.verdent.noObservedUsage")}
                        remaining={null}
                        tone="muted"
                        resetAt={null}
                        noMeter
                      />
                    </Show>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </Show>
    </>
  )
}

/**
 * OpenCode Zen per-key rows. The aggregate daily window row stays on top —
 * the same local free-tier estimate shown today. Each configured API key
 * renders underneath with its governor state, its reset countdown, and its
 * position in the failover queue: the queue orders used keys by resetAt
 * ascending and holds never-used keys in reserve, exactly how the router
 * rebinds on exhaustion, so "next up" is always the key the router would
 * actually pick. With a single key there is no queue and nothing new to
 * show, so the section only renders for more than one key and the card
 * stays identical to the generic one.
 */
function ZenBody(props: {
  windows: [string, UsageWindow][]
  zenKeys?: ZenKeyLimits[]
  now: number
  keysExpanded: boolean
  onToggleKeysExpanded: () => void
}) {
  const language = useLanguage()
  const keys = createMemo(() => props.zenKeys ?? [])
  const gate = createMemo(() => resolveTierGate(props.windows))
  const queueVisible = () => keys().length > 1
  const sortedKeys = createMemo(() =>
    [...keys()].sort((a, b) => {
      const pa = a.queuePosition
      const pb = b.queuePosition
      if (pa === null && pb !== null) return 1
      if (pa !== null && pb === null) return -1
      if (pa !== null && pb !== null && pa !== pb) return pa - pb
      return a.label.localeCompare(b.label)
    }),
  )

  const stateTag = (key: ZenKeyLimits): JSX.Element | null => {
    if (key.state === "ready") return <StatePill tone="success">{language.t("limits.healthy")}</StatePill>
    if (key.state === "cooling") return <StatePill tone="warning">{language.t("limits.zen.cooling")}</StatePill>
    if (key.state === "exhausted" || key.exhausted)
      return <StatePill tone="danger">{language.t("limits.depleted")}</StatePill>
    return null
  }

  const queueTag = (key: ZenKeyLimits): JSX.Element | null => {
    if (!queueVisible() || key.queuePosition === null) return null
    if (!key.everUsed)
      return (
        <span class="text-[7px] font-[600] uppercase tracking-[0.03em] text-v2-text-text-faint opacity-60">
          {language.t("limits.zen.queue.reserve")}
        </span>
      )
    if (key.queuePosition === 1)
      return (
        <span class="text-[7px] font-[650] uppercase tracking-[0.03em] text-v2-text-text-accent">
          {language.t("limits.zen.queue.next")}
        </span>
      )
    return (
      <span class="text-[7px] font-[600] uppercase tracking-[0.03em] text-v2-text-text-faint opacity-60">
        {language.t("limits.zen.queue.position", { position: key.queuePosition })}
      </span>
    )
  }

  const valueLabel = (key: ZenKeyLimits): string | null => {
    if (key.usedObserved === null) return null
    if (key.limitEstimate !== null)
      return language.t("limits.zen.estimated", { used: key.usedObserved, limit: key.limitEstimate })
    return language.t("limits.zen.observed", { used: key.usedObserved })
  }

  return (
    <>
      <div class="flex flex-col divide-y divide-v2-border-border-muted/50 border-t border-v2-border-border-muted/50">
        <For each={props.windows}>
          {([key, window], index) => {
            const remaining = remainingOf(window)
            const tone = toneForRemaining(remaining)
            const state = tierGateState(key, remaining, gate())
            const isLast = () => index() === props.windows.length - 1 && !queueVisible()
            return (
              <WindowRow
                now={props.now}
                guide={isLast() ? "leaf" : "branch"}
                label={displayWindowLabel(key, language.t)}
                tag={
                  <Show when={state === "binding"}>
                    <StatePill tone={tone}>{language.t("limits.gate.limiting")}</StatePill>
                  </Show>
                }
                remaining={remaining}
                valueLabel={window.valueLabel}
                used={window.usedPercent}
                tone={tone}
                resetAt={window.resetAt}
                resetAfterSeconds={window.resetAfterSeconds}
                dim={state === "gated"}
              />
            )
          }}
        </For>
      </div>

      <Show when={queueVisible()}>
        <div class="border-t border-v2-border-border-muted/50">
          <button
            type="button"
            class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[9px] font-[600] uppercase leading-3 tracking-[0.04em] text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover"
            aria-expanded={props.keysExpanded}
            onClick={props.onToggleKeysExpanded}
          >
            <Icon
              name="chevron-down"
              size="small"
              class="size-2.5 transition-transform"
              classList={{ "-rotate-90": !props.keysExpanded }}
            />
            <TooltipV2 value={language.t("limits.zen.queue.title")}>
              <span class="flex items-center gap-1.5">
                {language.t("limits.zen.perKey")}
                <span class="font-[440] normal-case tracking-normal">{keys().length}</span>
              </span>
            </TooltipV2>
          </button>
          <Show when={props.keysExpanded}>
            <For each={sortedKeys()}>
              {(key, index) => {
                const exhausted = key.state === "exhausted" || key.exhausted
                return (
                  <WindowRow
                    now={props.now}
                    guide={index() === sortedKeys().length - 1 ? "leaf" : "branch"}
                    label={key.label}
                    tag={
                      <span class="flex items-center gap-1">
                        {stateTag(key)}
                        {queueTag(key)}
                      </span>
                    }
                    remaining={key.remainingPercent}
                    valueLabel={valueLabel(key)}
                    used={key.remainingPercent !== null ? 100 - key.remainingPercent : null}
                    tone={exhausted ? "danger" : toneForRemaining(key.remainingPercent)}
                    resetAt={key.resetAt}
                    resetAfterSeconds={key.resetAfterSeconds}
                  />
                )
              }}
            </For>
          </Show>
        </div>
      </Show>
    </>
  )
}

function ProviderGroup(props: {
  provider: LimitProvider
  now: number
  openRouterFree?: FreeUsageReport
  verdentFree?: VerdentFreeReport
  workbuddyAccountsExpanded: boolean
  onToggleWorkbuddyAccountsExpanded: () => void
  verdentAccountsExpanded: boolean
  onToggleVerdentAccountsExpanded: () => void
  zenKeysExpanded: boolean
  onToggleZenKeysExpanded: () => void
}) {
  const language = useLanguage()
  const result = () => props.provider.result
  const windows = () => props.provider.windowsSorted
  const gate = () => props.provider.gate
  const worstRemaining = () => {
    const base = props.provider.worstRemaining
    const wba = (props.provider.result.usage as unknown as { workbuddyAccounts?: WorkBuddyAccountLimits[] })
      ?.workbuddyAccounts
    if (!wba || wba.length === 0) return base
    const promoVals = wba
      .flatMap((a) => a.models.map((m) => m.remainingPercent))
      .filter((v): v is number => v !== null && Number.isFinite(v))
    const promoWorst = promoVals.length ? Math.min(...promoVals) : null
    if (promoWorst === null) return base
    if (base === null) return promoWorst
    return Math.min(base, promoWorst)
  }
  const tone = () => toneForRemaining(worstRemaining())
  const blocked = () => worstRemaining() !== null && worstRemaining()! <= 0
  const hardError = createMemo(() => {
    const usage = result().usage as unknown as {
      workbuddyAccounts?: unknown[]
      verdentAccounts?: unknown[]
      zenAccounts?: unknown[]
    } | null
    return (
      !result().ok &&
      windows().length === 0 &&
      !usage?.workbuddyAccounts?.length &&
      !usage?.verdentAccounts?.length &&
      !usage?.zenAccounts?.length
    )
  })
  const staleError = createMemo(() => !result().ok && !hardError())
  const rowTone = createMemo<Tone>(() => (hardError() ? "danger" : tone()))

  return (
    <div
      data-limits-provider={result().providerId}
      class="overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-base"
    >
      <div class={`grid ${GRID_COLS} items-center gap-2 bg-v2-background-bg-layer-01 px-2.5 py-2`}>
        <ToneDot tone={rowTone()} pulse={blocked()} />
        <div class="flex min-w-0 items-center gap-1.5">
          <ProviderIcon id={result().providerId} class="size-3.5 shrink-0 opacity-85" />
          <span class="min-w-0 truncate text-[11px] font-[650] leading-3 text-v2-text-text-base">
            {result().providerName}
          </span>
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
              <span class="text-v2-text-text-faint">
                {language.t("limits.stale.notice", { age: formatAge(result().fetchedAt, props.now, language.t) })}{" "}
                ·{" "}
              </span>
            </Show>
            {result().error ?? language.t("limits.error")}
          </span>
        </div>
      </Show>

      {/*
        Same dispatch as nested `Show` fallbacks, just flat: workbuddy and
        verdent have dedicated account drill-downs, Zen adds the per-key
        failover queue, and every other provider takes the generic window
        list. Conditions are mutually exclusive on providerId, so order is
        only about which Match wins.
      */}
      <Switch>
        <Match when={result().providerId === "workbuddy"}>
          <WorkBuddyBody
            windows={windows()}
            workbuddyAccounts={result().usage?.workbuddyAccounts}
            now={props.now}
            accountsExpanded={props.workbuddyAccountsExpanded}
            onToggleAccountsExpanded={props.onToggleWorkbuddyAccountsExpanded}
          />
        </Match>
        <Match when={result().providerId === "verdent"}>
          <VerdentBody
            windows={windows()}
            verdentAccounts={result().usage?.verdentAccounts}
            verdentFree={props.verdentFree}
            now={props.now}
            accountsExpanded={props.verdentAccountsExpanded}
            onToggleAccountsExpanded={props.onToggleVerdentAccountsExpanded}
          />
        </Match>
        <Match when={result().providerId === "opencode-zen"}>
          <ZenBody
            windows={windows()}
            zenKeys={result().usage?.zenAccounts}
            now={props.now}
            keysExpanded={props.zenKeysExpanded}
            onToggleKeysExpanded={props.onToggleZenKeysExpanded}
          />
        </Match>
        <Match when={true}>
          <div class="flex flex-col divide-y divide-v2-border-border-muted/50 border-t border-v2-border-border-muted/50 empty:border-t-0">
            <For each={windows()}>
              {([key, w], index) => {
                const remaining = remainingOf(w)
                const rTone = toneForRemaining(remaining)
                const state = tierGateState(key, remaining, gate())
                const isLast = () => index() === windows().length - 1 && !props.openRouterFree && !props.verdentFree
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
                guide={props.verdentFree ? "branch" : "leaf"}
                label={language.t("openrouter.free.title")}
                remaining={Math.round(props.openRouterFree!.free.remainingPercent * 10) / 10}
                used={100 - props.openRouterFree!.free.remainingPercent}
                tone={toneForRemaining(props.openRouterFree!.free.remainingPercent)}
                resetAt={openRouterFreeResetAt(props.openRouterFree!)}
              />
            </Show>
            {/* Verdent free — local daily estimator (providerId verdent, *-free models). */}
            <Show when={!!props.verdentFree}>
              <WindowRow
                now={props.now}
                guide="leaf"
                label={language.t("limits.verdent.free")}
                remaining={Math.round(props.verdentFree!.remainingPercent * 10) / 10}
                used={props.verdentFree!.usedPercent}
                tone={toneForRemaining(props.verdentFree!.remainingPercent)}
                resetAt={verdentFreeResetAt(props.verdentFree!)}
              />
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  )
}

// Verdent free — standalone card when the provider has no server quota entry
// (verdent is not in Quota.adapters). Mirrors the Zen card shape.
function VerdentFreeGroup(props: { report: VerdentFreeReport; now: number }) {
  const language = useLanguage()
  const tone = () => toneForRemaining(props.report.remainingPercent)
  const blocked = () => props.report.remainingPercent <= 0
  return (
    <div
      data-limits-provider="verdent"
      class="overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-base"
    >
      <div class={`grid ${GRID_COLS} items-center gap-2 bg-v2-background-bg-layer-01 px-2.5 py-2`}>
        <ToneDot tone={tone()} pulse={blocked()} />
        <div class="flex min-w-0 items-center gap-1.5">
          <ProviderIcon id="verdent" class="size-3.5 shrink-0 opacity-85" />
          <span class="min-w-0 truncate text-[11px] font-[650] leading-3 text-v2-text-text-base">
            {language.t("limits.verdent.name")}
          </span>
          <span class="hidden shrink-0 truncate text-[8px] font-[560] uppercase leading-none tracking-[0.03em] text-v2-text-text-faint sm:inline">
            {language.t("limits.verdent.requests", {
              used: props.report.used,
              limit: props.report.limit,
            })}
          </span>
          <Show when={blocked()}>
            <StatePill tone="danger">{language.t("limits.gate.limiting")}</StatePill>
          </Show>
        </div>
        <span />
        <span />
        <span />
        <span />
      </div>
      <div class="flex flex-col divide-y divide-v2-border-border-muted/50 border-t border-v2-border-border-muted/50">
        <WindowRow
          now={props.now}
          guide="leaf"
          label={language.t("limits.verdent.free")}
          remaining={Math.round(props.report.remainingPercent * 10) / 10}
          used={props.report.usedPercent}
          tone={tone()}
          resetAt={verdentFreeResetAt(props.report)}
        />
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
  const aggregateGate = createMemo<TierGate>(() =>
    resolveTierGate(aggregateWindows().map(({ key, mapped }) => [key, mapped])),
  )
  const aggregateRemaining = () => aggregateGate().effectiveRemaining
  const aggregateTone = () => toneForRemaining(aggregateRemaining())
  const keyCount = () => Math.max(props.credentials.length, props.byCredential.length)

  return (
    <div
      data-limits-provider="opencode-go"
      class="overflow-hidden rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-base"
    >
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
                  <StatePill tone={toneForRemaining(mapped.remainingPercent)}>
                    {language.t("limits.gate.limiting")}
                  </StatePill>
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
            <Icon
              name="chevron-down"
              size="small"
              class="size-2.5 transition-transform"
              classList={{ "-rotate-90": !props.keysExpanded }}
            />
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

/**
 * Deterministic string -> number order key (FNV-1a-ish). Two providers
 * always land in the same relative order across renders, polls, and
 * sessions — unlike sorting by a live number (worst-remaining%), which
 * reorders the whole list every time any provider's usage ticks, which in
 * turn breaks keyed `<For>` identity for every card below the one that
 * moved (see `WorkBuddyBody`'s comment on why that resets open/closed UI
 * state). Not cryptographic; just needs to be stable and well-mixed.
 */
function stableOrderKey(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

type Entry =
  | { key: string; sort: number; kind: "provider"; provider: LimitProvider }
  | { key: string; sort: number; kind: "go" }
  | { key: string; sort: number; kind: "verdent-free" }

export function LimitsPanelContent(props: { active?: Accessor<boolean> }) {
  const language = useLanguage()
  const now = useNow(() => props.active?.() ?? true)
  const {
    providers,
    goAggregate,
    goByCredential,
    goCredentials,
    openRouterFree,
    isLoading,
    hasError,
    error,
    refresh,
    isCoolingDown,
    cooldownRemainingMs,
  } = useLimits({ now })
  // Verdent free — client-side only (no server quota adapter). Count today's
  // verdent/*-free assistant messages from synced history; see utils/verdent-free-usage.ts.
  const verdentFreeHook = useVerdentFreeUsage({ now })

  const showGoAggregate = createMemo(() => goAggregate().length > 0 || goByCredential().length > 0)

  // Fixed order: OpenCode Zen (the only automatic/IP-based free quota) pinned
  // first so it's visible without scrolling, everything else ordered by a
  // deterministic hash of its id — NOT by live worst-remaining%, which used
  // to reshuffle the whole list on every usage tick (see `stableOrderKey`).
  const entries = createMemo<Entry[]>(() => {
    const list = providers()
    if (!list) return []
    const items: Entry[] = list
      .filter((p) => p.result.providerId !== "opencode-go")
      .map((p) => ({
        key: `p:${p.result.providerId}`,
        sort: p.result.providerId === "opencode-zen" ? -1 : stableOrderKey(p.result.providerId),
        kind: "provider" as const,
        provider: p,
      }))
    if (showGoAggregate()) {
      items.push({ key: "go", sort: stableOrderKey("opencode-go"), kind: "go" as const })
    }
    // Verdent free — synthetic entry when the provider has no server quota row.
    // If a real `verdent` provider row appears later this becomes a no-op
    // (the in-card WindowRow above handles that case instead).
    const hasVerdentProvider = list.some((p) => p.result.providerId === "verdent")
    const vf = verdentFreeHook.data()
    if (vf && !hasVerdentProvider) {
      items.push({ key: "p:verdent-free", sort: stableOrderKey("verdent"), kind: "verdent-free" as const })
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
      // WorkBuddy promo 24h per-model windows live outside windowsSorted — fold them into
      // "weekly" (the closest real-world cadence to a daily reset) so the global bar reflects
      // their pressure. Weighted 0.8 so they matter but don't swamp the real weekly windows.
      const wba = (p.result.usage as unknown as { workbuddyAccounts?: WorkBuddyAccountLimits[] })?.workbuddyAccounts
      if (wba) {
        for (const acct of wba) {
          for (const m of acct.models) {
            accumulateBucket(acc["weekly"], m.remainingPercent, 0.8, m.resetAt)
          }
        }
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
    // Verdent free — daily UTC window, contributes to weekly at 0.8 weight
    // (mirrors WorkBuddy promo daily windows).
    const vf2 = verdentFreeHook.data()
    if (vf2) {
      accumulateBucket(acc["weekly"], vf2.remainingPercent, 0.8, verdentFreeResetAt(vf2))
    }
    return acc
  })

  const globalBucketList = createMemo(() => {
    const acc = globalBuckets()
    return (["5h", "weekly", "monthly"] as const)
      .map((bucket) => {
        const b = acc[bucket]
        const remaining = b.weight > 0 ? b.weightedSum / b.weight : null
        return {
          bucket,
          remaining,
          tone: toneForRemaining(remaining),
          minResetAt: b.minResetAt,
          maxResetAt: b.maxResetAt,
        }
      })
      .filter((b) => b.remaining !== null)
  })

  /**
   * Honour a "show me this provider" request from the composer's limit arc.
   *
   * The arc opens this pane already knowing which provider the user cares
   * about, so landing them at the top of an eight-card list would throw that
   * information away. Retried on a short schedule because the request usually
   * arrives in the same tick that opens the pane, before the card it names has
   * mounted (and, for a cold pane, before the provider has finished its first
   * poll). The highlight is a WAAPI flash rather than a class so it needs no
   * extra state on the card and cannot get stuck on.
   */
  let scrollRoot: HTMLDivElement | undefined
  createEffect(
    on(limitsFocusRequest, (request) => {
      if (!request) return
      let attempts = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const attempt = () => {
        const root = scrollRoot
        const target = root?.querySelector(`[data-limits-provider="${CSS.escape(request.providerId)}"]`)
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ block: "nearest", behavior: "smooth" })
          target.animate(
            [
              { boxShadow: "0 0 0 0 color-mix(in srgb, var(--v2-text-text-accent) 55%, transparent)" },
              { boxShadow: "0 0 0 3px color-mix(in srgb, var(--v2-text-text-accent) 30%, transparent)" },
              { boxShadow: "0 0 0 0 color-mix(in srgb, var(--v2-text-text-accent) 0%, transparent)" },
            ],
            { duration: 1200, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
          )
          return
        }
        if (++attempts > 20) return
        timer = setTimeout(attempt, 120)
      }
      attempt()
      onCleanup(() => {
        if (timer) clearTimeout(timer)
        attempts = Number.MAX_SAFE_INTEGER
      })
    }),
  )

  const [goKeysExpanded, setGoKeysExpanded] = createSignal(true)
  // Lifted above the `<For each={entries()}>` list — see WorkBuddyBody's prop
  // doc for why local state inside a keyed-list child doesn't survive a poll.
  const [workbuddyAccountsExpanded, setWorkbuddyAccountsExpanded] = createSignal(false)
  const [verdentAccountsExpanded, setVerdentAccountsExpanded] = createSignal(false)
  // Zen per-key queue is the whole point of the section — default it open.
  const [zenKeysExpanded, setZenKeysExpanded] = createSignal(true)

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
          <TooltipV2
            value={isCoolingDown() ? `${Math.ceil(cooldownRemainingMs() / 1000)}s` : language.t("limits.refresh")}
          >
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
                    <span class="text-[10px] font-[560] leading-none tabular-nums">
                      {Math.ceil(cooldownRemainingMs() / 1000)}
                    </span>
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
            fallback={
              <span class="text-[10px] font-[480] text-v2-text-text-faint">{language.t("limits.allHealthy")}</span>
            }
          >
            <For each={globalBucketList()}>
              {(bucket) => (
                <div class="flex items-center gap-2">
                  <span class="w-12 shrink-0 truncate text-[9.5px] font-[650] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
                    {displayWindowLabel(bucket.bucket, language.t)}
                  </span>
                  <DrainMeter remaining={bucket.remaining} tone={bucket.tone} dense />
                  <span
                    class="w-10 shrink-0 text-right text-[10.5px] font-[750] leading-none tabular-nums"
                    style={{ color: colorForTone(bucket.tone) }}
                  >
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
        <div ref={scrollRoot} class="flex flex-col gap-2 p-2.5">
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
              <div
                class={`grid ${GRID_COLS} items-center gap-2 px-2.5 pb-1 text-[8px] font-[650] uppercase leading-none tracking-[0.06em] text-v2-text-text-faint`}
              >
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
                  if (entry.kind === "verdent-free") {
                    const vf3 = verdentFreeHook.data()
                    return vf3 ? <VerdentFreeGroup report={vf3} now={now()} /> : null
                  }
                  // entry.kind === "provider" here — narrow for TS
                  const provEntry = entry as Extract<Entry, { kind: "provider" }>
                  return (
                    <ProviderGroup
                      provider={provEntry.provider}
                      now={now()}
                      openRouterFree={
                        provEntry.provider.result.providerId === "openrouter" ? openRouterFree() : undefined
                      }
                      verdentFree={
                        provEntry.provider.result.providerId === "verdent" ? verdentFreeHook.data() : undefined
                      }
                      workbuddyAccountsExpanded={workbuddyAccountsExpanded()}
                      onToggleWorkbuddyAccountsExpanded={() => setWorkbuddyAccountsExpanded((v) => !v)}
                      verdentAccountsExpanded={verdentAccountsExpanded()}
                      onToggleVerdentAccountsExpanded={() => setVerdentAccountsExpanded((v) => !v)}
                      zenKeysExpanded={zenKeysExpanded()}
                      onToggleZenKeysExpanded={() => setZenKeysExpanded((v) => !v)}
                    />
                  )
                }}
              </For>
              <div class="px-1 pt-1 text-[9px] font-[440] leading-3 text-v2-text-text-faint">
                {language.t("limits.updatedAgo", {
                  age: formatAge(providers()?.[0]?.result?.fetchedAt ?? Date.now(), now(), language.t),
                })}
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
