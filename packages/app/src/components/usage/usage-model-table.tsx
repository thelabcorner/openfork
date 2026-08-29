import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { formatNumber, formatTokens, formatTokensExact, formatUSD, formatUSDCompact } from "./usage-format"
import { UsageTooltipContent } from "./usage-chart"
import { SortHeader } from "./usage-table"
import { createColumnSort } from "./usage-sort"
import type { ModelGroup, TokenBreakdown } from "./usage-model-groups"
import type { modelsForProvider } from "./usage-model-groups"

const GROUPED_GRID = "grid-cols-[14px_minmax(0,1fr)_44px_56px_64px_36px]"
const FLAT_GRID = "grid-cols-[minmax(0,1fr)_44px_56px_64px_36px]"

type SortColumn = "model" | "requests" | "cost" | "tokens" | "share"

/** $/1M tokens — a blended rate useful for comparing cost-efficiency across models. */
const blendedRate = (cost: number, tokens: number) => (tokens > 0 ? (cost / tokens) * 1_000_000 : 0)

function tokenBreakdownRows(language: ReturnType<typeof useLanguage>, breakdown: TokenBreakdown, cost: number, tokens: number) {
  return [
    { label: language.t("usage.table.inputTokens"), value: formatTokensExact(breakdown.input, language.intl()) },
    { label: language.t("usage.table.outputTokens"), value: formatTokensExact(breakdown.output, language.intl()) },
    { label: language.t("usage.table.cacheReadTokens"), value: formatTokensExact(breakdown.cacheRead, language.intl()) },
    { label: language.t("usage.table.cacheWriteTokens"), value: formatTokensExact(breakdown.cacheWrite, language.intl()) },
    { label: language.t("usage.table.reasoningTokens"), value: formatTokensExact(breakdown.reasoning, language.intl()) },
    { label: language.t("usage.table.rate"), value: formatUSD(blendedRate(cost, tokens), language.intl()) },
  ]
}

/**
 * Every unique model name gets exactly one row here, however many
 * provider/variant combinations fed it — no top-N cutoff, since a model with
 * real usage split across several providers is exactly the case a truncated
 * list would hide. A filter box is offered once the list is long enough that
 * scanning it stops being the fastest way to find one model.
 */
export function UsageModelTable(props: { groups: ModelGroup[]; metric?: "cost" | "tokens" }) {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const sort = createColumnSort<ModelGroup, SortColumn>(props.metric === "tokens" ? "tokens" : "cost", (group, column) => {
    switch (column) {
      case "model":
        return group.modelID
      case "requests":
        return group.messages
      case "cost":
        return group.cost
      case "tokens":
        return group.tokens
      case "share":
        return group.share
    }
  })
  createEffect(() => sort.syncDefault(props.metric === "tokens" ? "tokens" : "cost"))

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return props.groups
    return props.groups.filter(
      (group) =>
        group.modelID.toLowerCase().includes(q) ||
        group.providers.some((entry) => entry.providerID.toLowerCase().includes(q) || entry.modelID.toLowerCase().includes(q)),
    )
  })
  const sorted = createMemo(() => sort.sort(filtered()))

  const toggle = (modelID: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(modelID)) next.delete(modelID)
      else next.add(modelID)
      return next
    })
  }

  return (
    <div class="flex flex-col gap-1.5">
      <Show when={props.groups.length > 6}>
        <input
          type="text"
          placeholder={language.t("usage.models.search")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          class="h-6 rounded-md border-0 bg-v2-background-bg-layer-02 px-2 text-[10px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
        />
      </Show>
      <div class="flex flex-col overflow-hidden rounded-md border border-v2-border-border-muted">
        <div class={`grid ${GROUPED_GRID} items-center gap-1 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1`}>
          <span />
          <SortHeader label={language.t("usage.table.model")} column="model" active={sort.column()} direction={sort.direction()} onClick={sort.toggle} />
          <SortHeader label={language.t("usage.table.requests")} column="requests" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
          <SortHeader label={language.t("usage.table.cost")} column="cost" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
          <SortHeader label={language.t("usage.table.tokens")} column="tokens" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
          <SortHeader label={language.t("usage.table.share")} column="share" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        </div>
        <Show
          when={sorted().length > 0}
          fallback={
            <div class="px-2 py-3 text-center text-[10px] font-[440] text-v2-text-text-faint">
              {language.t("usage.models.empty")}
            </div>
          }
        >
          <For each={sorted()}>
            {(group) => {
              const isOpen = () => expanded().has(group.modelID)
              return (
                <div class="border-b border-v2-border-border-muted last:border-0">
                  <TooltipV2
                    placement="right"
                    value={
                      <UsageTooltipContent
                        title={group.modelID}
                        rows={[
                          { label: language.t("usage.table.requests"), value: formatNumber(group.messages, language.intl()) },
                          { label: language.t("usage.metric.cost"), value: formatUSD(group.cost, language.intl()) },
                          { label: language.t("usage.metric.tokens"), value: formatTokensExact(group.tokens, language.intl()) },
                          { label: language.t("usage.table.share"), value: `${Math.round(group.share * 100)}%` },
                          { label: language.t("usage.metric.cacheSavings"), value: formatUSD(group.cacheSavings, language.intl()) },
                          ...tokenBreakdownRows(language, group.tokenBreakdown, group.cost, group.tokens),
                        ]}
                      />
                    }
                  >
                    <button
                      type="button"
                      class={`grid w-full ${GROUPED_GRID} items-center gap-1 px-2 py-1 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover`}
                      onClick={() => toggle(group.modelID)}
                      aria-expanded={isOpen()}
                    >
                      <Icon
                        name="outline-chevron-down"
                        size="small"
                        class="shrink-0 text-v2-text-text-faint transition-transform"
                        classList={{ "-rotate-90": !isOpen() }}
                      />
                      <span class="flex min-w-0 items-center gap-1 truncate text-[10px] font-[480] leading-3.5 text-v2-text-text-base">
                        <span class="min-w-0 truncate">{group.modelID}</span>
                        <Show when={group.providerCount > 1}>
                          <span class="shrink-0 rounded-sm bg-v2-background-bg-layer-03 px-1 text-[8px] font-[520] leading-3.5 text-v2-text-text-muted">
                            {group.providerCount}×
                          </span>
                        </Show>
                      </span>
                      <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
                        {formatNumber(group.messages, language.intl())}
                      </span>
                      <span class="text-right text-[10px] font-[520] tabular-nums text-v2-text-text-base">
                        {formatUSDCompact(group.cost, language.intl())}
                      </span>
                      <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
                        {formatTokens(group.tokens, language.intl())}
                      </span>
                      <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-faint">
                        {Math.round(group.share * 100)}%
                      </span>
                    </button>
                  </TooltipV2>
                  <Show when={isOpen()}>
                    <div class="flex flex-col gap-1 bg-v2-background-bg-layer-01 py-1 pl-[30px] pr-2">
                      <For each={group.providers}>
                        {(entry) => (
                          <div class="flex items-center justify-between gap-2 text-[9px] font-[440] leading-3.5 text-v2-text-text-muted">
                            <span class="flex min-w-0 items-center gap-1 truncate">
                              <ProviderIcon id={entry.providerID} class="size-2.5 shrink-0 opacity-60" />
                              <span class="min-w-0 truncate">{entry.providerID}</span>
                              {/* The group can now merge providers that route the same model under different id strings
                                  (e.g. a direct API vs. an OpenRouter `vendor/model-id`) — surface the raw id whenever it
                                  differs from the group's canonical label, so "why is this here" is never a mystery. */}
                              <Show when={entry.modelID !== group.modelID}>
                                <span class="min-w-0 truncate text-v2-text-text-faint">({entry.modelID})</span>
                              </Show>
                              <Show when={entry.variant}>
                                <span class="shrink-0 rounded-sm bg-v2-background-bg-layer-03 px-1 text-[8px] uppercase leading-3.5 text-v2-text-text-faint">
                                  {entry.variant}
                                </span>
                              </Show>
                            </span>
                            <span class="shrink-0 tabular-nums text-v2-text-text-faint">
                              {formatUSDCompact(entry.cost, language.intl())} · {Math.round(entry.share * 100)}%
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
      </div>
    </div>
  )
}

/** A single provider's own models — already scoped, so a flat (non-grouped) table. */
export function UsageProviderModelTable(props: { rows: ReturnType<typeof modelsForProvider>; metric?: "cost" | "tokens" }) {
  const language = useLanguage()
  type ProviderModelRow = ReturnType<typeof modelsForProvider>[number]
  const sort = createColumnSort<ProviderModelRow, SortColumn>(props.metric === "tokens" ? "tokens" : "cost", (row, column) => {
    switch (column) {
      case "model":
        return row.modelID
      case "requests":
        return row.messages
      case "cost":
        return row.cost
      case "tokens":
        return row.tokens
      case "share":
        return row.share
    }
  })
  createEffect(() => sort.syncDefault(props.metric === "tokens" ? "tokens" : "cost"))
  const sorted = createMemo(() => sort.sort(props.rows))

  return (
    <div class="flex flex-col overflow-hidden rounded-md border border-v2-border-border-muted">
      <div class={`grid ${FLAT_GRID} items-center gap-1 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1`}>
        <SortHeader label={language.t("usage.table.model")} column="model" active={sort.column()} direction={sort.direction()} onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.requests")} column="requests" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.cost")} column="cost" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.tokens")} column="tokens" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.share")} column="share" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
      </div>
      <Show
        when={sorted().length > 0}
        fallback={
          <div class="px-2 py-3 text-center text-[10px] font-[440] text-v2-text-text-faint">
            {language.t("usage.models.empty")}
          </div>
        }
      >
        <For each={sorted()}>
          {(row) => (
            <TooltipV2
              placement="right"
              value={
                <UsageTooltipContent
                  title={row.modelID}
                  rows={[
                    { label: language.t("usage.table.requests"), value: formatNumber(row.messages, language.intl()) },
                    { label: language.t("usage.metric.cost"), value: formatUSD(row.cost, language.intl()) },
                    { label: language.t("usage.metric.tokens"), value: formatTokensExact(row.tokens, language.intl()) },
                    { label: language.t("usage.table.share"), value: `${Math.round(row.share * 100)}%` },
                    { label: language.t("usage.metric.cacheSavings"), value: formatUSD(row.cacheSavings, language.intl()) },
                    ...tokenBreakdownRows(language, row.tokenBreakdown, row.cost, row.tokens),
                  ]}
                />
              }
            >
              <div class={`grid ${FLAT_GRID} items-center gap-1 border-b border-v2-border-border-muted px-2 py-1 last:border-0`}>
                <span class="min-w-0 truncate text-[10px] font-[480] leading-3.5 text-v2-text-text-base">
                  {row.modelID}
                  <Show when={row.variant}>
                    <span class="ml-1 rounded-sm bg-v2-background-bg-layer-03 px-1 text-[8px] font-[520] uppercase leading-3.5 text-v2-text-text-muted">
                      {row.variant}
                    </span>
                  </Show>
                </span>
                <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
                  {formatNumber(row.messages, language.intl())}
                </span>
                <span class="text-right text-[10px] font-[520] tabular-nums text-v2-text-text-base">
                  {formatUSDCompact(row.cost, language.intl())}
                </span>
                <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-muted">
                  {formatTokens(row.tokens, language.intl())}
                </span>
                <span class="text-right text-[10px] font-[440] tabular-nums text-v2-text-text-faint">
                  {Math.round(row.share * 100)}%
                </span>
              </div>
            </TooltipV2>
          )}
        </For>
      </Show>
    </div>
  )
}
