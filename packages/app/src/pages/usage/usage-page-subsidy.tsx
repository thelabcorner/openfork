import { createMemo, For, Show } from "solid-js"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useLanguage } from "@/context/language"
import { formatNumber, formatPercent, formatTokens, formatUSD, formatUSDCompact } from "@/components/usage/usage-format"
import { subsidyRatePerMillion, subsidyShare, type SubsidyRow } from "@/utils/usage-subsidy"
import type { UsageValuation } from "./use-usage-valuation"
import { DetailRows, EmptyLine, Panel, RankRow, RuleGrid, Stat } from "./usage-page-primitives"

const LIST_SIZE = 8

/**
 * "What is my free usage actually worth."
 *
 * Every model that billed $0 this window is priced at the best rate the shared
 * inference chain can find for it — its own published pricing, an exact
 * model-id sibling on another provider, or a fuzzy name match to a paid
 * counterpart (the case that matters most in practice: a subsidised provider
 * serving a model whose paid twin lives elsewhere under a different id).
 *
 * Nothing here is provider- or model-specific; anything billed at $0 that can
 * be valued is valued. Rows priced from a borrowed rate carry the same "~"
 * marker the model picker uses, and free usage we could not price at all is
 * reported explicitly in the footnote rather than quietly excluded, so the
 * headline figure is never mistaken for a complete one.
 */
export function UsageSubsidyPanel(props: { valuation: UsageValuation }) {
  const language = useLanguage()
  const report = () => props.valuation.subsidy()

  const rows = createMemo(() => report().rows.slice(0, LIST_SIZE))
  const max = createMemo(() => Math.max(...rows().map((row) => row.value), 0))
  const inferredCount = createMemo(() => report().rows.filter((row) => row.source === "inferred").length)

  return (
    <Panel
      title={language.t("usage.section.subsidy")}
      tooltip={language.t("usage.subsidy.help")}
      accessory={
        <span class="text-[10px] font-[560] tabular-nums text-[var(--usage-credit)]">
          {formatUSD(report().total, language.intl())}
        </span>
      }
      flush
    >
      <RuleGrid class="grid-cols-3">
        <Stat
          label={language.t("usage.subsidy.total")}
          value={formatUSD(report().total, language.intl())}
          size="lg"
          tone="credit"
          sub={language.plural("usage.turns", report().freeMessages)}
        />
        <Stat
          label={language.t("usage.subsidy.share")}
          value={formatPercent(subsidyShare(report()), language.intl())}
          meter={subsidyShare(report())}
          tone="credit"
          sub={language.t("usage.subsidy.shareHint")}
        />
        <Stat
          label={language.t("usage.subsidy.blendedRate")}
          value={`${formatUSDCompact(subsidyRatePerMillion(report()), language.intl())}/M`}
          sub={formatTokens(report().freeTokenTotal, language.intl())}
        />
      </RuleGrid>

      <div class="border-t border-[var(--usage-line)] p-3">
        <Show
          when={rows().length > 0}
          fallback={
            <EmptyLine>
              {props.valuation.catalogReady() ? language.t("usage.subsidy.empty") : language.t("usage.valuation.noCatalog")}
            </EmptyLine>
          }
        >
          <div class="flex flex-col gap-0.5">
            <For each={rows()}>{(row) => <SubsidyRankRow row={row} max={max()} />}</For>
          </div>
        </Show>
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--usage-line)] px-3 py-2 text-[9px] font-[440] leading-3 text-v2-text-text-faint">
        <Show when={!props.valuation.catalogReady()}>
          <span>{language.t("usage.valuation.noCatalog")}</span>
        </Show>
        <Show when={inferredCount() > 0}>
          <span>
            {language.t("usage.subsidy.footnoteInferred", { count: formatNumber(inferredCount(), language.intl()) })}
          </span>
        </Show>
        <Show when={props.valuation.catalogReady() && report().unvalued.models > 0}>
          <span>
            {language.t("usage.subsidy.footnoteUnvalued", {
              models: formatNumber(report().unvalued.models, language.intl()),
              tokens: formatTokens(report().unvalued.tokens, language.intl()),
            })}
          </span>
        </Show>
      </div>
    </Panel>
  )
}

function SubsidyRankRow(props: { row: SubsidyRow; max: number }) {
  const language = useLanguage()
  const row = () => props.row
  const perMillion = () => (row().freeTokenTotal > 0 ? (row().value / row().freeTokenTotal) * 1_000_000 : 0)

  return (
    <RankRow
      leading={<ProviderIcon id={row().providerID} class="size-3 shrink-0 opacity-50" />}
      label={row().name}
      detail={row().source === "inferred" ? "~" : undefined}
      fraction={props.max > 0 ? row().value / props.max : 0}
      value={formatUSDCompact(row().value, language.intl())}
      tone="credit"
      tooltip={
        <DetailRows
          title={row().name}
          rows={[
            { label: language.t("usage.table.provider"), value: row().providerID },
            { label: language.t("usage.subsidy.value"), value: formatUSD(row().value, language.intl()) },
            { label: language.t("usage.table.rate"), value: formatUSDCompact(perMillion(), language.intl()) },
            { label: language.t("usage.table.requests"), value: formatNumber(row().freeMessages, language.intl()) },
            { label: language.t("usage.metric.tokens"), value: formatTokens(row().freeTokenTotal, language.intl()) },
            ...(row().source === "inferred"
              ? [
                  {
                    label: language.t("usage.subsidy.basis"),
                    value:
                      row().confidence !== undefined
                        ? language.t("usage.subsidy.basisFuzzy", {
                            score: formatPercent(row().confidence!, language.intl()),
                          })
                        : language.t("usage.subsidy.basisSibling"),
                  },
                ]
              : []),
            ...(row().approximate ? [{ label: language.t("usage.subsidy.partial"), value: "~" }] : []),
          ]}
        />
      }
    />
  )
}
