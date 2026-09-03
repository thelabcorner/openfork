import { createEffect, createSignal, For } from "solid-js"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useLanguage } from "@/context/language"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { SegmentedTabs } from "@/components/session/insights-primitives"
import { UsageBarRow, UsageHeroAreaChart, type HeroChartMetric } from "@/components/usage/usage-chart"
import { formatNumber, formatTokens, formatUSD, formatUSDCompact } from "@/components/usage/usage-format"
import { UsageCard } from "./usage-page-primitives"

type Metric = "cost" | "tokens"

/** Hero band: the headline number + provider legend on the left, a full-width axis-labeled area chart on the right — the page's answer to T3's total/chart split, denser and richer than the sidebar panel's stacked single column. */
export function UsagePageHero(props: {
  data: UsageSummaryResponse
  metric: Metric
  providerName: (id: string) => string
  totalCost: number
  tokenTotal: number
  pricingLabel: string
  resolution: "hour" | "day"
}) {
  const language = useLanguage()
  // Accessor, not a snapshot: `const data = props.data` reads the prop once at
  // setup, so the provider legend, session/turn counts and the whole area
  // chart stayed pinned to whatever window was loaded first while the rest of
  // the page updated around them.
  const data = () => props.data
  // The area chart gets its own metric toggle, because it can plot a third
  // series ("turns over time") that the page-wide Cost/Tokens toggle cannot
  // carry — every other section is typed to the binary cost/tokens metric.
  //
  // It still FOLLOWS the page toggle until the user picks a chart series of
  // their own: seeding it once at mount left the chart stuck on whatever the
  // page metric happened to be at first paint, so switching the page to Tokens
  // moved every number except the one chart people actually look at. Same
  // "default until touched" contract as `createColumnSort.syncDefault`.
  const [chartMetric, setChartMetric] = createSignal<HeroChartMetric>(props.metric)
  let chartMetricTouched = false
  createEffect(() => {
    const pageMetric = props.metric
    if (chartMetricTouched) return
    setChartMetric(pageMetric)
  })
  const selectChartMetric = (value: HeroChartMetric) => {
    chartMetricTouched = true
    setChartMetric(value)
  }

  const providerBars = () => {
    const rows = data().providers.map((provider) => {
      const cost = provider.cost + provider.estimatedCost
      const tokenSum =
        provider.tokens.input + provider.tokens.cacheRead + provider.tokens.cacheWrite + provider.tokens.output + provider.tokens.reasoning
      return { id: provider.providerID, label: props.providerName(provider.providerID), cost, tokens: tokenSum, share: provider.share, messages: provider.messages }
    })
    const tokenTotal = rows.reduce((sum, row) => sum + row.tokens, 0)
    const max = Math.max(...rows.map((row) => (props.metric === "cost" ? row.cost : row.tokens)), 0)
    return rows
      .map((row) => ({
        id: row.id,
        label: row.label,
        value: props.metric === "cost" ? row.cost : row.tokens,
        max,
        display:
          props.metric === "cost" ? formatUSDCompact(row.cost, language.intl()) : formatTokens(row.tokens, language.intl()),
        share: props.metric === "cost" ? row.share : tokenTotal > 0 ? row.tokens / tokenTotal : 0,
        messages: row.messages,
        cost: row.cost,
        tokens: row.tokens,
      }))
      .sort((a, b) => b.value - a.value)
  }

  const periodTotal = () =>
    data().periods.reduce(
      (sum, period) => sum + (chartMetric() === "cost" ? period.cost : chartMetric() === "tokens" ? period.tokens : period.messages),
      0,
    )
  const formatPeriodTotal = (value: number) =>
    chartMetric() === "cost" ? formatUSD(value, language.intl()) : chartMetric() === "tokens" ? formatTokens(value, language.intl()) : formatNumber(value, language.intl())

  return (
    <UsageCard class="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <span class="text-[34px] font-[680] leading-9 tabular-nums text-v2-text-text-base">
            {props.metric === "cost" ? formatUSD(props.totalCost, language.intl()) : formatTokens(props.tokenTotal, language.intl())}
          </span>
          <div class="flex flex-wrap items-center gap-1.5 text-[11px] font-[440] leading-4 text-v2-text-text-muted">
            <span>{language.plural("usage.sessions", data().totals.sessions)}</span>
            <span class="text-v2-text-text-faint">·</span>
            <span>{language.plural("usage.turns", data().totals.messages)}</span>
            <span class="text-v2-text-text-faint">·</span>
            <span class="uppercase tracking-[0.02em] text-v2-text-text-faint">{props.pricingLabel}</span>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <span class="text-[10px] font-[600] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
            {language.t("usage.section.providers")}
          </span>
          <div class="flex flex-col gap-1.5">
            <For each={providerBars()}>
              {(provider) => (
                <div class="flex items-center gap-1.5">
                  <ProviderIcon id={provider.id} class="size-3 shrink-0 opacity-60" />
                  <div class="min-w-0 flex-1">
                    <UsageBarRow
                      label={provider.label}
                      value={provider.value}
                      max={provider.max}
                      display={provider.display}
                      share={provider.share}
                      tooltipRows={[
                        // `value` is whichever metric the page toggle is on —
                        // formatting it as USD renders a token count as a
                        // dollar figure in tokens mode. Always read the cost
                        // field, which the row carries independently.
                        { label: language.t("usage.metric.cost"), value: formatUSD(provider.cost, language.intl()) },
                        { label: language.t("usage.metric.tokens"), value: formatTokens(provider.tokens, language.intl()) },
                        { label: language.t("usage.table.requests"), value: formatNumber(provider.messages, language.intl()) },
                      ]}
                    />
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-[10px] font-[600] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
            {language.t("usage.section.timeline")}
          </span>
          <div class="flex items-center gap-2">
            <span class="text-[11px] font-[520] tabular-nums text-v2-text-text-muted">{formatPeriodTotal(periodTotal())}</span>
            <div class="w-40">
              <SegmentedTabs
                value={chartMetric()}
                onChange={(value) => selectChartMetric(value as HeroChartMetric)}
                options={[
                  { value: "cost", label: language.t("usage.metric.cost") },
                  { value: "tokens", label: language.t("usage.metric.tokens") },
                  { value: "turns", label: language.t("usage.metric.turns") },
                ]}
              />
            </div>
          </div>
        </div>
        <UsageHeroAreaChart periods={data().periods} metric={chartMetric()} resolution={props.resolution} />
      </div>
    </UsageCard>
  )
}
