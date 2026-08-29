import { createEffect, createMemo, createSignal, ErrorBoundary, For, Match, Show, startTransition, Switch } from "solid-js"
import type { JSX } from "solid-js"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { createUsageSummary, USAGE_WINDOWS, type UsageWindowDef } from "./use-usage-summary"
import {
  formatUSD,
  formatUSDCompact,
  formatTokens,
  formatRate,
  formatPercent,
  formatDuration,
  formatNumber,
} from "./usage-format"
import { UsageAreaChart, UsageBarRow, UsageDOWChart, UsageHeatmap, UsageHourChart, UsageTooltipContent } from "./usage-chart"
import { groupModelsByName, modelsForProvider, type ModelGroup } from "./usage-model-groups"
import { createCatalogIdentify, type CatalogModel } from "./usage-model-identity"
import { UsageModelTable, UsageProviderModelTable } from "./usage-model-table"
import { SortHeader } from "./usage-table"
import { createColumnSort } from "./usage-sort"
import { useOpenRouterFreeUsage } from "@/hooks/use-openrouter-free-usage"
import { FreeUsageBar, FreeUsageModelsTable } from "@/components/openrouter-free-usage-bar"
import { MetricCell, Section, SegmentedTabs } from "@/components/session/insights-primitives"
import { useModels } from "@/context/models"

type Metric = "cost" | "tokens"
type Page = "overview" | "models" | "providers"


export function UsagePanelContent() {
  const language = useLanguage()
  const [windowKey, setWindowKey] = createSignal<string>("7d")
  const [projectID, setProjectID] = createSignal<string | null>(null)
  const [metric, setMetric] = createSignal<Metric>("cost")
  const [refreshTick, setRefreshTick] = createSignal(0)
  const [page, setPage] = createSignal<Page>("overview")
  const [selectedProviderID, setSelectedProviderID] = createSignal<string | null>(null)

  const windowDef = createMemo(() => USAGE_WINDOWS.find((w) => w.key === windowKey()) ?? USAGE_WINDOWS[4])

  const summary = createUsageSummary({ windowDef, projectID, refreshTick })
  const freeUsage = useOpenRouterFreeUsage({ includeValue: true })

  // Provider ids are stable, compact, and already the canonical labels used
  // by the selector and server data — no need to resolve a display name.
  const providerName = (id: string) => id

  // The model catalog (already loaded for the model selector) is the source
  // of truth models.dev uses to republish one canonical name per model under
  // every provider that serves it — exactly what "By Model" needs to fold
  // e.g. a direct API and an OpenRouter route for the same model into one
  // row. See usage-model-identity.ts for why this is safe (exact catalog
  // lookup, not fuzzy string matching) and how it degrades when a model
  // isn't in the live catalog.
  const models = useModels()
  const catalog = createMemo<CatalogModel[]>(() =>
    models.list().map((m) => ({ providerID: m.provider.id, modelID: m.id, name: m.name, family: m.family })),
  )
  const identify = createMemo(() => createCatalogIdentify(catalog()))
  const totalCost = () => {
    const data = summary()
    if (!data) return 0
    return data.totals.cost + data.totals.estimatedCost
  }
  const tokenTotal = () => {
    const data = summary()
    if (!data) return 0
    const tokens = data.totals.tokens
    return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning
  }
  const periodTotal = () => {
    const data = summary()
    if (!data) return 0
    return data.periods.reduce((sum, period) => sum + (metric() === "cost" ? period.cost : period.tokens), 0)
  }
  const isAllTime = () => windowDef().key === "all"
  const windowTitle = () => {
    if (isAllTime()) return language.t("usage.window.all")
    return formatDuration(windowDef().ms, language.intl())
  }

  const pricingLabel = () => {
    const data = summary()
    if (!data) return ""
    switch (data.pricing.mode) {
      case "estimated":
        return language.t("usage.pricing.estimated")
      case "mixed":
        return language.t("usage.pricing.mixed")
      case "unpriced":
        return language.t("usage.pricing.unpriced")
      default:
        return language.t("usage.pricing.recorded")
    }
  }

  // Every unique model in one place — merging the (provider, model, variant)
  // rows the server reports, including across providers that serve the same
  // model under different id strings, so the same model reads as one number
  // instead of several smaller, easier-to-miss ones.
  const modelGroups = createMemo(() => groupModelsByName(summary()?.models ?? [], identify()))

  // Keep the "By Provider" page's selection valid as the window/project
  // changes; default to whichever provider currently has the most spend.
  createEffect(() => {
    const providers = summary()?.providers ?? []
    if (providers.length === 0) {
      setSelectedProviderID(null)
      return
    }
    if (selectedProviderID() && providers.some((provider) => provider.providerID === selectedProviderID())) return
    const top = [...providers].sort((a, b) => b.cost + b.estimatedCost - (a.cost + a.estimatedCost))[0]
    setSelectedProviderID(top.providerID)
  })

  return (
    <ErrorBoundary
      fallback={(error) => {
        console.error("[usage-panel] render failure", error)
        return (
          <div class="flex h-full flex-col items-center justify-center gap-1 px-3">
            <span class="text-[10px] font-[600] uppercase leading-3 tracking-[0.02em] text-v2-state-fg-danger">
              {language.t("usage.error")}
            </span>
            <span class="max-w-full truncate text-[10px] font-[440] leading-3 text-v2-text-text-faint">
              {error instanceof Error ? error.message : String(error)}
            </span>
          </div>
        )
      }}
    >
      <ScrollView class="h-full">
        <div class="flex flex-col gap-3 p-3">
          <div class="flex flex-wrap gap-1">
            <For each={USAGE_WINDOWS}>
              {(option) => (
                <button
                  type="button"
                  class="h-6 rounded-md px-1.5 text-[10px] font-[520] leading-6 tabular-nums transition-colors"
                  classList={{
                    "bg-v2-background-bg-layer-03 text-v2-text-text-base": windowKey() === option.key,
                    "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover": windowKey() !== option.key,
                  }}
                  onClick={() => void startTransition(() => setWindowKey(option.key))}
                >
                  {language.t(option.labelKey)}
                </button>
              )}
            </For>
          </div>

          <Show when={freeUsage.data()}>
            {(report) => (
              <div class="flex flex-col gap-2">
                <FreeUsageBar report={report()} />
                <Show when={report().free.models.length > 0}>
                  <FreeUsageModelsTable report={report()} />
                </Show>
              </div>
            )}
          </Show>

          <div class="flex items-center gap-1">
            <div class="flex min-w-0 flex-1 items-center gap-1">
              <div class="flex items-center rounded-md bg-v2-background-bg-layer-02 p-0.5">
                <button
                  type="button"
                  class="h-5 rounded-[5px] px-2 text-[10px] font-[560] leading-5"
                  classList={{
                    "bg-v2-background-bg-base text-v2-text-text-base shadow-[var(--v2-elevation-switch-on)]":
                      metric() === "cost",
                    "text-v2-text-text-muted": metric() !== "cost",
                  }}
                  onClick={() => void startTransition(() => setMetric("cost"))}
                >
                  {language.t("usage.metric.cost")}
                </button>
                <button
                  type="button"
                  class="h-5 rounded-[5px] px-2 text-[10px] font-[560] leading-5"
                  classList={{
                    "bg-v2-background-bg-base text-v2-text-text-base shadow-[var(--v2-elevation-switch-on)]":
                      metric() === "tokens",
                    "text-v2-text-text-muted": metric() !== "tokens",
                  }}
                  onClick={() => void startTransition(() => setMetric("tokens"))}
                >
                  {language.t("usage.metric.tokens")}
                </button>
              </div>

              <select
                class="h-6 min-w-0 flex-1 rounded-md border-0 bg-v2-background-bg-layer-02 px-1.5 text-[10px] font-[500] text-v2-text-text-base outline-none"
                value={projectID() ?? ""}
                onChange={(event) => void startTransition(() => setProjectID(event.currentTarget.value || null))}
                aria-label={language.t("usage.project.select")}
              >
                <option value="">{language.t("usage.project.all")}</option>
                <For each={summary()?.projects ?? []}>
                  {(project) => <option value={project.projectID}>{project.name}</option>}
                </For>
              </select>
            </div>
            <TooltipV2 value={language.t("common.refresh")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                onClick={() => void startTransition(() => setRefreshTick((value) => value + 1))}
                aria-label={language.t("common.refresh")}
                icon={<Icon name="outline-reset" />}
              />
            </TooltipV2>
            <Show when={summary.loading}>
              <span class="flex size-6 shrink-0 items-center justify-center" role="status" aria-label={language.t("usage.loading")}>
                <Spinner class="size-3.5 text-v2-icon-icon-muted" />
              </span>
            </Show>
          </div>

          <SegmentedTabs
            value={page()}
            onChange={(value) => setPage(value as Page)}
            options={[
              { value: "overview", label: language.t("usage.page.overview") },
              { value: "models", label: language.t("usage.page.models") },
              { value: "providers", label: language.t("usage.page.providers") },
            ]}
          />

          <Switch>
            <Match when={summary.loading && !summary()}>
              <div class="flex min-h-24 items-center justify-center gap-2 py-8 text-[10px] font-[440] text-v2-text-text-faint">
                <Spinner class="size-3.5 text-v2-icon-icon-muted" />
                {language.t("usage.loading")}
              </div>
            </Match>
            <Match when={summary.error}>
              <div class="py-8 text-center text-[10px] font-[440] text-v2-text-text-faint">
                {language.t("usage.error")}
              </div>
            </Match>
            <Match when={summary()}>
              <Switch>
                <Match when={page() === "overview"}>
                  <UsageOverviewPage
                    data={summary()!}
                    metric={metric()}
                    providerName={providerName}
                    totalCost={totalCost()}
                    tokenTotal={tokenTotal()}
                    periodTotal={periodTotal()}
                    windowTitle={windowTitle()}
                    pricingLabel={pricingLabel()}
                    modelGroups={modelGroups()}
                    resolution={windowDef().resolution}
                  />
                </Match>
                <Match when={page() === "models"}>
                  <UsageModelsPage groups={modelGroups()} windowTitle={windowTitle()} metric={metric()} />
                </Match>
                <Match when={page() === "providers"}>
                  <UsageProvidersPage
                    data={summary()!}
                    providerName={providerName}
                    selected={selectedProviderID()}
                    onSelect={setSelectedProviderID}
                    metric={metric()}
                  />
                </Match>
              </Switch>
            </Match>
            <Match when={true}>
              <div class="py-8 text-center text-[10px] font-[440] text-v2-text-text-faint">
                {language.t("usage.empty")}
              </div>
            </Match>
          </Switch>
        </div>
      </ScrollView>
    </ErrorBoundary>
  )
}

function UsageOverviewPage(props: {
  data: UsageSummaryResponse
  metric: Metric
  providerName: (id: string) => string
  totalCost: number
  tokenTotal: number
  periodTotal: number
  windowTitle: string
  pricingLabel: string
  modelGroups: ModelGroup[]
  resolution: "hour" | "day"
}) {
  const language = useLanguage()
  const data = props.data
  const tokens = data.totals.tokens
  const rates = data.rates

  const providerBars = () => {
    const max = Math.max(...data.providers.map((provider) => provider.cost + provider.estimatedCost), 0)
    return data.providers
      .map((provider) => {
        const tokenSum =
          provider.tokens.input + provider.tokens.cacheRead + provider.tokens.cacheWrite + provider.tokens.output + provider.tokens.reasoning
        return {
          id: provider.providerID,
          label: props.providerName(provider.providerID),
          value: provider.cost + provider.estimatedCost,
          max,
          display: formatUSDCompact(provider.cost + provider.estimatedCost, language.intl()),
          share: provider.share,
          messages: provider.messages,
          tokens: tokenSum,
        }
      })
      .sort((a, b) => b.value - a.value)
  }

  const variantRows = () => {
    const max = Math.max(...data.variants.map((variant) => variant.messages), 1)
    return data.variants.map((variant) => ({
      label: variant.variant === null ? language.t("usage.variant.default") : variant.variant,
      value: variant.messages,
      max,
      display: formatNumber(variant.messages, language.intl()),
      share: variant.share,
    }))
  }

  const ttftAvg = () => (data.totals.ttftRecords > 0 ? data.totals.ttftMs / data.totals.ttftRecords : 0)

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-2.5">
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-[20px] font-[650] leading-6 tabular-nums text-v2-text-text-base">
            {props.metric === "cost"
              ? formatUSD(props.totalCost, language.intl())
              : formatTokens(props.tokenTotal, language.intl())}
          </span>
          <span class="text-[9px] font-[520] uppercase leading-3 text-v2-text-text-faint">{props.pricingLabel}</span>
        </div>
        <div class="flex items-center justify-between gap-2 text-[10px] font-[440] leading-3 text-v2-text-text-muted">
          <span>
            {formatTokens(props.tokenTotal, language.intl())} tokens · {formatNumber(data.totals.messages, language.intl())}{" "}
            {language.plural("usage.turns", data.totals.messages)} · {formatNumber(data.totals.sessions, language.intl())}{" "}
            {language.plural("usage.sessions", data.totals.sessions)}
          </span>
          <span class="shrink-0">{props.windowTitle}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-1.5">
        <MetricCell
          label={language.t("usage.metric.tokensPerSecond")}
          value={`${formatRate(rates.tokensPerSecond, language.intl())} tok/s`}
          sub={language.t("usage.metric.outputThroughput")}
          accent
        />
        <MetricCell
          label={language.t("usage.metric.avgTokensPerTurn")}
          value={formatTokens(rates.avgTokensPerTurn, language.intl())}
        />
        <MetricCell
          label={language.t("usage.metric.avgCostPerTurn")}
          value={formatUSD(rates.avgCostPerTurn, language.intl())}
        />
        <MetricCell
          label={language.t("usage.metric.timeToFirstToken")}
          value={formatDuration(ttftAvg(), language.intl())}
        />
        <MetricCell
          label={language.t("usage.metric.cacheHitRate")}
          value={formatPercent(rates.cacheHitRate, language.intl())}
          sub={`${formatTokens(tokens.cacheRead, language.intl())} read / ${formatTokens(tokens.input, language.intl())} fresh`}
        />
        <MetricCell
          label={language.t("usage.metric.cacheSavings")}
          value={formatUSD(rates.cacheSavings, language.intl())}
          sub={language.t("usage.metric.cacheSavingsSub")}
        />
        <Show when={data.mostUsedModel}>
          <MetricCell
            label={language.t("usage.metric.mostUsedModel")}
            value={data.mostUsedModel!.modelID}
            sub={`${formatPercent(data.mostUsedModel!.share, language.intl())} · ${props.providerName(data.mostUsedModel!.providerID)}`}
            accent
          />
        </Show>
        <MetricCell
          label={language.t("usage.metric.pricingCoverage")}
          value={formatPercent(data.pricing.coverage, language.intl())}
          sub={language.t("usage.metric.pricingCoverageSub")}
        />
      </div>

      <Section
        title={language.t("usage.section.timeline")}
        value={props.metric === "cost" ? formatUSD(props.periodTotal, language.intl()) : formatTokens(props.periodTotal, language.intl())}
      >
        <UsageAreaChart periods={data.periods} metric={props.metric} resolution={props.resolution} />
      </Section>

      <Section title={language.t("usage.section.providers")}>
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
                      { label: language.t("usage.metric.cost"), value: formatUSD(provider.value, language.intl()) },
                      { label: language.t("usage.metric.tokens"), value: formatTokens(provider.tokens, language.intl()) },
                      { label: language.t("usage.table.requests"), value: formatNumber(provider.messages, language.intl()) },
                      { label: language.t("usage.table.share"), value: `${Math.round(provider.share * 100)}%` },
                    ]}
                  />
                </div>
              </div>
            )}
          </For>
        </div>
      </Section>

      <Show when={props.modelGroups.length > 0}>
        <Section title={language.t("usage.section.models")} value={String(props.modelGroups.length)}>
          <UsageModelTable groups={props.modelGroups} metric={props.metric} />
        </Section>
      </Show>

      <Section title={language.t("usage.section.tokenBreakdown")}>
        <UsageTokenBreakdown tokens={tokens} />
      </Section>

      <Show when={data.variants.length > 0}>
        <Section title={language.t("usage.section.variants")}>
          <div class="flex flex-col gap-1.5">
            <For each={variantRows()}>
              {(variant) => (
                <UsageBarRow label={variant.label} value={variant.value} max={variant.max} display={variant.display} share={variant.share} />
              )}
            </For>
          </div>
        </Section>
      </Show>

      <Show when={data.projects.length > 0}>
        <Section title={language.t("usage.section.projects")}>
          <UsageProjectsTable projects={data.projects} metric={props.metric} />
        </Section>
      </Show>

      <Section title={language.t("usage.section.activity")}>
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <span class="text-[9px] font-[520] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
              {language.t("usage.activity.dow")}
            </span>
            <UsageDOWChart dow={data.dow} />
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-[9px] font-[520] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
              {language.t("usage.activity.hour")}
            </span>
            <UsageHourChart hours={data.hours} />
          </div>
        </div>
      </Section>

      <Section
        title={language.t("usage.section.heatmap")}
        value={props.metric === "cost" ? language.t("usage.heatmap.cost") : language.t("usage.heatmap.tokens")}
      >
        <UsageHeatmap days={data.days} metric={props.metric} />
      </Section>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-v2-border-border-muted pt-2 text-[9px] font-[440] leading-3 text-v2-text-text-faint">
        <span>
          {language.t("usage.footnote.priced")} {formatNumber(data.totals.pricedRecords, language.intl())}
        </span>
        <span>
          {language.t("usage.footnote.unpriced")} {formatNumber(data.totals.unpricedRecords, language.intl())}
        </span>
        <Show when={rates.cacheSavingsCoverage < 1}>
          <span>{language.t("usage.footnote.savingsCoverage")}</span>
        </Show>
      </div>
    </div>
  )
}

type ProjectSortColumn = "project" | "sessions" | "cost" | "tokens"

/** Sortable table of per-project spend — answers "which project is this window's cost coming from". */
function UsageProjectsTable(props: { projects: UsageSummaryResponse["projects"]; metric: Metric }) {
  const language = useLanguage()
  type ProjectRow = UsageSummaryResponse["projects"][number]
  const sort = createColumnSort<ProjectRow, ProjectSortColumn>(props.metric === "tokens" ? "tokens" : "cost", (project, column) => {
    switch (column) {
      case "project":
        return project.name
      case "sessions":
        return project.sessions
      case "cost":
        return project.cost
      case "tokens":
        return project.tokens
    }
  })
  createEffect(() => sort.syncDefault(props.metric === "tokens" ? "tokens" : "cost"))
  const sorted = createMemo(() => sort.sort(props.projects))

  return (
    <div class="flex flex-col overflow-hidden rounded-md border border-v2-border-border-muted">
      <div class="grid grid-cols-[minmax(0,1fr)_44px_56px_64px] items-center gap-1 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1">
        <SortHeader label={language.t("usage.table.project")} column="project" active={sort.column()} direction={sort.direction()} onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.sessions")} column="sessions" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.cost")} column="cost" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.tokens")} column="tokens" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
      </div>
      <For each={sorted()}>
        {(project) => (
          <TooltipV2
            placement="right"
            value={
              <UsageTooltipContent
                title={project.name}
                rows={[
                  { label: language.t("usage.table.sessions"), value: formatNumber(project.sessions, language.intl()) },
                  { label: language.t("usage.table.requests"), value: formatNumber(project.messages, language.intl()) },
                  { label: language.t("usage.metric.cost"), value: formatUSD(project.cost, language.intl()) },
                  { label: language.t("usage.metric.tokens"), value: formatTokens(project.tokens, language.intl()) },
                ]}
              />
            }
          >
            <div class="grid grid-cols-[minmax(0,1fr)_44px_56px_64px] items-center gap-1 border-b border-v2-border-border-muted px-2 py-1 last:border-0">
              <span class="min-w-0 truncate text-[10px] font-[480] leading-3.5 text-v2-text-text-base">{project.name}</span>
              <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
                {formatNumber(project.sessions, language.intl())}
              </span>
              <span class="text-right text-[10px] font-[520] tabular-nums text-v2-text-text-base">
                {formatUSDCompact(project.cost, language.intl())}
              </span>
              <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
                {formatTokens(project.tokens, language.intl())}
              </span>
            </div>
          </TooltipV2>
        )}
      </For>
    </div>
  )
}

/** Where tokens actually go — input/output/cache/reasoning — distinct from the cost view, since token-type mix (e.g. heavy cache writes) doesn't always track dollar spend. */
function UsageTokenBreakdown(props: { tokens: UsageSummaryResponse["totals"]["tokens"] }) {
  const language = useLanguage()
  const rows = createMemo(() => {
    const t = props.tokens
    const entries = [
      { key: "input", label: language.t("usage.tokenType.input"), value: t.input },
      { key: "output", label: language.t("usage.tokenType.output"), value: t.output },
      { key: "cacheRead", label: language.t("usage.tokenType.cacheRead"), value: t.cacheRead },
      { key: "cacheWrite", label: language.t("usage.tokenType.cacheWrite"), value: t.cacheWrite },
      { key: "reasoning", label: language.t("usage.tokenType.reasoning"), value: t.reasoning },
    ]
    const total = entries.reduce((sum, entry) => sum + entry.value, 0)
    const max = Math.max(...entries.map((entry) => entry.value), 0)
    return entries
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((entry) => ({
        ...entry,
        max,
        share: total > 0 ? entry.value / total : 0,
        display: formatTokens(entry.value, language.intl()),
      }))
  })

  return (
    <Show
      when={rows().length > 0}
      fallback={<div class="py-3 text-center text-[10px] font-[440] text-v2-text-text-faint">{language.t("usage.models.empty")}</div>}
    >
      <div class="flex flex-col gap-1.5">
        <For each={rows()}>
          {(row) => <UsageBarRow label={row.label} value={row.value} max={row.max} display={row.display} share={row.share} />}
        </For>
      </div>
    </Show>
  )
}

function UsageModelsPage(props: { groups: ModelGroup[]; windowTitle: string; metric: Metric }) {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-3">
      <Section title={language.t("usage.section.models")} value={props.windowTitle}>
        <Show
          when={props.groups.length > 0}
          fallback={<div class="py-8 text-center text-[10px] font-[440] text-v2-text-text-faint">{language.t("usage.models.empty")}</div>}
        >
          <UsageModelTable groups={props.groups} metric={props.metric} />
        </Show>
      </Section>
    </div>
  )
}

type ProviderSortColumn = "provider" | "cost" | "tokens" | "share"

function UsageProvidersPage(props: {
  data: UsageSummaryResponse
  providerName: (id: string) => string
  selected: string | null
  onSelect: (id: string) => void
  metric: Metric
}) {
  const language = useLanguage()
  const data = props.data

  const providers = createMemo(() => {
    const max = Math.max(...data.providers.map((provider) => provider.cost + provider.estimatedCost), 0)
    return data.providers.map((provider) => ({
      id: provider.providerID,
      cost: provider.cost + provider.estimatedCost,
      max,
      messages: provider.messages,
      tokens:
        provider.tokens.input + provider.tokens.cacheRead + provider.tokens.cacheWrite + provider.tokens.output + provider.tokens.reasoning,
      share: provider.share,
    }))
  })

  type ProviderRow = ReturnType<typeof providers>[number]
  const sort = createColumnSort<ProviderRow, ProviderSortColumn>(props.metric === "tokens" ? "tokens" : "cost", (row, column) => {
    switch (column) {
      case "provider":
        return props.providerName(row.id)
      case "cost":
        return row.cost
      case "tokens":
        return row.tokens
      case "share":
        return row.share
    }
  })
  createEffect(() => sort.syncDefault(props.metric === "tokens" ? "tokens" : "cost"))
  const sortedProviders = createMemo(() => sort.sort(providers()))

  const selectedProvider = createMemo(() => data.providers.find((provider) => provider.providerID === props.selected))
  const selectedRows = createMemo(() => modelsForProvider(data.models, props.selected ?? ""))

  return (
    <div class="flex flex-col gap-4">
      <Section title={language.t("usage.providers.select")}>
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-1.5 px-1.5 py-0.5">
            <span class="size-3 shrink-0" />
            <div class="w-24 shrink-0">
              <SortHeader label={language.t("usage.table.provider")} column="provider" active={sort.column()} direction={sort.direction()} onClick={sort.toggle} />
            </div>
            <div class="min-w-0 flex-1" />
            <div class="w-16 shrink-0">
              <SortHeader
                label={props.metric === "cost" ? language.t("usage.table.cost") : language.t("usage.table.tokens")}
                column={props.metric === "cost" ? "cost" : "tokens"}
                active={sort.column()}
                direction={sort.direction()}
                align="right"
                onClick={sort.toggle}
              />
            </div>
            <div class="w-9 shrink-0">
              <SortHeader label={language.t("usage.table.share")} column="share" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
            </div>
          </div>
          <For each={sortedProviders()}>
            {(provider) => {
              const fraction = () => (provider.max > 0 ? Math.max(0, Math.min(1, provider.cost / provider.max)) : 0)
              const active = () => provider.id === props.selected
              return (
                <TooltipV2
                  placement="right"
                  value={
                    <UsageTooltipContent
                      title={props.providerName(provider.id)}
                      rows={[
                        { label: language.t("usage.table.requests"), value: formatNumber(provider.messages, language.intl()) },
                        { label: language.t("usage.metric.cost"), value: formatUSD(provider.cost, language.intl()) },
                        { label: language.t("usage.metric.tokens"), value: formatTokens(provider.tokens, language.intl()) },
                        { label: language.t("usage.table.share"), value: `${Math.round(provider.share * 100)}%` },
                      ]}
                    />
                  }
                >
                  <button
                    type="button"
                    class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors"
                    classList={{
                      "bg-v2-background-bg-layer-02": active(),
                      "hover:bg-v2-overlay-simple-overlay-hover": !active(),
                    }}
                    onClick={() => props.onSelect(provider.id)}
                    aria-pressed={active()}
                  >
                    <ProviderIcon id={provider.id} class="size-3 shrink-0 opacity-60" />
                    <span
                      class="w-24 shrink-0 truncate text-[10px] font-[440] leading-3"
                      classList={{ "text-v2-text-text-base": active(), "text-v2-text-text-muted": !active() }}
                    >
                      {props.providerName(provider.id)}
                    </span>
                    <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-v2-background-bg-layer-03">
                      <div
                        class="h-full rounded-full"
                        style={{ width: `${fraction() * 100}%`, "background-color": "var(--v2-text-text-accent)" }}
                      />
                    </div>
                    <span class="w-16 shrink-0 text-right text-[10px] font-[520] leading-3 tabular-nums text-v2-text-text-base">
                      {props.metric === "cost"
                        ? formatUSDCompact(provider.cost, language.intl())
                        : formatTokens(provider.tokens, language.intl())}
                    </span>
                    <span class="w-9 shrink-0 text-right text-[10px] font-[440] leading-3 tabular-nums text-v2-text-text-faint">
                      {Math.round(provider.share * 100)}%
                    </span>
                  </button>
                </TooltipV2>
              )
            }}
          </For>
        </div>
      </Section>

      <Show when={selectedProvider()}>
        {(provider) => {
          const p = () => provider()
          const tokenSum = () =>
            p().tokens.input + p().tokens.cacheRead + p().tokens.cacheWrite + p().tokens.output + p().tokens.reasoning
          return (
            <>
              <div class="flex items-center gap-1.5">
                <ProviderIcon id={p().providerID} class="size-4 shrink-0" />
                <span class="truncate text-[13px] font-[600] leading-4 text-v2-text-text-base">
                  {props.providerName(p().providerID)}
                </span>
              </div>
              <div class="grid grid-cols-2 gap-1.5">
                <MetricCell label={language.t("usage.metric.cost")} value={formatUSD(p().cost + p().estimatedCost, language.intl())} accent />
                <MetricCell label={language.t("usage.metric.tokens")} value={formatTokens(tokenSum(), language.intl())} />
                <MetricCell label={language.t("usage.table.requests")} value={formatNumber(p().messages, language.intl())} />
                <MetricCell label={language.t("usage.table.share")} value={formatPercent(p().share, language.intl())} />
              </div>

              <Section title={language.t("usage.section.models")} value={String(selectedRows().length)}>
                <UsageProviderModelTable rows={selectedRows()} metric={props.metric} />
              </Section>
            </>
          )
        }}
      </Show>

      <Show when={!selectedProvider()}>
        <div class="py-8 text-center text-[10px] font-[440] text-v2-text-text-faint">{language.t("usage.providers.empty")}</div>
      </Show>
    </div>
  )
}
