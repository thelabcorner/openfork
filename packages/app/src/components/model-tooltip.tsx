import { createEffect, createMemo, For, Show, type Component, type ComponentProps, type JSX } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { toneForRemaining } from "@/utils/limits-format"
import { useLanguage } from "@/context/language"
import { DEEPSEEK_PEAK_RATES, deepSeekRatePeriod, isDeepSeekPeakPricedModel, type DeepSeekRate } from "@/utils/model-peak-pricing"
import { stripUnlimitedSuffix, hasPublishedPricing } from "@/utils/model-badges"
import { evaluateGeneralUsageYield } from "@/utils/model-general-yield"
import { capacityWindowRange } from "@/utils/model-capacity-window-range"
import {
  CAPACITY_DASH,
  capacityPercentOnly,
  formatRequestCount,
  formatRequestPointEstimate,
  formatRequestRange,
  formatRemainingPercent,
  resolveCapacitySection,
  type CapacitySectionView,
  type CapacityWindowView,
} from "./model-tooltip-capacity"
import { usePersonalUsage } from "@/context/personal-usage"
import { formatTokens } from "./usage/usage-format"
import type { CapacityWindow, GeneralUsageView } from "@/context/fork-usage"
import { splitModelIDForProvider } from "@/utils/model-account-identity"
import type { ForkCapacityPredictiveRange } from "@/utils/fork-client"
import "./model-inspector.css"

type InputKey = "text" | "image" | "audio" | "video" | "pdf"
type InputMap = Record<InputKey, boolean>

type ModelInfo = {
  id: string
  name: string
  provider: {
    id?: string
    name: string
  }
  capabilities?: {
    reasoning: boolean
    input: InputMap
  }
  modalities?: {
    input: Array<string>
  }
  reasoning?: boolean
  limit: {
    context: number
  }
  cost?: {
    input: number
    output: number
    cache: { read: number; write: number }
  }
}

/**
 * Account-qualified ids are a transport contract for WorkBuddy.
 * Parse only its known suffix so model ids containing unrelated `@` remain
 * untouched.
 */
export function parseModelAccount(modelID: string, providerID?: string): string | undefined {
  if (providerID !== "workbuddy") return undefined
  return splitModelIDForProvider(modelID, providerID).accountID
}

/**
 * Marks a figure that was computed from borrowed pricing.
 *
 * `inferred` mirrors `resolveEffectiveCost(...).borrowed`: it is true precisely
 * when THIS provider published no price for this model and the picker
 * substituted a sibling provider's rate so the row could still sort and show a
 * number. That rate stays - it is a real observation about the same model
 * family, and an estimate beats a dash - but it is an estimate, so every figure
 * derived from it carries the same "~" the model rows already use instead of
 * reading as published truth. Direct published pricing passes through unmarked.
 *
 * A dollars/credits formatter cannot know whether its input was published, so
 * the marker is applied here, where the provenance is actually known, rather
 * than re-derived per figure or left to each call site's memory.
 */
export function qualifyInferred(text: string, inferred?: boolean): string {
  return inferred ? `~${text}` : text
}

// cost.* is already expressed in $ per 1M tokens - format directly.
//
// Fixed 2-decimal formatting silently rounds real, nonzero rates like
// cached-read pricing ($0.003625/M is common — see OpenCode Go's published
// per-model table) down to "$0.00", which reads as free when it isn't.
// Grow precision only when 2 decimals would hide the value, capped so a
// truly free ($0) rate still prints as a plain "$0.00".
export function formatCostPerMillion(value: number): string {
  if (value === 0) return costFormatter(2).format(0)
  let decimals = 2
  while (decimals < 8 && Number(value.toFixed(decimals)) === 0) decimals++
  return costFormatter(decimals).format(value)
}

// Same $/1M rate scaled up 1000x — the same precision problem can in theory
// still occur (a rate cheap enough to vanish at 2 decimals even *1000 is rare
// but not impossible), so this reuses the same growing-precision formatter
// rather than assuming 2 decimals are always enough once scaled.
const formatCostPerBillion = (value: number) => formatCostPerMillion(value * 1000)

const CREDITS_PER_DOLLAR = 7500 / 20

export function formatCreditsPerMillion(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—"
  const credits = value * CREDITS_PER_DOLLAR
  let decimals = credits < 10 ? 2 : credits < 100 ? 1 : 0
  while (decimals < 4 && Number(credits.toFixed(decimals)) === 0) decimals++
  return `${credits.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} credits/M`
}
const formatCreditsPerBillion = (value: number) => formatCreditsPerMillion(value * 1000)

const costFormatterCache = new Map<number, Intl.NumberFormat>()
function costFormatter(decimals: number): Intl.NumberFormat {
  let formatter = costFormatterCache.get(decimals)
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
    costFormatterCache.set(decimals, formatter)
  }
  return formatter
}

// Inspector primitives. Presentation lives in model-inspector.css, in the same
// visual language as the Session preview card: hairline-ruled sections with a
// 26px uppercase head, 19px key/value rows on one baseline, tabular figures.
// Color only ever encodes state (headroom, current rate period).

type Tone = "success" | "warning" | "danger" | "muted"

function InspectorSection(props: {
  title: string
  icon?: ComponentProps<typeof IconV2>["name"]
  hint?: string
  aside?: JSX.Element
  asideTitle?: string
  children: JSX.Element
}) {
  return (
    <div data-slot="section">
      <div data-slot="section-head" title={props.hint}>
        <Show when={props.icon}>{(icon) => <IconV2 name={icon()} size="small" class="size-3 shrink-0" />}</Show>
        <span data-slot="section-label">{props.title}</span>
        <Show when={props.aside}>
          <span data-slot="section-aside" title={props.asideTitle}>
            {props.aside}
          </span>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

function InspectorRow(props: {
  name: JSX.Element
  value: JSX.Element
  /** Subordinate row (indented, quieter) qualifying the row above it. */
  sub?: boolean
  title?: string
  tone?: Tone
}) {
  return (
    <div data-slot="kv" data-sub={props.sub || undefined} title={props.title}>
      <span data-slot="kv-label">{props.name}</span>
      <span data-slot="kv-value" data-tone={props.tone === "muted" ? undefined : props.tone}>
        {props.value}
      </span>
    </div>
  )
}

/** 28x3 headroom meter; `fraction` is clamped to 0..1. */
function InspectorMeter(props: { fraction: number; tone?: Tone }) {
  return (
    <span data-slot="meter" data-tone={props.tone === "muted" ? undefined : props.tone} aria-hidden="true">
      <span style={{ width: `${Math.max(4, Math.min(100, props.fraction * 100))}%` }} />
    </span>
  )
}

const contextLoadTone = (load: number): Tone => (load > 1 ? "danger" : load >= 0.7 ? "warning" : "muted")

/**
 * One window: the full-window TOTAL capacity as the headline, with the
 * requests still left in that same window as a subordinate row beneath it.
 * The two are labelled apart on purpose — a remainder is not a capacity, and a
 * capacity is not a remainder. When the owner published the share left but no
 * count, the share takes that same subordinate row on its own rather than
 * leaving the window blank.
 */
function InspectorCapacityWindow(props: { view: CapacityWindowView; inferred?: boolean }) {
  const language = useLanguage()
  const fiveHour = () => props.view.kind === "5h"
  const titleLabel = () =>
    fiveHour() ? language.t("model.tooltip.capacity.fiveHour") : language.t("model.tooltip.capacity.week")
  const leftLabel = () =>
    fiveHour() ? language.t("model.tooltip.capacity.fiveHourLeft") : language.t("model.tooltip.capacity.weekLeft")
  const percent = () => props.view.remainingPercent
  // Only the *band* is repriced through this model. The server's own window
  // point totals stay authoritative, so an inferred price qualifies the spread
  // we derived, never the anchor it was derived from.
  const inferredHint = () => (props.inferred ? language.t("model.tooltip.pricing.inferredHint") : undefined)
  // The owner can publish the share left without a count, and the count is what
  // fails closed. Draw that share as its own dense row instead of leaving this
  // window blank — the percentage is a measurement, and inventing a request
  // count to sit next to it would not be.
  const percentOnly = () => capacityPercentOnly(props.view)
  return (
    <>
      <Show when={props.view.total}>
        {(total) => (
          <InspectorRow
            name={titleLabel()}
            title={inferredHint()}
            value={
              <>
                <span>
                  {qualifyInferred(
                    `${formatRequestCount(total().lower, language.intl())}-${formatRequestCount(total().upper, language.intl())}`,
                    props.inferred,
                  )}
                </span>
                {/* The band is the answer; the point estimate only qualifies it. */}
                <span data-slot="dim">~{formatRequestPointEstimate(total(), language.intl())}</span>
              </>
            }
          />
        )}
      </Show>
      <Show when={props.view.remaining}>
        {(range) => (
          <InspectorRow
            sub={!!props.view.total}
            name={leftLabel()}
            title={percent() !== undefined ? `${Math.round(percent()!)}%` : undefined}
            value={
              <>
                <Show when={percent() !== undefined}>
                  <InspectorMeter fraction={percent()! / 100} tone={toneForRemaining(percent()!) as Tone} />
                </Show>
                <span>~{formatRequestRange(range(), language.intl())}</span>
              </>
            }
          />
        )}
      </Show>
      <Show when={percentOnly()}>
        {(share) => (
          <InspectorRow
            sub={!!props.view.total}
            name={leftLabel()}
            value={
              <>
                <InspectorMeter fraction={share() / 100} tone={toneForRemaining(share()) as Tone} />
                <span>{formatRemainingPercent(share(), language.intl())}</span>
              </>
            }
          />
        )}
      </Show>
    </>
  )
}

// A 3-row grid (label + 2 figure columns) rather than a row per dimension —
// showing both units (1M/1B) AND both DeepSeek rate periods would be 4 numbers
// per metric. Each model gets ONE extra dimension: peak/off-peak for the two
// DeepSeek models that have it (the current period is highlighted), 1M/1B for
// everyone else.
function InspectorCostTable(props: {
  model: ModelInfo
  cost: NonNullable<ModelInfo["cost"]>
  period?: ReturnType<typeof deepSeekRatePeriod>
  /** The cost was borrowed from a sibling provider; mark every figure. */
  inferred?: boolean
}) {
  const language = useLanguage()
  const peakRates = () =>
    isDeepSeekPeakPricedModel({ id: props.model.id, provider: { id: props.model.provider.id ?? "" } })
      ? DEEPSEEK_PEAK_RATES[props.model.id]
      : undefined
  const currentPeriod = () => props.period ?? deepSeekRatePeriod(new Date())
  const isGenspark = () => props.model.provider.id === "genspark"
  const perMillion = (value: number) => (isGenspark() ? formatCreditsPerMillion(value) : formatCostPerMillion(value))
  const perBillion = (value: number) => (isGenspark() ? formatCreditsPerBillion(value) : formatCostPerBillion(value))
  const labels = () => [
    language.t("model.tooltip.cost.input"),
    language.t("model.tooltip.cost.cached"),
    language.t("model.tooltip.cost.output"),
  ]

  return (
    <Show
      when={peakRates()}
      fallback={
        <div data-slot="table">
          <span />
          <span data-col="head">{language.t("model.tooltip.cost.perMillion")}</span>
          <span data-col="head">{language.t("model.tooltip.cost.perBillion")}</span>
          <For each={[props.cost.input, props.cost.cache?.read ?? 0, props.cost.output]}>
            {(value, index) => (
              <>
                <span data-col="label">{labels()[index()]}</span>
                <span data-col="figure">{qualifyInferred(perMillion(value), props.inferred)}</span>
                <span data-col="figure" data-dim>
                  {qualifyInferred(perBillion(value), props.inferred)}
                </span>
              </>
            )}
          </For>
        </div>
      }
    >
      {(rates) => {
        const offPeak = () => currentPeriod() === "off-peak"
        const pick = (rate: DeepSeekRate, index: number) =>
          index === 0 ? rate.input : index === 1 ? rate.cacheRead : rate.output
        return (
          <div data-slot="table">
            <span />
            <span data-col="head" data-current={offPeak() || undefined}>
              {language.t("model.tag.offpeak")}
            </span>
            <span data-col="head" data-current={!offPeak() || undefined}>
              {language.t("model.tag.peak")}
            </span>
            <For each={[0, 1, 2]}>
              {(index) => (
                <>
                  <span data-col="label">{labels()[index]}</span>
                  <span data-col="figure" data-current={offPeak() || undefined} data-dim={!offPeak() || undefined}>
                    {formatCostPerMillion(pick(rates()["off-peak"], index))}
                  </span>
                  <span data-col="figure" data-current={!offPeak() || undefined} data-dim={offPeak() || undefined}>
                    {formatCostPerMillion(pick(rates().peak, index))}
                  </span>
                </>
              )}
            </For>
          </div>
        )
      }}
    </Show>
  )
}

/**
 * The one and only durable personal-usage binding in this file.
 *
 * Keeping `usePersonalUsage()` and `.ensure()` inside a single helper — called
 * from exactly one place, on the `!props.v2` arm of a ternary — is what makes
 * the "V2 hover never touches the durable store" invariant provable by reading
 * the source instead of by trusting brace nesting. Do not inline either call.
 */
function legacyPersonalUsage(): ReturnType<typeof usePersonalUsage> | undefined {
  try {
    const personal = usePersonalUsage()
    createEffect(() => {
      void personal?.ensure()
    })
    return personal
  } catch {
    return undefined
  }
}

export const ModelTooltip: Component<{
  model: ModelInfo
  latest?: boolean
  free?: boolean
  unlimited?: boolean
  v2?: boolean
  /** V2 only: fill the host width instead of the floating card width (submenu header). */
  embedded?: boolean
  thresholdPricing?: Array<{
    thresholdTokens: number
    operator: "<=" | ">"
    cost: { input: number; output: number; cache: { read: number; write: number } }
  }>
  usage?: {
    percent?: number
    general?: GeneralUsageView
    estimatedRequests?: number
    personalized?: boolean
    predictiveRange?: ForkCapacityPredictiveRange
    capacityStatus?: "ready" | "learning" | "unavailable" | "unlimited"
    capacityReason?: string
    /**
     * Additive full-window capacity per published window, carried straight off
     * the server projection. The inspector draws the headline range from these
     * point totals repriced through the user's own workload; when they are absent
     * it falls back to the single 5-hour remaining estimate.
     */
    capacityWindows?: CapacityWindow[]
    /** WorkBuddy-only credit/request breakdown, rendered in place of the USD-window rows. */
    workbuddy?: {
      rate: number
      free: boolean
      account: string
      remainingCredits: number
      totalCredits?: number
      estimatedRequests: number
      /** True when `rate` was measured from real usage, not the catalog. */
      personalized?: boolean
    }
    genspark?: {
      /**
       * Undefined when Genspark published no price for this model and none was
       * observed. The inspector prints "—" rather than inventing a rate.
       */
      rateCreditsPerM?: number
      remainingCredits: number
    }
  }
  period?: ReturnType<typeof deepSeekRatePeriod>
  /** Optional explicit hit rate 0-1 (or 0-100) for this provider+model. When provided it overrides personal/openrouter lookup. */
  hitRate?: number
  /**
   * `true` when `model.cost` was substituted from the shared cross-provider /
   * name-match pricing fallback because this provider published none, i.e.
   * `resolveEffectiveCost(...).borrowed`. The borrowed rate is still the price
   * shown, but every figure derived from it is marked `~` and carries this
   * explanation, so provenance survives the hop into this card instead of being
   * lost the moment the substituted cost is copied onto the model.
   */
  pricingInferred?: boolean
}> = (props) => {
  const language = useLanguage()
  const providerLabel = (model: ModelInfo) => {
    if (model.provider.id === "claude") return language.t("model.provider.claudeSubscription")
    if (model.provider.id === "claude-api") return language.t("model.provider.claudeApiKey")
    return model.provider.name
  }
  const sourceName = (model: ModelInfo) => {
    const value = `${model.id} ${model.name}`.toLowerCase()

    if (model.provider.id === "claude" || model.provider.id === "claude-api") return providerLabel(model)
    if (/claude|anthropic/.test(value)) return language.t("model.provider.anthropic")
    if (/gpt|o[1-4]|codex|openai/.test(value)) return language.t("model.provider.openai")
    if (/gemini|palm|bard|google/.test(value)) return language.t("model.provider.google")
    if (/grok|xai/.test(value)) return language.t("model.provider.xai")
    if (/llama|meta/.test(value)) return language.t("model.provider.meta")

    return providerLabel(model)
  }
  const inputLabel = (value: string) => {
    if (value === "text") return language.t("model.input.text")
    if (value === "image") return language.t("model.input.image")
    if (value === "audio") return language.t("model.input.audio")
    if (value === "video") return language.t("model.input.video")
    if (value === "pdf") return language.t("model.input.pdf")
    return value
  }
  const title = () => {
    const tags: Array<string> = []
    if (props.latest) tags.push(language.t("model.tag.latest"))
    if (props.unlimited) tags.push(language.t("model.tag.unlimited"))
    if (props.free) tags.push(language.t("model.tag.free"))
    const suffix = tags.length ? ` (${tags.join(", ")})` : ""
    return `${sourceName(props.model)} ${stripUnlimitedSuffix(props.model.name)}${suffix}`
  }
  const name = () => {
    const tags: Array<string> = []
    if (props.latest) tags.push(language.t("model.tag.latest"))
    if (props.unlimited) tags.push(language.t("model.tag.unlimited"))
    if (props.free) tags.push(language.t("model.tag.free"))
    const suffix = tags.length ? ` (${tags.join(", ")})` : ""
    return `${stripUnlimitedSuffix(props.model.name)}${suffix}`
  }
  const inputs = () => {
    if (props.model.capabilities) {
      const input = props.model.capabilities.input
      const order: Array<InputKey> = ["text", "image", "audio", "video", "pdf"]
      const entries = order.filter((key) => input[key]).map((key) => inputLabel(key))
      return entries.length ? entries.join(", ") : undefined
    }
    const raw = props.model.modalities?.input
    if (!raw) return
    const entries = raw.map((value) => inputLabel(value))
    return entries.length ? entries.join(", ") : undefined
  }
  const reasoning = () => {
    if (props.model.capabilities)
      return props.model.capabilities.reasoning
        ? language.t("model.tooltip.reasoning.allowed")
        : language.t("model.tooltip.reasoning.none")
    return props.model.reasoning
      ? language.t("model.tooltip.reasoning.allowed")
      : language.t("model.tooltip.reasoning.none")
  }
  const context = () => language.t("model.tooltip.context", { limit: props.model.limit.context.toLocaleString() })
  const contextLimit = () => props.model.limit.context.toLocaleString(language.intl())
  const account = () => parseModelAccount(props.model.id, props.model.provider.id)
  // One provenance answer for the whole card. Inferred pricing stays on screen -
  // it is a usable estimate for an unpriced model, including Genspark - but every
  // figure it produces is marked, so it can never read as published pricing.
  const pricingInferred = () => props.pricingInferred === true
  const inferredHint = () => (pricingInferred() ? language.t("model.tooltip.pricing.inferredHint") : undefined)
  const generalUsageSource = (source?: GeneralUsageView["source"]) => {
    if (source === "personal-model") return language.t("model.tooltip.generalUsage.source.personalModel")
    if (source === "personal-general") return language.t("model.tooltip.generalUsage.source.personalGeneral")
    return language.t("model.tooltip.generalUsage.source.standard")
  }

  // Request capacity is the one number in this tooltip that can change a
  // decision, so it leads the inspector.
  //
  // The band is NOT the server's predictive range. That range is a 5h
  // remaining/stopping-time calibration and the server deliberately omits it
  // from window totals, so the visible spread is derived here: price the
  // representative request corpus through THIS model once, and let the ratio
  // between the user's center workload and the corpus center rescale each
  // window's published total point. `capacityWindowRange` owns that arithmetic.
  //
  // Resolved once per usage object in O(samples) from data already materialized
  // on the shared projection — no row-local fetch, no history scan.
  const capacity = createMemo<CapacitySectionView>(() => {
    const usage = props.usage
    if (!usage || usage.workbuddy || usage.genspark) return { windows: [], hasCapacity: false }
    const general = usage.general
    const windows = usage.capacityWindows ?? []
    const cost = props.model.cost
    const band =
      cost && hasPublishedPricing(cost) && general && windows.length > 0
        ? capacityWindowRange({
            model: { id: props.model.id, provider: { id: props.model.provider.id ?? "unknown" } },
            cost,
            contextLimit: props.model.limit.context,
            thresholdPricing: props.thresholdPricing,
            center: general.workload,
            corpus: general.corpus,
            windows: windows.map((window) => ({
              window: window.id,
              pointRequests: window.pointRequests ?? Number.NaN,
              ...(window.remaining?.remainingRequests != null
                ? { remainingRequests: window.remaining.remainingRequests }
                : {}),
            })),
          })
        : undefined
    return resolveCapacitySection({
      windows,
      bands: band?.usable ? band.bands : undefined,
      ...(band ? { bandSamples: band.samples } : {}),
      estimatedRequests: usage.estimatedRequests,
      predictiveRange: usage.predictiveRange,
      status: usage.capacityStatus,
    })
  })

  // Cache hit rate comes from the durable personal store when the caller does
  // not have a provider-specific number. This is the only remaining consumer of
  // the personal usage context here; the standardized corpus yield that used to
  // sit next to it was a population benchmark, not a measurement of this user,
  // and it crowded out the capacity block it duplicated.
  //
  // The pooled V2 inspector is already fed materialized usage data by the
  // selector, so it must never bind or ensure the durable store on hover. That
  // invariant is structural rather than a matter of braces: the only two
  // references to the context in this file live inside `legacyPersonalUsage`,
  // and its sole call site is the `!props.v2` arm of one ternary.
  const personalForCtx = props.v2 ? undefined : legacyPersonalUsage()
  const hitRateForTooltip = createMemo(() => {
    const directDurable = personalForCtx?.getHitRate(props.model.provider.id ?? "unknown", props.model.id)
    if (directDurable !== undefined) return directDurable
    // Cross-provider fallback from durable store
    if (personalForCtx) {
      const all = personalForCtx.hitRates()
      if (all.size > 0) {
        let sum = 0
        let cnt = 0
        for (const [k, v] of all.entries()) {
          if (k.endsWith(`:${props.model.id}`)) {
            sum += v
            cnt++
          }
        }
        if (cnt > 0) return sum / cnt
      }
    }
    return undefined
  })

  /**
   * Generalized yield: what THIS model would cost for the workload the user
   * actually sends.
   *
   * The workload comes from the server-owned Capacity projection
   * (`generalFor(providerID, modelID)`), which ranks provenance strictly:
   * this model's own settled requests > the user's overall recent requests >
   * the standardized coding-agent prior. It is then repriced through this
   * model's own current pricing regimes (§8 context tiers, §9 time blend), so a
   * cold-start model still gets a real $/request answer instead of nothing.
   *
   * It is deliberately NOT a "requests left" figure: inverting spend into
   * request counts needs a quota/resource denominator, which Capacity owns.
   * Free/unlimited models return `priced: false` and render nothing.
   */
  const generalYield = createMemo(() => {
    const general = props.usage?.general
    if (!general) return undefined
    if (props.free || props.unlimited) return undefined
    const cost = props.model.cost
    if (!cost || !hasPublishedPricing(cost)) return undefined
    return evaluateGeneralUsageYield({
      model: { id: props.model.id, name: props.model.name, provider: { id: props.model.provider.id ?? "unknown" } },
      cost,
      general: general.workload,
      source: general.source,
      contextLimit: props.model.limit.context,
      thresholdPricing: props.thresholdPricing,
    })
  })
  const generalYieldShown = createMemo(() => (generalYield()?.priced ? generalYield() : undefined))
  const generalContextLoad = createMemo(() => {
    const general = props.usage?.general
    const limit = props.model.limit.context
    if (!general || !(limit > 0)) return undefined
    return general.workload.contextTokens / limit
  })

  if (props.v2) {
    const tags = () => {
      const list: Array<{ label: string; tone?: "accent" | "success" }> = []
      if (props.latest) list.push({ label: language.t("model.tag.latest"), tone: "accent" })
      if (props.unlimited) list.push({ label: language.t("model.tag.unlimited"), tone: "success" })
      if (props.free) list.push({ label: language.t("model.tag.free"), tone: "success" })
      return list
    }
    // Text is implied for every chat model; only call out the extra modalities.
    const modalities = () => {
      if (props.model.capabilities) {
        const input = props.model.capabilities.input
        return (["image", "pdf", "audio", "video"] as const).filter((key) => input[key])
      }
      return (props.model.modalities?.input ?? []).filter((value) => value !== "text")
    }
    const reasons = () => (props.model.capabilities ? props.model.capabilities.reasoning : !!props.model.reasoning)
    const peakPriced = () =>
      isDeepSeekPeakPricedModel({ id: props.model.id, provider: { id: props.model.provider.id ?? "" } })
    const period = () => props.period ?? deepSeekRatePeriod(new Date())
    const unlimitedCapacity = () => props.usage?.capacityStatus === "unlimited"
    // Declared above its first reader: `capacitySource` below draws on it while
    // rendering the same block, so the helper must not sit beneath it.
    const hasBand = () => capacity().windows.some((window) => window.total !== undefined)
    const capacitySource = () => {
      if (unlimitedCapacity()) return undefined
      const general = props.usage?.general
      // A full-window band's spread comes from the workload corpus. Describe
      // that provenance directly; raw server failure/reason codes are data, not UI copy.
      if (hasBand() && general) return generalUsageSource(general.source)
      return props.usage?.personalized
        ? language.t("model.tooltip.usage.source.personal")
        : language.t("model.tooltip.usage.source.estimated")
    }
    const learningSamples = () => {
      const learning = capacity().learning
      if (!learning || learning.samples === undefined) return undefined
      return learning.budget === undefined
        ? language.t("model.tooltip.capacity.learningSamplesOpen", { samples: learning.samples })
        : language.t("model.tooltip.capacity.learningSamples", { samples: learning.samples, budget: learning.budget })
    }
    const hitRate = () => props.hitRate ?? hitRateForTooltip()
    // Credit-denominated providers already expose their real economics in
    // REQUEST CAPACITY. Never fabricate a USD/token table when no price exists.
    // A borrowed price is not a fabricated one: it stays visible, qualified.
    const showPricing = () => !!props.model.cost && hasPublishedPricing(props.model.cost)
    const usd = (value: number) =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 4,
        maximumFractionDigits: 6,
      }).format(value)

    return (
      <div data-component="model-inspector" data-embedded={props.embedded || undefined}>
        {/* ---- Header: what this model is ---- */}
        <div data-slot="head">
          <div data-slot="head-row">
            <span data-slot="head-icon">
              <ProviderIcon id={props.model.provider.id ?? "synthetic"} class="size-3.5 opacity-80" />
            </span>
            <span data-slot="head-title" dir="auto">
              {stripUnlimitedSuffix(props.model.name)}
            </span>
            <Show when={tags().length > 0}>
              <span data-slot="head-tags">
                <For each={tags()}>
                  {(tag) => (
                    <span data-slot="chip" data-tone={tag.tone}>
                      {tag.label}
                    </span>
                  )}
                </For>
              </span>
            </Show>
          </div>
          <div data-slot="head-meta">
            <span data-slot="head-provider">{providerLabel(props.model)}</span>
            <Show when={account()}>
              {(value) => (
                <span data-slot="chip" data-tone="muted" title={`${language.t("model.tooltip.account")}: ${value()}`}>
                  {value()}
                </span>
              )}
            </Show>
            <span data-slot="head-id" title={props.model.id}>
              {props.model.id}
            </span>
          </div>
          <div data-slot="head-stats">
            <span data-slot="chip" data-tone="muted" title={context()}>
              {language.t("model.inspector.contextValue", { value: formatTokens(props.model.limit.context, language.intl()) })}
            </span>
            <span data-slot="chip" data-tone={reasons() ? "muted" : undefined}>
              {reasons() ? language.t("model.tooltip.reasoning") : language.t("model.tooltip.reasoning.none")}
            </span>
            <For each={modalities()}>{(value) => <span data-slot="chip">{inputLabel(value)}</span>}</For>
            <Show when={peakPriced()}>
              <span data-slot="chip" data-tone="accent" title={language.t("model.peak.hours")}>
                {period() === "peak" ? language.t("model.tag.peak") : language.t("model.tag.offpeak")}
              </span>
            </Show>
          </div>
        </div>

        <div data-slot="body">
          {/* Capacity leads: it is the only block that can change the choice.
              WorkBuddy/Genspark fund requests with credits rather than a dollar
              window, so they own the same section instead. The workload the
              band was derived from is named by the workload section below. */}
          <Show when={capacity().hasCapacity || unlimitedCapacity()}>
            <InspectorSection
              title={language.t("model.tooltip.capacity.title")}
              icon="usage"
              hint={
                hasBand()
                  ? pricingInferred()
                    ? language.t("model.tooltip.pricing.inferredHint")
                    : language.t("model.tooltip.capacity.bandHint")
                  : undefined
              }
              aside={
                <Show when={capacitySource()}>
                  {(source) => (
                    <>
                      <Show when={props.usage?.personalized}>
                        <i aria-hidden="true" />
                      </Show>
                      <span>{source()}</span>
                    </>
                  )}
                </Show>
              }
              asideTitle={capacitySource() ? language.t("model.inspector.basedOn", { source: capacitySource()! }) : undefined}
            >
              <Show
                when={!unlimitedCapacity()}
                fallback={
                  <InspectorRow
                    name={language.t("model.tooltip.capacity.fiveHourLeft")}
                    value={language.t("model.tag.unlimited")}
                    tone="success"
                  />
                }
              >
                <For each={capacity().windows}>
                  {(window) => <InspectorCapacityWindow view={window} inferred={pricingInferred()} />}
                </For>
              </Show>
              <Show when={learningSamples()}>
                {(value) => (
                  <InspectorRow
                    name={
                      <>
                        <IconV2 name="hourglass" size="small" class="size-2.5" />
                        {language.t("model.tooltip.capacity.learning")}
                      </>
                    }
                    value={<span data-slot="dim">{value()}</span>}
                  />
                )}
              </Show>
            </InspectorSection>
          </Show>

          <Show when={props.usage?.workbuddy}>
            {(wb) => {
              const total = () => wb().totalCredits ?? 0
              const fraction = () => (total() > 0 ? wb().remainingCredits / total() : undefined)
              return (
                <InspectorSection
                  title={language.t("model.tooltip.capacity.title")}
                  icon="usage"
                  aside={
                    <Show when={!wb().free}>
                      <Show when={wb().personalized}>
                        <i aria-hidden="true" />
                      </Show>
                      <span>
                        {wb().personalized
                          ? language.t("model.tooltip.usage.source.personal")
                          : language.t("model.tooltip.usage.source.estimated")}
                      </span>
                    </Show>
                  }
                >
                  <InspectorRow
                    name={language.t("model.tooltip.workbuddy.rate")}
                    tone={wb().free ? "success" : undefined}
                    value={
                      wb().free
                        ? language.t("model.tooltip.workbuddy.free")
                        : language.t("model.tooltip.workbuddy.rateValue", { rate: wb().rate })
                    }
                  />
                  <InspectorRow
                    name={language.t("model.tooltip.workbuddy.credits")}
                    title={language.t("model.tooltip.workbuddy.creditsValue", {
                      remaining: Math.round(wb().remainingCredits).toLocaleString(language.intl()),
                      total: Math.round(total()).toLocaleString(language.intl()),
                      account: wb().account,
                    })}
                    value={
                      <>
                        <Show when={fraction() !== undefined}>
                          <InspectorMeter fraction={fraction()!} tone={toneForRemaining(fraction()! * 100) as Tone} />
                        </Show>
                        <span>
                          {Math.round(wb().remainingCredits).toLocaleString(language.intl())}
                        </span>
                        <Show when={total() > 0}>
                          <span data-slot="dim">/ {Math.round(total()).toLocaleString(language.intl())}</span>
                        </Show>
                      </>
                    }
                  />
                  <Show when={!wb().free}>
                    <InspectorRow
                      name={language.t("model.tooltip.workbuddy.requests")}
                      value={<span>~{Math.round(wb().estimatedRequests).toLocaleString(language.intl())}</span>}
                    />
                  </Show>
                </InspectorSection>
              )
            }}
          </Show>

          <Show when={props.usage?.genspark}>
            {(gs) => (
              <InspectorSection title={language.t("model.tooltip.capacity.title")} icon="usage">
                {/* Genspark's balance is a real measurement even when its pricing is
                    not published. Keep the balance, dash the rate we do not have, and
                    omit the request count outright rather than deriving it from an
                    invented $/M. */}
                <InspectorRow
                  name={language.t("model.tooltip.genspark.creditsPerMillion")}
                  tone={gs().rateCreditsPerM === undefined ? "muted" : undefined}
                  value={
                    gs().rateCreditsPerM === undefined ? CAPACITY_DASH : formatCreditsPerMillion(gs().rateCreditsPerM!)
                  }
                />
                <InspectorRow
                  name={language.t("model.tooltip.genspark.remainingCredits")}
                  value={language.t("model.tooltip.genspark.creditsValue", {
                    count: Math.round(gs().remainingCredits).toLocaleString(language.intl()),
                  })}
                />
              </InspectorSection>
            )}
          </Show>

          {/* Your own workload, not the population corpus: every figure here is
              priced through this model from requests the user actually sent. */}
          <Show when={props.usage?.general}>
            {(general) => (
              <InspectorSection
                title={language.t("model.tooltip.workload.title")}
                icon="history"
                aside={<span>{generalUsageSource(general().source)}</span>}
                asideTitle={generalUsageSource(general().source)}
              >
                <InspectorRow
                  name={language.t("model.tooltip.generalUsage.typical")}
                  value={
                    <span>
                      {language.t("model.tooltip.generalUsage.typicalValue", {
                        context: formatTokens(general().workload.contextTokens, language.intl()),
                        generation: formatTokens(general().workload.generationTokens, language.intl()),
                      })}
                    </span>
                  }
                />
                <Show when={generalContextLoad() !== undefined}>
                  {(_) => {
                    const load = () => generalContextLoad()!
                    return (
                    <InspectorRow
                      name={language.t("model.tooltip.generalUsage.contextLoad")}
                      tone={load() > 1 ? "danger" : undefined}
                      value={
                        <>
                          <InspectorMeter fraction={load()} tone={contextLoadTone(load())} />
                          <span>{Math.round(load() * 100)}%</span>
                          <Show when={load() > 1}>
                            <span>{language.t("model.tooltip.generalUsage.contextOverflow")}</span>
                          </Show>
                        </>
                      }
                    />
                    )
                  }}
                </Show>
                <Show when={generalYieldShown()}>
                  {(yielded) => (
                    <>
                      <InspectorRow
                        name={language.t("model.tooltip.workload.costPerRequest")}
                        title={inferredHint()}
                        value={
                          <span>{qualifyInferred(usd(yielded().costPerEquivalentRequest ?? 0), pricingInferred())}</span>
                        }
                      />
                      <InspectorRow
                        name={language.t("model.tooltip.generalUsage.requestsPerDollar")}
                        title={inferredHint()}
                        value={
                          <>
                            <span>
                              {qualifyInferred(
                                Math.round(yielded().equivalentRequestsPerDollar ?? 0).toLocaleString(language.intl()),
                                pricingInferred(),
                              )}
                            </span>
                            <span data-slot="dim">/ $1</span>
                          </>
                        }
                      />
                    </>
                  )}
                </Show>
                <Show when={general().observedRequestBand}>
                  {(band) => (
                    <InspectorRow
                      name={language.t("model.tooltip.generalUsage.range")}
                      value={
                        <span>
                          {formatTokens(band().lowerContextTokens, language.intl())}–
                          {formatTokens(band().upperContextTokens, language.intl())}
                        </span>
                      }
                    />
                  )}
                </Show>
              </InspectorSection>
            )}
          </Show>

          <Show when={showPricing()}>
            <InspectorSection
              title={language.t("model.tooltip.pricing.title")}
              icon="cache"
              hint={inferredHint()}
              aside={
                <>
{/* The qualifier a published rate never needs. Plain label: the
                      "~" belongs on the figures themselves, not on the word. */}
                  <Show when={pricingInferred()}>
                    <span data-slot="chip" data-tone="muted">
                      {language.t("model.tag.inferred")}
                    </span>
                  </Show>
                  <Show when={hitRate() !== undefined}>
                    {(_) => (
                      <>
                        <InspectorMeter fraction={hitRate()!} tone="success" />
                        <span>
                          {language.t("model.inspector.cacheHitValue", { value: `${Math.round(hitRate()! * 100)}%` })}
                        </span>
                      </>
                    )}
                  </Show>
                </>
              }
              asideTitle={inferredHint() ?? language.t("model.tooltip.cacheHitRate.label")}
            >
              <InspectorCostTable
                model={props.model}
                cost={props.model.cost!}
                period={props.period}
                inferred={pricingInferred()}
              />
            </InspectorSection>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <div class="flex max-w-[calc(100vw-30px)] flex-col gap-1 overflow-hidden py-1 max-h-[calc(100vh-30px)]">
      <div class="text-13-medium">{title()}</div>
      <Show when={inputs()}>
        {(value) => (
          <div class="text-12-regular text-text-invert-base">
            {language.t("model.tooltip.allows", { inputs: value() })}
          </div>
        )}
      </Show>
      <div class="text-12-regular text-text-invert-base">{reasoning()}</div>
      <div class="text-12-regular text-text-invert-base">{context()}</div>
      <Show when={props.model.cost || props.model.provider.id === "genspark"}>
        <div class="text-12-regular text-text-invert-base">
          {(() => {
            const isG = props.model.provider.id === "genspark"
            const fmt = isG ? formatCreditsPerMillion : formatCostPerMillion
            // Genspark publishes no token price, so this reads "—". That is the
            // honest answer: the real balance and any observed rate live in the
            // inspector, and no placeholder $/M or credits/M may stand in for a
            // rate nobody published.
            // A borrowed rate is still shown, marked "~": an estimate beats a
            // dash, it just may not impersonate a published one.
            return language.t("model.tooltip.cost", {
              input: qualifyInferred(fmt(props.model.cost?.input ?? 0), pricingInferred()),
              cached: qualifyInferred(fmt(props.model.cost?.cache?.read ?? 0), pricingInferred()),
              output: qualifyInferred(fmt(props.model.cost?.output ?? 0), pricingInferred()),
            })
          })()}
        </div>
      </Show>
    </div>
  )
}
