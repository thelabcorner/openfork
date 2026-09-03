import { createMemo, createSignal, For, Show } from "solid-js"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useLanguage } from "@/context/language"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import {
  formatNumber,
  formatPercent,
  formatTokens,
  formatTokensExact,
  formatTokensPerSecond,
  formatUSD,
  formatUSDCompact,
} from "@/components/usage/usage-format"
import type { ModelGroup, TokenBreakdown } from "@/components/usage/usage-model-groups"
import { SortHeader } from "@/components/usage/usage-table"
import { createColumnSort } from "@/components/usage/usage-sort"
import { sortByCheapness, type CheapnessModel } from "@/utils/model-cost"
import type { UsageValuation } from "./use-usage-valuation"
import { DetailRows, EmptyLine, Panel, RankRow, RuleGrid, Stat } from "./usage-page-primitives"

/**
 * The Models section, rebuilt as one instrument rather than three unrelated
 * cards stacked down the page (a cheap/expensive list, a fast/slow list, and a
 * separate breakdown table that repeated most of both).
 *
 * The shape is: a portfolio summary, then three leaderboards that each answer
 * one question about the models you actually used — where the money went,
 * which were the best deals, which were quickest — and then one table that
 * carries every model with every metric, sortable. Nothing is duplicated
 * between them: the leaderboards are the headline, the table is the detail.
 *
 * "Best value" ranks with `sortByCheapness`, the exact function the model
 * picker dialog uses, so the two surfaces can never disagree about what is
 * cheap — including for free-tier models, which rank by their inferred sibling
 * price rather than alphabetically.
 */
const LEADERBOARD_SIZE = 5

const TABLE_GRID = "grid-cols-[minmax(0,1fr)_50px_60px_68px_68px_62px_54px_46px]"

const tokensPerSecond = (breakdown: TokenBreakdown, durationMs: number) =>
  durationMs > 0 ? ((breakdown.output + breakdown.reasoning) / durationMs) * 1000 : 0

const cacheHitRateOf = (breakdown: TokenBreakdown) => {
  const denominator = breakdown.input + breakdown.cacheRead
  return denominator > 0 ? breakdown.cacheRead / denominator : 0
}

/** A model group joined to everything the valuation pass knows about it. */
type ModelRow = {
  group: ModelGroup
  /** The provider that served most of this model's spend — the identity used for pricing. */
  primaryProviderID: string
  primaryModelID: string
  /** Inferred or published $/1M for a 1:1 input/output mix; 0 when unpriceable. */
  ratePerMillion: number
  rateInferred: boolean
  /** USD value of this model's $0 usage in the window. */
  freeValue: number
  throughput: number
  cacheHitRate: number
}

export function UsagePageModels(props: {
  data: UsageSummaryResponse
  modelGroups: ModelGroup[]
  valuation: UsageValuation
  providerName: (id: string) => string
}) {
  const language = useLanguage()

  // Subsidy is reported per (provider, model, variant) usage row; a group can
  // span several of those, so roll them back up on the group's own provider
  // entries rather than re-deriving the valuation per row.
  const freeValueByKey = createMemo(() => {
    const map = new Map<string, number>()
    for (const row of props.valuation.subsidy().rows) map.set(row.key, row.value)
    return map
  })

  const rows = createMemo<ModelRow[]>(() => {
    const free = freeValueByKey()
    return props.modelGroups.map((group) => {
      const primary = group.providers[0]
      const providerID = primary?.providerID ?? "unknown"
      const modelID = primary?.modelID ?? group.modelID
      const effective = props.valuation.effectiveCostFor(providerID, modelID)
      const freeValue = group.providers.reduce(
        (sum, entry) => sum + (free.get(`${entry.providerID}:${entry.modelID} ${entry.variant ?? ""}`) ?? 0),
        0,
      )
      return {
        group,
        primaryProviderID: providerID,
        primaryModelID: modelID,
        ratePerMillion: effective.cost.input + effective.cost.output,
        rateInferred: effective.borrowed,
        freeValue,
        throughput: tokensPerSecond(group.tokenBreakdown, group.durationMs),
        cacheHitRate: cacheHitRateOf(group.tokenBreakdown),
      }
    })
  })

  const spend = createMemo(() => rows().reduce((sum, row) => sum + row.group.cost, 0))
  const providerCount = createMemo(() => new Set(props.data.models.map((model) => model.providerID)).size)
  const paidTokens = createMemo(() =>
    rows().reduce((sum, row) => (row.group.cost > 0 ? sum + row.group.tokens : sum), 0),
  )
  const blendedPaidRate = createMemo(() => (paidTokens() > 0 ? (spend() / paidTokens()) * 1_000_000 : 0))

  const topSpend = createMemo(() =>
    [...rows()].filter((row) => row.group.cost > 0).sort((a, b) => b.group.cost - a.group.cost).slice(0, LEADERBOARD_SIZE),
  )
  const topFree = createMemo(() =>
    [...rows()].filter((row) => row.freeValue > 0).sort((a, b) => b.freeValue - a.freeValue).slice(0, LEADERBOARD_SIZE),
  )
  const fastest = createMemo(() =>
    [...rows()]
      .filter((row) => row.group.durationRecords > 0 && row.throughput > 0)
      .sort((a, b) => b.throughput - a.throughput)
      .slice(0, LEADERBOARD_SIZE),
  )

  // Ranked by the shared cheapness engine, over the models actually used.
  const bestValue = createMemo(() => {
    const byKey = new Map(rows().map((row) => [`${row.primaryProviderID}:${row.primaryModelID}`, row]))
    const candidates: CheapnessModel[] = rows().map((row) => {
      const catalog = props.valuation.catalogByKey().get(`${row.primaryProviderID}:${row.primaryModelID}`)
      return (
        catalog ?? {
          id: row.primaryModelID,
          name: row.group.modelID,
          provider: { id: row.primaryProviderID },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        }
      )
    })
    return sortByCheapness(candidates, undefined, undefined, undefined, props.valuation.mergedFallback())
      .map((model) => byKey.get(`${model.provider.id}:${model.id}`))
      .filter((row): row is ModelRow => !!row)
      .slice(0, LEADERBOARD_SIZE)
  })

  return (
    <div class="flex flex-col gap-3">
      <Panel title={language.t("usage.section.portfolio")} flush>
        <RuleGrid class="grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
          <Stat label={language.t("usage.models.count")} value={formatNumber(rows().length, language.intl())} size="lg" />
          <Stat label={language.t("usage.section.providers")} value={formatNumber(providerCount(), language.intl())} />
          <Stat label={language.t("usage.metric.spend")} value={formatUSD(spend(), language.intl())} />
          <Stat
            label={language.t("usage.metric.freeValue")}
            value={formatUSD(props.valuation.subsidy().total, language.intl())}
            tone="credit"
          />
          <Stat
            label={language.t("usage.models.blendedRate")}
            value={`${formatUSDCompact(blendedPaidRate(), language.intl())}/M`}
            sub={language.t("usage.models.blendedRateSub")}
          />
        </RuleGrid>
      </Panel>

      <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Leaderboard
          title={language.t("usage.models.topSpend")}
          rows={topSpend()}
          weight={(row) => row.group.cost}
          display={(row) => formatUSDCompact(row.group.cost, language.intl())}
          emptyLabel={language.t("usage.models.empty")}
        />
        <Leaderboard
          title={language.t("usage.models.topFree")}
          rows={topFree()}
          weight={(row) => row.freeValue}
          display={(row) => formatUSDCompact(row.freeValue, language.intl())}
          tone="credit"
          emptyLabel={language.t("usage.subsidy.empty")}
        />
        <Leaderboard
          title={language.t("usage.models.bestValue")}
          tooltip={language.t("usage.models.bestValueHelp")}
          // Rank order carries the meaning here, not magnitude — a uniform bar
          // would imply the top model is 5x the value of the fifth, which the
          // cheapness engine does not claim. Fill by inverse rank instead.
          rows={bestValue()}
          weight={(_row, index, total) => (total - index) / total}
          normalized
          display={(row) =>
            row.ratePerMillion > 0
              ? `${row.rateInferred ? "~" : ""}${formatUSDCompact(row.ratePerMillion, language.intl())}/M`
              : language.t("model.tag.free")
          }
          emptyLabel={language.t("usage.valuation.empty")}
        />
        <Leaderboard
          title={language.t("usage.models.fastest")}
          rows={fastest()}
          weight={(row) => row.throughput}
          display={(row) => formatTokensPerSecond(row.throughput, language.intl())}
          emptyLabel={language.t("usage.throughput.empty")}
        />
      </div>

      <UsageModelsTable rows={rows()} />

      <UsageProvidersPanel data={props.data} providerName={props.providerName} />
    </div>
  )
}

/** Provider-level roll-up. The hero's provider bars answer "who got the
 * money"; this answers the operational half of the same question — how much
 * work each provider did and how fast it did it — which the per-model table
 * cannot show once a model spans several providers. */
function UsageProvidersPanel(props: { data: UsageSummaryResponse; providerName: (id: string) => string }) {
  const language = useLanguage()

  const rows = createMemo(() => {
    const list = props.data.providers.map((provider) => {
      const tokens =
        provider.tokens.input +
        provider.tokens.cacheRead +
        provider.tokens.cacheWrite +
        provider.tokens.output +
        provider.tokens.reasoning
      return {
        id: provider.providerID,
        cost: provider.cost + provider.estimatedCost,
        tokens,
        messages: provider.messages,
        sessions: provider.sessions,
        throughput:
          provider.durationMs > 0
            ? ((provider.tokens.output + provider.tokens.reasoning) / provider.durationMs) * 1000
            : 0,
        durationRecords: provider.durationRecords,
      }
    })
    return list.sort((a, b) => b.tokens - a.tokens)
  })
  const max = createMemo(() => Math.max(...rows().map((row) => row.tokens), 0))

  return (
    <Panel title={language.t("usage.section.providers")}>
      <Show when={rows().length > 0} fallback={<EmptyLine>{language.t("usage.models.empty")}</EmptyLine>}>
        <div class="flex flex-col gap-0.5">
          <For each={rows()}>
            {(row) => (
              <RankRow
                leading={<ProviderIcon id={row.id} class="size-3 shrink-0 opacity-50" />}
                label={props.providerName(row.id)}
                detail={row.durationRecords > 0 ? formatTokensPerSecond(row.throughput, language.intl()) : undefined}
                fraction={max() > 0 ? row.tokens / max() : 0}
                value={formatTokens(row.tokens, language.intl())}
                tooltip={
                  <DetailRows
                    title={props.providerName(row.id)}
                    rows={[
                      { label: language.t("usage.metric.cost"), value: formatUSD(row.cost, language.intl()) },
                      { label: language.t("usage.metric.tokens"), value: formatTokens(row.tokens, language.intl()) },
                      { label: language.t("usage.table.turns"), value: formatNumber(row.messages, language.intl()) },
                      { label: language.t("usage.table.sessions"), value: formatNumber(row.sessions, language.intl()) },
                      ...(row.durationRecords > 0
                        ? [
                            {
                              label: language.t("usage.metric.tokensPerSecond"),
                              value: formatTokensPerSecond(row.throughput, language.intl()),
                            },
                          ]
                        : []),
                    ]}
                  />
                }
              />
            )}
          </For>
        </div>
      </Show>
    </Panel>
  )
}

function Leaderboard(props: {
  title: string
  tooltip?: string
  rows: ModelRow[]
  weight: (row: ModelRow, index: number, total: number) => number
  /** `weight` already returns a 0..1 fraction; skip max-normalisation. */
  normalized?: boolean
  display: (row: ModelRow) => string
  tone?: "default" | "credit"
  emptyLabel: string
}) {
  const language = useLanguage()
  const max = createMemo(() =>
    props.normalized ? 1 : Math.max(...props.rows.map((row, index) => props.weight(row, index, props.rows.length)), 0),
  )

  return (
    <Panel title={props.title} tooltip={props.tooltip}>
      <Show when={props.rows.length > 0} fallback={<EmptyLine>{props.emptyLabel}</EmptyLine>}>
        <div class="flex flex-col gap-0.5">
          <For each={props.rows}>
            {(row, index) => (
              <RankRow
                leading={<ProviderIcon id={row.primaryProviderID} class="size-3 shrink-0 opacity-50" />}
                label={row.group.modelID}
                detail={row.group.providerCount > 1 ? `×${row.group.providerCount}` : undefined}
                fraction={max() > 0 ? props.weight(row, index(), props.rows.length) / max() : 0}
                value={props.display(row)}
                tone={props.tone}
                tooltip={<ModelDetail row={row} />}
              />
            )}
          </For>
        </div>
      </Show>
    </Panel>
  )
}

function ModelDetail(props: { row: ModelRow }) {
  const language = useLanguage()
  const row = () => props.row
  const breakdown = () => row().group.tokenBreakdown
  return (
    <DetailRows
      title={row().group.modelID}
      rows={[
        { label: language.t("usage.table.provider"), value: row().group.providers.map((entry) => entry.providerID).join(", ") },
        { label: language.t("usage.table.requests"), value: formatNumber(row().group.messages, language.intl()) },
        { label: language.t("usage.metric.cost"), value: formatUSD(row().group.cost, language.intl()) },
        ...(row().freeValue > 0
          ? [{ label: language.t("usage.metric.freeValue"), value: formatUSD(row().freeValue, language.intl()) }]
          : []),
        {
          label: language.t("usage.table.rate"),
          value:
            row().ratePerMillion > 0
              ? `${row().rateInferred ? "~" : ""}${formatUSD(row().ratePerMillion, language.intl())}`
              : "—",
        },
        { label: language.t("usage.table.inputTokens"), value: formatTokensExact(breakdown().input, language.intl()) },
        { label: language.t("usage.table.outputTokens"), value: formatTokensExact(breakdown().output, language.intl()) },
        { label: language.t("usage.table.cacheReadTokens"), value: formatTokensExact(breakdown().cacheRead, language.intl()) },
        { label: language.t("usage.metric.cacheHitRate"), value: formatPercent(row().cacheHitRate, language.intl()) },
        ...(row().group.durationRecords > 0
          ? [{ label: language.t("usage.metric.tokensPerSecond"), value: formatTokensPerSecond(row().throughput, language.intl()) }]
          : []),
      ]}
    />
  )
}

type SortColumn = "model" | "requests" | "tokens" | "cost" | "free" | "rate" | "throughput" | "cache"

/** Every model, every metric, one row each — the detail layer under the
 * leaderboards. Provider/variant splits stay reachable through the row tooltip
 * so a model that ran on three providers is still one comparable line. */
function UsageModelsTable(props: { rows: ModelRow[] }) {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")

  const sort = createColumnSort<ModelRow, SortColumn>("cost", (row, column) => {
    switch (column) {
      case "model":
        return row.group.modelID
      case "requests":
        return row.group.messages
      case "tokens":
        return row.group.tokens
      case "cost":
        return row.group.cost
      case "free":
        return row.freeValue
      case "rate":
        return row.ratePerMillion
      case "throughput":
        return row.throughput
      case "cache":
        return row.cacheHitRate
    }
  })

  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return props.rows
    return props.rows.filter(
      (row) =>
        row.group.modelID.toLowerCase().includes(needle) ||
        row.group.providers.some(
          (entry) => entry.providerID.toLowerCase().includes(needle) || entry.modelID.toLowerCase().includes(needle),
        ),
    )
  })
  const sorted = createMemo(() => sort.sort(filtered()))

  return (
    <Panel
      title={language.t("usage.section.allModels")}
      accessory={
        <input
          type="text"
          placeholder={language.t("usage.models.search")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          class="h-5 w-40 rounded border-0 bg-[var(--usage-inset)] px-1.5 text-[10px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
        />
      }
      flush
    >
      <div class={`grid ${TABLE_GRID} items-center gap-1 border-b border-[var(--usage-line)] bg-[var(--usage-inset)] px-3 py-1.5`}>
        <SortHeader label={language.t("usage.table.model")} column="model" active={sort.column()} direction={sort.direction()} onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.requests")} column="requests" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.tokens")} column="tokens" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.cost")} column="cost" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.freeValue")} column="free" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.rate")} column="rate" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.throughput")} column="throughput" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.cacheHitRate")} column="cache" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
      </div>
      <Show when={sorted().length > 0} fallback={<EmptyLine>{language.t("usage.models.empty")}</EmptyLine>}>
        <div class="flex flex-col">
          <For each={sorted()}>
            {(row) => <ModelTableRow row={row} />}
          </For>
        </div>
      </Show>
    </Panel>
  )
}

function ModelTableRow(props: { row: ModelRow }) {
  const language = useLanguage()
  const row = () => props.row
  return (
    <div
      class={`grid ${TABLE_GRID} items-center gap-1 border-b border-[var(--usage-line)] px-3 py-1.5 last:border-0 hover:bg-[var(--usage-hover)]`}
    >
      <div class="flex min-w-0 items-center gap-1.5">
        <ProviderIcon id={row().primaryProviderID} class="size-3 shrink-0 opacity-50" />
        <span class="min-w-0 truncate text-[10px] font-[480] leading-4 text-v2-text-text-base">{row().group.modelID}</span>
        <Show when={row().group.providerCount > 1}>
          <span class="shrink-0 text-[9px] font-[440] leading-3 text-v2-text-text-faint">×{row().group.providerCount}</span>
        </Show>
      </div>
      <Cell muted>{formatNumber(row().group.messages, language.intl())}</Cell>
      <Cell muted>{formatTokens(row().group.tokens, language.intl())}</Cell>
      <Cell>{formatUSDCompact(row().group.cost, language.intl())}</Cell>
      <Cell tone={row().freeValue > 0 ? "credit" : "faint"}>
        {row().freeValue > 0 ? formatUSDCompact(row().freeValue, language.intl()) : "—"}
      </Cell>
      <Cell muted>
        {row().ratePerMillion > 0
          ? `${row().rateInferred ? "~" : ""}${formatUSDCompact(row().ratePerMillion, language.intl())}`
          : "—"}
      </Cell>
      <Cell muted>{row().group.durationRecords > 0 ? formatNumber(row().throughput, language.intl()) : "—"}</Cell>
      <Cell muted>{formatPercent(row().cacheHitRate, language.intl())}</Cell>
    </div>
  )
}

function Cell(props: { children: import("solid-js").JSX.Element; muted?: boolean; tone?: "credit" | "faint" }) {
  return (
    <span
      class="truncate text-right text-[10px] leading-4 tabular-nums"
      classList={{
        "font-[440] text-v2-text-text-muted": !!props.muted,
        "font-[560] text-v2-text-text-base": !props.muted && !props.tone,
        "font-[560] text-[var(--usage-credit)]": props.tone === "credit",
        "font-[440] text-v2-text-text-faint": props.tone === "faint",
      }}
    >
      {props.children}
    </span>
  )
}
