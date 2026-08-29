import { createMemo, Show, type Component, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { DEEPSEEK_PEAK_RATES, deepSeekRatePeriod, isDeepSeekPeakPricedModel, type DeepSeekRate } from "@/utils/model-peak-pricing"
import { stripUnlimitedSuffix, hasPublishedPricing } from "@/utils/model-badges"
import { blendedCost, evaluateModelUsageYield, FALLBACK_WORKLOAD_CORPUS } from "@/utils/model-usage-yield"
import { buildHitRateIndex, buildModelCostIndex } from "@/utils/model-usage-history"
import { useSync } from "@/context/sync"

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

// cost.* is already expressed in $ per 1M tokens (see model-usage-estimate.ts,
// which divides by 1_000_000 to get $ for a token count) — format directly.
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

function ModelTooltipRow(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.name}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

// A 3-row-tall grid (label + 2 columns) instead of stacking a separate row
// per dimension — showing both units (1M/1B) AND both DeepSeek rate periods
// would be 4 numbers per metric, which doesn't fit a narrow tooltip. Instead
// this picks ONE extra dimension per model: peak/off-peak for the two
// DeepSeek models that actually have it (more actionable — there's already a
// per-row badge for "which period is it right now"), 1M/1B for everyone else.
function ModelTooltipCostTable(props: {
  model: ModelInfo
  cost: NonNullable<ModelInfo["cost"]>
  period?: ReturnType<typeof deepSeekRatePeriod>
}) {
  const language = useLanguage()
  const peakRates = () => (isDeepSeekPeakPricedModel({ id: props.model.id, provider: { id: props.model.provider.id ?? "" } }) ? DEEPSEEK_PEAK_RATES[props.model.id] : undefined)
  const currentPeriod = () => props.period ?? deepSeekRatePeriod(new Date())

  const row = (label: string, value: number) => (
    <>
      <span class="min-w-0 truncate text-v2-text-text-muted">{label}</span>
      <span class="text-right tabular-nums text-v2-text-text-base">{formatCostPerMillion(value)}</span>
      <span class="text-right tabular-nums text-v2-text-text-base">{formatCostPerBillion(value)}</span>
    </>
  )

  const peakRow = (
    label: string,
    rates: { "off-peak": DeepSeekRate; peak: DeepSeekRate },
    pick: (rate: DeepSeekRate) => number,
  ) => (
    <>
      <span class="min-w-0 truncate text-v2-text-text-muted">{label}</span>
      <span class="text-right tabular-nums text-v2-text-text-base">{formatCostPerMillion(pick(rates["off-peak"]))}</span>
      <span class="text-right tabular-nums text-v2-text-text-base">{formatCostPerMillion(pick(rates.peak))}</span>
    </>
  )

  return (
    <Show
      when={peakRates()}
      fallback={
        <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1">
          <span />
          <span class="text-right text-[10px] uppercase tracking-[0.04px] text-v2-text-text-faint">
            {language.t("model.tooltip.cost.perMillion")}
          </span>
          <span class="text-right text-[10px] uppercase tracking-[0.04px] text-v2-text-text-faint">
            {language.t("model.tooltip.cost.perBillion")}
          </span>
          {row(language.t("model.tooltip.cost.input"), props.cost.input)}
          {row(language.t("model.tooltip.cost.cached"), props.cost.cache?.read ?? 0)}
          {row(language.t("model.tooltip.cost.output"), props.cost.output)}
        </div>
      }
    >
      {(rates) => (
        <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1">
          <span />
          <span
            class="text-right text-[10px] uppercase tracking-[0.04px]"
            classList={{
              "text-v2-text-text-accent": currentPeriod() === "off-peak",
              "text-v2-text-text-faint": currentPeriod() !== "off-peak",
            }}
          >
            {language.t("model.tag.offpeak")}
          </span>
          <span
            class="text-right text-[10px] uppercase tracking-[0.04px]"
            classList={{
              "text-v2-text-text-accent": currentPeriod() === "peak",
              "text-v2-text-text-faint": currentPeriod() !== "peak",
            }}
          >
            {language.t("model.tag.peak")}
          </span>
          {peakRow(language.t("model.tooltip.cost.input"), rates(), (r) => r.input)}
          {peakRow(language.t("model.tooltip.cost.cached"), rates(), (r) => r.cacheRead)}
          {peakRow(language.t("model.tooltip.cost.output"), rates(), (r) => r.output)}
        </div>
      )}
    </Show>
  )
}

export const ModelTooltip: Component<{
  model: ModelInfo
  latest?: boolean
  free?: boolean
  unlimited?: boolean
  v2?: boolean
  usage?: {
    percent: number
    estimatedRequests?: number
    personalized?: boolean
    /** WorkBuddy-only credit/request breakdown, rendered in place of the USD-window rows. */
    workbuddy?: {
      rate: number
      free: boolean
      account: string
      remainingCredits: number
      totalCredits?: number
      estimatedRequests: number
    }
  }
  period?: ReturnType<typeof deepSeekRatePeriod>
  /** Optional precomputed Usage Yield — if omitted, fallback corpus is used synchronously. */
  yield?: ReturnType<typeof evaluateModelUsageYield>
  /** Optional explicit hit rate 0-1 (or 0-100) for this provider+model. When provided it overrides personal/openrouter lookup. */
  hitRate?: number
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

  // Usage Yield V2 (§5-6, §11, §31): derived synchronously from fallback corpus so
  // the tooltip can show "how much usage $1 buys" (§2) without awaiting the
  // live fetch. Share the same corpusFingerprint logic as the selector.
  // Personal measured $/request is blended heavily (70%) when available so the
  // tooltip reflects your actual workload, not just the generic corpus.
  const fallbackBands = createMemo(() => {
    const w = [...FALLBACK_WORKLOAD_CORPUS]
    const corpus = w.map((c) => ({ ...c }))
    corpus.sort((a, b) => a.contextTokens - b.contextTokens)
    const q1 = Math.floor(corpus.length / 4)
    const q3 = Math.ceil((corpus.length * 3) / 4)
    return {
      corpus,
      light: corpus.slice(0, q1),
      typical: corpus.slice(q1, q3),
      heavy: corpus.slice(q3),
      fingerprint: "fallback-16-aug26",
    }
  })
  // Best-effort personal index — may be unavailable outside a sync provider (e.g. storybook).
  let syncForTooltip: ReturnType<typeof useSync> | undefined
  try {
    syncForTooltip = useSync()
  } catch {
    syncForTooltip = undefined
  }
  const personalForTooltip = createMemo(() => {
    if (!syncForTooltip) return undefined
    try {
      const idx = buildModelCostIndex(syncForTooltip().data.message)
      const key = `${props.model.provider.id ?? "unknown"}:${props.model.id}`
      const entry = idx.get(key)
      if (!entry) return undefined
      return { cost: entry.sum / entry.count, count: entry.count }
    } catch {
      return undefined
    }
  })
  const hitRateForTooltip = createMemo(() => {
    if (!syncForTooltip) return undefined
    try {
      const idx = buildHitRateIndex(syncForTooltip().data.message)
      const key = `${props.model.provider.id ?? "unknown"}:${props.model.id}`
      const direct = idx.get(key)
      if (direct) {
        const denom = direct.input + direct.cacheRead
        if (denom > 0 && direct.count >= 3) return direct.cacheRead / denom
      }
      let sum = 0
      let cnt = 0
      for (const [k, entry] of idx.entries()) {
        if (k.endsWith(`:${props.model.id}`)) {
          const denom = entry.input + entry.cacheRead
          if (denom > 0 && entry.count >= 3) {
            sum += entry.cacheRead / denom
            cnt++
          }
        }
      }
      if (cnt > 0) return sum / cnt
      return undefined
    } catch {
      return undefined
    }
  })
  const derivedYield = createMemo(() => {
    if (props.yield) return props.yield
    if (!props.model.cost || !hasPublishedPricing(props.model.cost)) return undefined
    if (props.free || props.unlimited) return undefined
    try {
      const hitRate = props.hitRate ?? hitRateForTooltip()
      const base = evaluateModelUsageYield(
        {
          id: props.model.id,
          name: props.model.name,
          provider: { id: props.model.provider.id ?? "unknown" },
          cost: {
            input: props.model.cost.input,
            output: props.model.cost.output,
            cache: { read: props.model.cost.cache?.read ?? 0, write: props.model.cost.cache?.write ?? 0 },
          },
        },
        fallbackBands() as never,
        hitRate !== undefined ? { hitRate } : undefined,
      )
      const personal = personalForTooltip()
      if (!personal) return base
      // Blend personal heavily (§31) into the primary cost/yield so the tooltip
      // mirrors the selector's sorting. Light/heavy stay corpus-derived for context.
      const blended = blendedCost(base.primary.costPerEquivalentRequest ?? 0, personal.cost, personal.count)
      const blendedYield = blended > 0 ? 1 / blended : base.primary.equivalentRequestsPerDollar
      return {
        ...base,
        primary: {
          ...base.primary,
          costPerEquivalentRequest: blended,
          equivalentRequestsPerDollar: blendedYield,
        },
        // Mark as personalized for callers that care (tooltip could show hint).
        warnings: [...base.warnings, ...(personal.count >= 3 ? ["personalized"] : [])],
      } as typeof base
    } catch {
      return undefined
    }
  })

  if (props.v2) {
    return (
      <div class="flex w-[224px] max-w-[calc(100vw-30px)] flex-col gap-2 overflow-hidden max-h-[calc(100vh-30px)]">
        <ModelTooltipRow name={language.t("model.tooltip.model")} value={name()} />
        <ModelTooltipRow
          name={language.t("model.tooltip.provider")}
          value={providerLabel(props.model)}
        />
        <Show when={inputs()}>
          {(value) => <ModelTooltipRow name={language.t("model.tooltip.inputs")} value={value()} />}
        </Show>
        <ModelTooltipRow name={language.t("model.tooltip.reasoning")} value={reasoning()} />
        <ModelTooltipRow name={language.t("model.tooltip.context.label")} value={contextLimit()} />
        <Show when={props.model.cost && (props.model.cost.input > 0 || props.model.cost.output > 0 || (props.model.cost.cache?.read ?? 0) > 0)}>
          <div class="h-px bg-v2-border-border-muted" />
          <ModelTooltipCostTable model={props.model} cost={props.model.cost!} period={props.period} />
        </Show>
        <Show when={(props.hitRate ?? hitRateForTooltip()) !== undefined}>
          <ModelTooltipRow
            name={language.t("model.tooltip.cacheHitRate.label")}
            value={<span class="tabular-nums">{Math.round((props.hitRate ?? hitRateForTooltip()!) * 100)}%</span>}
          />
        </Show>
        <Show when={derivedYield()}>
          {(y) => (
            <>
              <div class="h-px bg-v2-border-border-muted" />
              <ModelTooltipRow
                name={
                  <span title={language.t("model.tooltip.usageYield.hint") as unknown as string}>
                    {language.t("model.tooltip.usageYield.label")}
                  </span>
                }
                value={<span class="tabular-nums">{Math.round(y().primary.equivalentRequestsPerDollar ?? 0).toLocaleString(language.intl())} / $1</span>}
              />
              <ModelTooltipRow
                name={language.t("model.tooltip.usageYield.cost")}
                value={
                  y().primary.costPerEquivalentRequest
                    ? new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(y().primary.costPerEquivalentRequest!)
                    : "—"
                }
              />
              <Show when={y().workload.light && y().workload.heavy}>
                <ModelTooltipRow
                  name={language.t("model.tooltip.usageYield.light")}
                  value={<span class="tabular-nums">{Math.round(y().workload.light!.requestsPerDollar).toLocaleString(language.intl())} / $1</span>}
                />
                <ModelTooltipRow
                  name={language.t("model.tooltip.usageYield.heavy")}
                  value={<span class="tabular-nums">{Math.round(y().workload.heavy!.requestsPerDollar).toLocaleString(language.intl())} / $1</span>}
                />
              </Show>
              <Show when={y().regimes.some((r) => r.kind === "time")}>
                <ModelTooltipRow
                  name={language.t("model.tooltip.usageYield.regime")}
                  value={<span class="text-[11px]">{y().regimes.find((r) => r.label === "expected") ? `${Math.round(y().regimes.find((r) => r.label === "expected")!.requestsPerDollar ?? 0).toLocaleString(language.intl())} exp` : "—"}</span>}
                />
              </Show>
            </>
          )}
        </Show>
        <Show when={props.usage?.workbuddy}>
          {(wb) => (
            <>
              <div class="h-px bg-v2-border-border-muted" />
              <ModelTooltipRow
                name={language.t("model.tooltip.workbuddy.rate")}
                value={
                  wb().free
                    ? language.t("model.tooltip.workbuddy.free")
                    : language.t("model.tooltip.workbuddy.rateValue", { rate: wb().rate })
                }
              />
              <ModelTooltipRow
                name={language.t("model.tooltip.workbuddy.credits")}
                value={language.t("model.tooltip.workbuddy.creditsValue", {
                  remaining: Math.round(wb().remainingCredits).toLocaleString(language.intl()),
                  total: Math.round(wb().totalCredits ?? 0).toLocaleString(language.intl()),
                  account: wb().account,
                })}
              />
              <Show when={!wb().free}>
                <ModelTooltipRow
                  name={language.t("model.tooltip.workbuddy.requests")}
                  value={language.t("model.tooltip.workbuddy.requestsValue", {
                    count: Math.round(wb().estimatedRequests).toLocaleString(language.intl()),
                    account: wb().account,
                  })}
                />
              </Show>
            </>
          )}
        </Show>
        <Show when={props.usage?.estimatedRequests !== undefined && !props.usage?.workbuddy}>
          <div class="h-px bg-v2-border-border-muted" />
          <ModelTooltipRow
            name={language.t("model.tooltip.usage.requests")}
            value={language.t("model.tooltip.usage.requestsValue", { count: props.usage!.estimatedRequests! })}
          />
          <ModelTooltipRow
            name={language.t("model.tooltip.usage.source")}
            value={
              props.usage!.personalized
                ? language.t("model.tooltip.usage.source.personal")
                : language.t("model.tooltip.usage.source.estimated")
            }
          />
        </Show>
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
      <Show when={props.model.cost && (props.model.cost.input > 0 || props.model.cost.output > 0 || (props.model.cost.cache?.read ?? 0) > 0)}>
        <div class="text-12-regular text-text-invert-base">
          {language.t("model.tooltip.cost", {
            input: formatCostPerMillion(props.model.cost!.input),
            cached: formatCostPerMillion(props.model.cost!.cache?.read ?? 0),
            output: formatCostPerMillion(props.model.cost!.output),
          })}
        </div>
      </Show>
    </div>
  )
}
