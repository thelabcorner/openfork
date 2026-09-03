import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import {
  formatDuration,
  formatNumber,
  formatPercent,
  formatTokens,
  formatTokensPerSecond,
  formatUSD,
  formatUSDCompact,
} from "@/components/usage/usage-format"
import type { ModelGroup } from "@/components/usage/usage-model-groups"
import { subsidyShare } from "@/utils/usage-subsidy"
import type { UsageValuation } from "./use-usage-valuation"
import { DetailRows, EmptyLine, Panel, RankRow, RuleGrid, Stat } from "./usage-page-primitives"

/**
 * The overview's instrument band.
 *
 * Replaces the old side-by-side "Totals" and "Rates" cards, which split twelve
 * numbers into two arbitrary buckets ("processed tokens" in one, "avg tokens /
 * turn" in the other) and boxed each one individually. Here the split is by
 * the question being asked — what did this cost, and how much work was done —
 * and the numbers sit in one continuous hairline grid so they can be scanned
 * as a row instead of read as twelve separate tiles.
 */
export function UsageOverviewStats(props: { data: UsageSummaryResponse; valuation: UsageValuation }) {
  const language = useLanguage()
  const totals = () => props.data.totals
  const rates = () => props.data.rates
  const subsidy = () => props.valuation.subsidy()

  const processed = () => {
    const tokens = totals().tokens
    return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning
  }
  const spend = () => totals().cost + totals().estimatedCost
  const ttftAvg = () => (totals().ttftRecords > 0 ? totals().ttftMs / totals().ttftRecords : 0)
  // Per-session averages come off the same session count the hero reports, so
  // a session that spans the window boundary is counted once here and there.
  const tokensPerSession = () => (totals().sessions > 0 ? processed() / totals().sessions : 0)
  const turnsPerSession = () => (totals().sessions > 0 ? totals().messages / totals().sessions : 0)
  const activeTime = () => totals().durationMs

  return (
    <div class="flex flex-col gap-3">
      <Panel title={language.t("usage.section.economics")} flush>
        <RuleGrid class="grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          <Stat label={language.t("usage.metric.spend")} value={formatUSD(spend(), language.intl())} size="lg" />
          <Stat
            label={language.t("usage.metric.freeValue")}
            value={formatUSD(subsidy().total, language.intl())}
            size="lg"
            tone="credit"
            tooltip={language.t("usage.metric.freeValueHelp")}
            sub={language.t("usage.subsidy.shareSub", { value: formatPercent(subsidyShare(subsidy()), language.intl()) })}
          />
          <Stat
            label={language.t("usage.metric.cacheSavings")}
            value={formatUSD(rates().cacheSavings, language.intl())}
            tone="credit"
            sub={language.t("usage.metric.cacheSavingsSub")}
          />
          <Stat label={language.t("usage.metric.avgCostPerTurn")} value={formatUSD(rates().avgCostPerTurn, language.intl())} />
          <Stat
            label={language.t("usage.metric.pricingCoverage")}
            value={formatPercent(props.data.pricing.coverage, language.intl())}
            meter={props.data.pricing.coverage}
            sub={language.t("usage.footnote.unpriced") + " " + formatNumber(totals().unpricedRecords, language.intl())}
          />
          <Stat
            label={language.t("usage.metric.mostUsedModel")}
            value={props.data.mostUsedModel?.modelID ?? "—"}
            sub={
              props.data.mostUsedModel
                ? formatPercent(props.data.mostUsedModel.share, language.intl())
                : undefined
            }
          />
        </RuleGrid>
      </Panel>

      <Panel title={language.t("usage.section.workload")} flush>
        <RuleGrid class="grid-cols-2 sm:grid-cols-4 xl:grid-cols-7">
          <Stat label={language.t("usage.metric.tokens")} value={formatTokens(processed(), language.intl())} size="lg" />
          <Stat label={language.t("usage.table.sessions")} value={formatNumber(totals().sessions, language.intl())} />
          <Stat label={language.t("usage.table.turns")} value={formatNumber(totals().messages, language.intl())} />
          <Stat label={language.t("usage.metric.avgTokensPerTurn")} value={formatTokens(rates().avgTokensPerTurn, language.intl())} />
          <Stat
            label={language.t("usage.metric.avgTokensPerSession")}
            value={formatTokens(tokensPerSession(), language.intl())}
            sub={language.t("usage.metric.avgTokensPerSessionSub", {
              value: formatNumber(turnsPerSession(), language.intl()),
            })}
          />
          <Stat
            label={language.t("usage.metric.tokensPerSecond")}
            value={formatTokensPerSecond(rates().tokensPerSecond, language.intl())}
            sub={language.t("usage.metric.outputThroughput")}
          />
          <Stat
            label={language.t("usage.metric.timeToFirstToken")}
            value={formatDuration(ttftAvg(), language.intl())}
            sub={language.t("usage.metric.activeTime", { value: formatDuration(activeTime(), language.intl()) })}
          />
        </RuleGrid>
      </Panel>
    </div>
  )
}

const CACHE_LEADERBOARD_SIZE = 8

/**
 * Cache performance.
 *
 * The old version ranked models by hit rate alone, which put a model with two
 * lucky requests at the top of the board and buried the model actually doing
 * the caching. This ranks by cache-read volume — the models whose hit rate is
 * moving real money — and shows the rate as the bar, so both the quality and
 * the weight of each row are visible at once.
 */
export function UsageOverviewCache(props: { data: UsageSummaryResponse; modelGroups: ModelGroup[] }) {
  const language = useLanguage()
  const rates = () => props.data.rates

  const leaderboard = createMemo(() => {
    const rows = props.modelGroups
      .map((group) => {
        const denominator = group.tokenBreakdown.input + group.tokenBreakdown.cacheRead
        if (denominator <= 0) return undefined
        return {
          label: group.modelID,
          hitRate: group.tokenBreakdown.cacheRead / denominator,
          cached: group.tokenBreakdown.cacheRead,
          savings: group.cacheSavings,
          messages: group.messages,
        }
      })
      .filter((row): row is NonNullable<typeof row> => !!row)
      .sort((a, b) => b.cached - a.cached)
      .slice(0, CACHE_LEADERBOARD_SIZE)
    return rows
  })

  const tokens = () => props.data.totals.tokens
  const uncached = () => tokens().input

  return (
    <Panel
      title={language.t("usage.section.cachePerformance")}
      tooltip={language.t("usage.section.cachePerformanceHelp")}
      accessory={
        <span class="text-[10px] font-[560] tabular-nums text-[var(--usage-credit)]">
          {formatUSD(rates().cacheSavings, language.intl())}
        </span>
      }
      flush
    >
      <RuleGrid class="grid-cols-3">
        <Stat
          label={language.t("usage.metric.cacheHitRate")}
          value={formatPercent(rates().cacheHitRate, language.intl())}
          meter={rates().cacheHitRate}
          size="lg"
        />
        <Stat label={language.t("usage.totals.cachedInput")} value={formatTokens(tokens().cacheRead, language.intl())} />
        <Stat label={language.t("usage.totals.uncachedInput")} value={formatTokens(uncached(), language.intl())} />
      </RuleGrid>
      <div class="border-t border-[var(--usage-line)] p-3">
        <span class="mb-1.5 block text-[9px] font-[560] uppercase leading-3 tracking-[0.05em] text-v2-text-text-faint">
          {language.t("usage.cache.leaderboard")}
        </span>
        <Show when={leaderboard().length > 0} fallback={<EmptyLine>{language.t("usage.models.empty")}</EmptyLine>}>
          <div class="flex flex-col gap-0.5">
            <For each={leaderboard()}>
              {(row) => (
                <RankRow
                  label={row.label}
                  detail={formatTokens(row.cached, language.intl())}
                  fraction={row.hitRate}
                  value={formatPercent(row.hitRate, language.intl())}
                  tooltip={
                    <DetailRows
                      title={row.label}
                      rows={[
                        { label: language.t("usage.metric.cacheHitRate"), value: formatPercent(row.hitRate, language.intl()) },
                        { label: language.t("usage.totals.cachedInput"), value: formatTokens(row.cached, language.intl()) },
                        { label: language.t("usage.metric.cacheSavings"), value: formatUSDCompact(row.savings, language.intl()) },
                        { label: language.t("usage.table.requests"), value: formatNumber(row.messages, language.intl()) },
                      ]}
                    />
                  }
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </Panel>
  )
}
