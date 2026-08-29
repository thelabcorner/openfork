import { createMemo, createResource, createSignal, ErrorBoundary, For, Match, Show, Switch } from "solid-js"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { matchesModelSearch } from "../dialog-select-model-search"
import { useOpenRouterFreeUsage } from "@/hooks/use-openrouter-free-usage"
import { FreeUsageBar, FreeUsageModelsTable } from "@/components/openrouter-free-usage-bar"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { buildPersonalFallbackMap, buildPricingFallbackMap, compareByCheapness } from "@/utils/model-cost"
import { buildModelCostIndex } from "@/utils/model-usage-history"
import { Section } from "@/components/session/insights-primitives"
import "../settings-v2/settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useLocal>["model"]["list"]>[number]

type SortKey = "cost" | "context" | "name"

const formatCompact = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)

// V1 fallback (input+output) retained only for column display; sorting now uses
// Usage Yield (§5-6) via compareByCheapness with fallback corpus.
const blended = (item: ModelItem) => item.cost.input + item.cost.output

/** OpenRouter endpoint telemetry for a single model, best-effort. */
type EndpointTelemetry = {
  provider_name: string
  throughput_last_30m?: { p50?: number; p75?: number; p90?: number }
  latency_last_30m?: { p50?: number; p90?: number }
  uptime_last_30m?: number
}

function TelemetryRow(props: { endpoint: EndpointTelemetry }) {
  const p50 = () => props.endpoint.throughput_last_30m?.p50
  const latency = () => props.endpoint.latency_last_30m?.p50
  const p50Text = () => {
    const value = p50()
    return value !== undefined ? `${value.toFixed(0)}` : "—"
  }
  const latencyText = () => {
    const value = latency()
    return value !== undefined ? `${(value * 1000).toFixed(0)}ms` : "—"
  }
  return (
    <div class="grid grid-cols-[minmax(0,1fr)_56px_56px_52px] items-center gap-1 border-b border-v2-border-border-muted px-2 py-1.5 last:border-0">
      <span
        class="min-w-0 truncate text-[10px] font-[480] leading-3.5 text-v2-text-text-base"
        title={props.endpoint.provider_name}
      >
        {props.endpoint.provider_name}
      </span>
      <span class="text-right text-[10px] font-[520] tabular-nums text-v2-text-text-base">{p50Text()}</span>
      <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">{latencyText()}</span>
      <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
        {props.endpoint.uptime_last_30m !== undefined ? `${props.endpoint.uptime_last_30m.toFixed(1)}%` : "—"}
      </span>
    </div>
  )
}


export function ModelsPanelContent() {
  const language = useLanguage()
  const local = useLocal()
  const model = local.model
  const sdk = useSDK()
  const freeUsage = useOpenRouterFreeUsage({ includeValue: true })
  const [search, setSearch] = createSignal("")
  const [sortKey, setSortKey] = createSignal<SortKey>("cost")
  const [selected, setSelected] = createSignal<ModelItem | undefined>()

  const all = createMemo(() =>
    model.list().filter((item) => model.visible({ modelID: item.id, providerID: item.provider.id })),
  )

  let sync: ReturnType<typeof useSync> | undefined
  try {
    sync = useSync()
  } catch {
    sync = undefined
  }
  const personalCosts = createMemo(() => {
    if (!sync) return undefined
    const idx = buildModelCostIndex(sync().data.message)
    if (idx.size === 0) return undefined
    const map = new Map<string, { cost: number; count: number }>()
    for (const [k, entry] of idx.entries()) map.set(k, { cost: entry.sum / entry.count, count: entry.count })
    return map
  })
  const pricingFallback = createMemo(() => {
    const map = buildPricingFallbackMap(all() as never)
    return map.size > 0 ? map : undefined
  })
  const personalFallback = createMemo(() => {
    const p = personalCosts()
    if (!p) return undefined
    const map = buildPersonalFallbackMap(p)
    return map.size > 0 ? map : undefined
  })

  const filtered = createMemo(() => {
    const query = search().trim().toLowerCase()
    let list = all()
    if (query) list = list.filter((item) => matchesModelSearch(query, [item.name, item.id, item.provider.name]))
    const key = sortKey()
    const pCosts = personalCosts()
    const priceFallback = pricingFallback()
    const pFallback = personalFallback()
    return [...list].sort((a, b) => {
      if (key === "name") return a.name.localeCompare(b.name)
      if (key === "context")
        return b.limit.context - a.limit.context || compareByCheapness(a as never, b as never, undefined, undefined, pCosts as never, priceFallback as never, pFallback as never)
      return compareByCheapness(a as never, b as never, undefined, undefined, pCosts as never, priceFallback as never, pFallback as never)
    })
  })

  // Cheapest provider per distinct model id (the selector can host the same
  // model under several providers; this surfaces the cheapest inference path).
  // Uses Usage Yield V2 (workload-normalized, §5-6) blended heavily with
  // personal measured yield (§31) plus cross-provider pricing/usage fallbacks
  // so the "cheapest" badge reflects your actual usage, not just headline input rates.
  const cheapestByModel = createMemo(() => {
    const map = new Map<string, ModelItem[]>()
    for (const item of all()) map.set(item.id, [...(map.get(item.id) ?? []), item])
    const pCosts = personalCosts()
    const priceFallback = pricingFallback()
    const pFallback = personalFallback()
    return [...map.values()]
      .map((group) => [...group].sort((a, b) => compareByCheapness(a as never, b as never, undefined, undefined, pCosts as never, priceFallback as never, pFallback as never)))
      .sort((a, b) => compareByCheapness(a[0] as never, b[0] as never, undefined, undefined, pCosts as never, priceFallback as never, pFallback as never))
      .slice(0, 6)
  })

  const activeModel = createMemo(() => selected() ?? filtered()[0])

  const [telemetry] = createResource(
    () => {
      const item = activeModel()
      if (!item) return undefined
      return item.id
    },
    async (modelID) => {
      try {
        const response = await sdk().client.experimental.openrouterEndpoints.get(
          { model: modelID },
          { throwOnError: true },
        )
        return response.data.map((entry) => ({
          provider_name: entry.providerName,
          uptime_last_30m: entry.uptime,
        })) as EndpointTelemetry[]
      } catch {
        return null
      }
    },
  )
  const telemetryData = () => {
    if (telemetry.state !== "ready" && telemetry.state !== "refreshing") return undefined
    return telemetry.latest
  }
  const hasTelemetry = () => {
    const data = telemetryData()
    return !!data && data.length > 0
  }
  const telemetryEmpty = () => {
    const data = telemetryData()
    return data !== undefined && data !== null && data.length === 0
  }

  const bestP50 = () => {
    const list = telemetryData()
    if (!list || list.length === 0) return undefined
    return Math.max(...list.map((e) => e.throughput_last_30m?.p50 ?? 0))
  }

  const isCheapestForModel = (item: ModelItem) => {
    const group = cheapestByModel().find((g) => g[0].id === item.id)
    return group ? group[0].providerID === item.provider.id && group[0].id === item.id : false
  }

  const sortOptions: { key: SortKey; labelKey: string }[] = [
    { key: "cost", labelKey: "models.compare.sort.cheapest" },
    { key: "context", labelKey: "models.compare.sort.context" },
    { key: "name", labelKey: "models.compare.sort.name" },
  ]

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="shrink-0 border-b border-v2-border-border-muted p-2">
        <div class="relative">
          <TextInputV2
            type="search"
            appearance="base"
            class="!w-full self-stretch"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("dialog.model.search.placeholder")}
          />
          <Show when={search()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-v2-tab-search-clear"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => setSearch("")}
              aria-label={language.t("common.clear")}
            />
          </Show>
        </div>
        <div class="mt-1.5 flex items-center gap-1">
          <For each={sortOptions}>
            {(option) => (
              <button
                type="button"
                class="h-6 rounded-md px-2 text-[10px] font-[520] leading-6"
                classList={{
                  "bg-v2-background-bg-layer-03 text-v2-text-text-base": sortKey() === option.key,
                  "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover": sortKey() !== option.key,
                }}
                onClick={() => setSortKey(option.key)}
              >
                {language.t(option.labelKey)}
              </button>
            )}
          </For>
        </div>
      </div>

      <ScrollView class="min-h-0 flex-1">
        <ErrorBoundary
          fallback={(error) => (
            <div class="flex flex-col gap-1 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-3 py-4 text-center">
              <span class="text-[10px] font-[600] uppercase leading-3 tracking-[0.02em] text-v2-state-fg-danger">
                {language.t("usage.error")}
              </span>
              <span class="text-[10px] font-[440] leading-3 text-v2-text-text-faint">
                {error instanceof Error ? error.message : String(error)}
              </span>
            </div>
          )}
        >
          <div class="flex flex-col gap-4 p-3">
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
            <Show when={cheapestByModel().length > 0} fallback={<EmptyState />}>
              <Section title={language.t("models.compare.cheapest.title")}>
                <div class="grid grid-cols-2 gap-1.5">
                  <For each={cheapestByModel()}>
                    {(group) => (
                      <button
                        type="button"
                        class="flex min-w-0 items-center gap-2 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1.5 text-left"
                        classList={{ "border-v2-state-border-success": activeModel()?.id === group[0].id }}
                        onClick={() => setSelected(group[0])}
                      >
                        <ProviderIcon id={group[0].provider.id} class="size-3.5 shrink-0 opacity-70" />
                        <span
                          class="min-w-0 flex-1 truncate text-[10px] font-[520] leading-3.5 text-v2-text-text-base"
                          title={group[0].name}
                        >
                          {group[0].name}
                        </span>
                        <span class="shrink-0 text-[10px] font-[560] tabular-nums text-v2-text-text-accent">
                          {formatCost(blended(group[0]))}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Section>

              <Section title={language.t("models.compare.table.title")}>
                <div class="flex flex-col overflow-hidden rounded-md border border-v2-border-border-muted">
                  <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_48px_56px_56px_56px_64px] gap-1 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1 text-[8px] font-[600] uppercase leading-3 tracking-[0.03em] text-v2-text-text-faint">
                    <span>{language.t("models.compare.table.model")}</span>
                    <span>{language.t("models.compare.table.provider")}</span>
                    <span class="text-right">{language.t("models.compare.table.context")}</span>
                    <span class="text-right">{language.t("models.compare.table.input")}</span>
                    <span class="text-right">{language.t("models.compare.table.output")}</span>
                    <span class="text-right">{language.t("models.compare.table.cacheRead")}</span>
                    <span class="text-right">{language.t("models.compare.table.blended")}</span>
                  </div>
                  <For each={filtered()}>
                    {(item) => (
                      <button
                        type="button"
                        class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_48px_56px_56px_56px_64px] items-center gap-1 border-b border-v2-border-border-muted px-2 py-1 text-left last:border-0 hover:bg-v2-overlay-simple-overlay-hover"
                        classList={{ "bg-v2-background-bg-layer-02": activeModel()?.id === item.id }}
                        onClick={() => setSelected(item)}
                      >
                        <span class="flex min-w-0 items-center gap-1.5">
                          <ProviderIcon id={item.provider.id} class="size-3 shrink-0 opacity-70" />
                          <span
                            class="min-w-0 truncate text-[10px] font-[480] leading-3.5 text-v2-text-text-base"
                            title={item.name}
                          >
                            {item.name}
                          </span>
                          <Show when={isCheapestForModel(item)}>
                            <span class="shrink-0 rounded-sm bg-v2-state-bg-success px-1 text-[8px] font-[600] uppercase text-v2-state-fg-success">
                              {language.t("models.compare.badge.cheapest")}
                            </span>
                          </Show>
                        </span>
                        <span class="truncate text-[10px] font-[440] text-v2-text-text-muted">
                          {item.provider.name}
                        </span>
                        <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
                          {formatCompact(item.limit.context)}
                        </span>
                        <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
                          {formatCost(item.cost.input)}
                        </span>
                        <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
                          {formatCost(item.cost.output)}
                        </span>
                        <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
                          {formatCost(item.cost.cache.read)}
                        </span>
                        <span class="text-right text-[10px] font-[560] tabular-nums text-v2-text-text-base">
                          {formatCost(blended(item))}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Section>

              <Section title={language.t("models.compare.telemetry.title")}>
                <Switch>
                  <Match when={telemetry.loading}>
                    <div class="py-3 text-center text-[10px] font-[440] text-v2-text-text-faint">
                      {language.t("common.loading")}
                    </div>
                  </Match>
                  <Match when={hasTelemetry()}>
                    <div class="flex flex-col overflow-hidden rounded-md border border-v2-border-border-muted">
                      <div class="grid grid-cols-[minmax(0,1fr)_56px_56px_52px] items-center gap-1 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1 text-[8px] font-[600] uppercase leading-3 tracking-[0.03em] text-v2-text-text-faint">
                        <span>{language.t("models.compare.telemetry.provider")}</span>
                        <span class="text-right">{language.t("models.compare.telemetry.tokps")}</span>
                        <span class="text-right">{language.t("models.compare.telemetry.latency")}</span>
                        <span class="text-right">{language.t("models.compare.telemetry.uptime")}</span>
                      </div>
                      <For
                        each={[...telemetryData()!].sort(
                          (a, b) => (b.throughput_last_30m?.p50 ?? 0) - (a.throughput_last_30m?.p50 ?? 0),
                        )}
                      >
                        {(endpoint) => <TelemetryRow endpoint={endpoint} />}
                      </For>
                    </div>
                    <Show when={bestP50() !== undefined}>
                      <div class="text-[10px] font-[520] text-v2-text-text-accent">
                        {language.t("models.compare.telemetry.best", { value: formatCompact(bestP50()!) })}
                      </div>
                    </Show>
                  </Match>
                  <Match when={telemetryEmpty()}>
                    <div class="py-3 text-center text-[10px] font-[440] text-v2-text-text-faint">
                      {language.t("models.compare.telemetry.empty")}
                    </div>
                  </Match>
                  <Match when={true}>
                    <div class="flex items-center gap-1.5 py-3 text-[10px] font-[440] text-v2-text-text-faint">
                      <IconV2 name="outline-share" size="small" />
                      {language.t("models.compare.telemetry.unavailable")}
                    </div>
                  </Match>
                </Switch>
              </Section>

              <div class="pt-1 text-[9px] font-[440] leading-3 text-v2-text-text-faint">
                {language.t("models.compare.pricingNote")}
              </div>
            </Show>
          </div>
        </ErrorBoundary>
      </ScrollView>
    </div>
  )
}

function formatCost(value: number) {
  if (value === 0) return "free"
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value)
}

function EmptyState() {
  const language = useLanguage()
  return (
    <div class="py-8 text-center text-[10px] font-[440] text-v2-text-text-faint">
      {language.t("dialog.model.empty")}
    </div>
  )
}
