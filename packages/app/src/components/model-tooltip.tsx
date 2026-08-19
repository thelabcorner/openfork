import { Show, type Component, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { DEEPSEEK_PEAK_RATES, deepSeekRatePeriod, isDeepSeekPeakPricedModel, type DeepSeekRate } from "@/utils/model-peak-pricing"

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
function ModelTooltipCostTable(props: { model: ModelInfo; cost: NonNullable<ModelInfo["cost"]> }) {
  const language = useLanguage()
  const peakRates = () => (isDeepSeekPeakPricedModel({ id: props.model.id, provider: { id: props.model.provider.id ?? "" } }) ? DEEPSEEK_PEAK_RATES[props.model.id] : undefined)
  const currentPeriod = () => deepSeekRatePeriod(new Date())

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
          {row(language.t("model.tooltip.cost.cached"), props.cost.cache.read)}
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
  v2?: boolean
  usage?: { percent: number; estimatedRequests?: number; personalized?: boolean }
}> = (props) => {
  const language = useLanguage()
  const sourceName = (model: ModelInfo) => {
    const value = `${model.id} ${model.name}`.toLowerCase()

    if (/claude|anthropic/.test(value)) return language.t("model.provider.anthropic")
    if (/gpt|o[1-4]|codex|openai/.test(value)) return language.t("model.provider.openai")
    if (/gemini|palm|bard|google/.test(value)) return language.t("model.provider.google")
    if (/grok|xai/.test(value)) return language.t("model.provider.xai")
    if (/llama|meta/.test(value)) return language.t("model.provider.meta")

    return model.provider.name
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
    if (props.free) tags.push(language.t("model.tag.free"))
    const suffix = tags.length ? ` (${tags.join(", ")})` : ""
    return `${sourceName(props.model)} ${props.model.name}${suffix}`
  }
  const name = () => {
    const tags: Array<string> = []
    if (props.latest) tags.push(language.t("model.tag.latest"))
    if (props.free) tags.push(language.t("model.tag.free"))
    const suffix = tags.length ? ` (${tags.join(", ")})` : ""
    return `${props.model.name}${suffix}`
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

  if (props.v2) {
    return (
      <div class="flex w-[224px] flex-col gap-2">
        <ModelTooltipRow name={language.t("model.tooltip.model")} value={name()} />
        <ModelTooltipRow name={language.t("model.tooltip.provider")} value={props.model.provider.name} />
        <Show when={inputs()}>
          {(value) => <ModelTooltipRow name={language.t("model.tooltip.inputs")} value={value()} />}
        </Show>
        <ModelTooltipRow name={language.t("model.tooltip.reasoning")} value={reasoning()} />
        <ModelTooltipRow name={language.t("model.tooltip.context.label")} value={contextLimit()} />
        <Show when={props.model.cost && (props.model.cost.input > 0 || props.model.cost.output > 0 || props.model.cost.cache.read > 0)}>
          <div class="h-px bg-v2-border-border-muted" />
          <ModelTooltipCostTable model={props.model} cost={props.model.cost!} />
        </Show>
        <Show when={props.usage?.estimatedRequests !== undefined}>
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
    <div class="flex flex-col gap-1 py-1">
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
      <Show when={props.model.cost && (props.model.cost.input > 0 || props.model.cost.output > 0 || props.model.cost.cache.read > 0)}>
        <div class="text-12-regular text-text-invert-base">
          {language.t("model.tooltip.cost", {
            input: formatCostPerMillion(props.model.cost!.input),
            cached: formatCostPerMillion(props.model.cost!.cache.read),
            output: formatCostPerMillion(props.model.cost!.output),
          })}
        </div>
      </Show>
    </div>
  )
}
