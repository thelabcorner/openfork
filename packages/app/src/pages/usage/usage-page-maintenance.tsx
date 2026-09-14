import { createMemo, createSignal, For, Show } from "solid-js"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import {
  formatDuration,
  formatNumber,
  formatPercent,
  formatTokens,
  formatUSD,
  formatUSDCompact,
} from "@/components/usage/usage-format"
import { DetailRows, EmptyLine, Panel, RankRow, RuleGrid, Stat } from "./usage-page-primitives"

type Metric = "cost" | "tokens"
const MODEL_TABLE_INITIAL_ROWS = 50
const MODEL_TABLE_PAGE_ROWS = 200

const AGENT_META: Record<string, { label: string; detail: string }> = {
  title: { label: "Title generation", detail: "Names new sessions" },
  "prompt-revisor": { label: "Prompt revisor", detail: "Revises prompts before dispatch" },
  "goal-auditor": { label: "Goal auditor", detail: "Verifies Goal completion and evidence" },
  compaction: { label: "Context compaction", detail: "Compresses long conversation context" },
  summary: { label: "Session summary", detail: "Maintains compact session state" },
}

const agentMeta = (agent: string) =>
  AGENT_META[agent] ?? {
    label: agent
      .split(/[-_]/g)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" "),
    detail: "Host-owned support agent",
  }

const tokenTotal = (data: UsageSummaryResponse) => {
  const tokens = data.totals.tokens
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning
}

const samplePeriods = <T,>(items: readonly T[], limit = 120) => {
  if (items.length <= limit) return [...items]
  const sampled: T[] = []
  for (let index = 0; index < limit; index++) {
    sampled.push(items[Math.min(items.length - 1, Math.floor((index * items.length) / limit))]!)
  }
  return sampled
}

/**
 * System-maintenance accounting deliberately lives outside ordinary Usage
 * metrics. This page answers a different question: how much model capacity does
 * OpenCode spend supporting the user's work rather than directly doing it?
 */
export function UsagePageMaintenance(props: { data: UsageSummaryResponse; metric: Metric }) {
  const language = useLanguage()
  const [modelLimit, setModelLimit] = createSignal(MODEL_TABLE_INITIAL_ROWS)
  const maintenance = () => props.data.maintenance
  const totals = () => maintenance().totals
  const spend = () => totals().cost + totals().estimatedCost
  const workSpend = () => props.data.totals.cost + props.data.totals.estimatedCost
  const allInSpend = () => workSpend() + spend()
  const workTokens = () => tokenTotal(props.data)
  const allInTokens = () => workTokens() + totals().totalTokens
  const spendOverhead = () => (allInSpend() > 0 ? spend() / allInSpend() : 0)
  const tokenOverhead = () => (allInTokens() > 0 ? totals().totalTokens / allInTokens() : 0)
  const avgTokens = () => (totals().requests > 0 ? totals().totalTokens / totals().requests : 0)
  const avgCost = () => (totals().requests > 0 ? spend() / totals().requests : 0)
  const measuredRecords = () => Math.max(0, totals().requests - totals().estimatedRecords)
  const measuredShare = () => (totals().requests > 0 ? measuredRecords() / totals().requests : 0)

  const periods = createMemo(() => samplePeriods(maintenance().periods))
  const periodMax = createMemo(() =>
    Math.max(0, ...periods().map((item) => (props.metric === "cost" ? item.cost : item.tokens))),
  )
  const agents = createMemo(() =>
    [...maintenance().agents].sort((a, b) =>
      props.metric === "cost" ? b.costShare - a.costShare : b.tokenShare - a.tokenShare,
    ),
  )

  const models = createMemo(() =>
    [...maintenance().models].sort(
      props.metric === "cost"
        ? (a, b) => b.cost + b.estimatedCost - (a.cost + a.estimatedCost) || b.totalTokens - a.totalTokens
        : (a, b) => b.totalTokens - a.totalTokens || b.cost + b.estimatedCost - (a.cost + a.estimatedCost),
    ),
  )
  const visibleModels = createMemo(() => models().slice(0, modelLimit()))
  const hiddenModels = createMemo(() => Math.max(0, models().length - visibleModels().length))

  return (
    <div class="flex flex-col gap-3">
      <div class="rounded-lg border border-[var(--usage-line)] bg-[var(--usage-panel)]">
        <div class="flex min-h-10 items-center justify-between gap-4 border-b border-[var(--usage-line)] px-3 py-2">
          <div class="min-w-0">
            <div class="text-[11px] font-[620] leading-4 text-v2-text-text-base">
              {language.t("usage.maintenance.title")}
            </div>
            <div class="truncate text-[10px] font-[440] leading-4 text-v2-text-text-faint">
              {language.t("usage.maintenance.description")}
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <span class="rounded-[4px] border border-[var(--usage-line)] bg-v2-background-bg-base px-1.5 py-0.5 text-[9px] font-[560] uppercase tracking-[0.04em] text-v2-text-text-faint">
              {language.t("usage.maintenance.excluded")}
            </span>
          </div>
        </div>
        <RuleGrid class="grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
          <Stat label={language.t("usage.maintenance.spend")} value={formatUSD(spend(), language.intl())} size="lg" />
          <Stat
            label={language.t("usage.maintenance.spendShare")}
            value={formatPercent(spendOverhead(), language.intl())}
            meter={spendOverhead()}
            sub={language.t("usage.maintenance.ofAllIn")}
          />
          <Stat
            label={language.t("usage.maintenance.tokens")}
            value={formatTokens(totals().totalTokens, language.intl())}
            size="lg"
          />
          <Stat
            label={language.t("usage.maintenance.tokenShare")}
            value={formatPercent(tokenOverhead(), language.intl())}
            meter={tokenOverhead()}
            sub={language.t("usage.maintenance.ofAllIn")}
          />
          <Stat
            label={language.t("usage.maintenance.requests")}
            value={formatNumber(totals().requests, language.intl())}
          />
          <Stat
            label={language.t("usage.maintenance.sessions")}
            value={formatNumber(totals().sessions, language.intl())}
          />
          <Stat label={language.t("usage.maintenance.avgTokens")} value={formatTokens(avgTokens(), language.intl())} />
          <Stat label={language.t("usage.maintenance.avgCost")} value={formatUSD(avgCost(), language.intl())} />
        </RuleGrid>
      </div>

      <div class="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <Panel
          title={language.t("usage.maintenance.byAgent")}
          accessory={
            <span class="text-[10px] font-[560] tabular-nums text-v2-text-text-faint">
              {formatNumber(agents().length, language.intl())} {language.t("usage.maintenance.agents")}
            </span>
          }
          flush
        >
          <Show when={agents().length > 0} fallback={<EmptyLine>{language.t("usage.maintenance.empty")}</EmptyLine>}>
            <div class="p-2">
              <For each={agents()}>
                {(agent) => {
                  const meta = agentMeta(agent.agent)
                  return (
                    <RankRow
                      label={meta.label}
                      detail={`${formatNumber(agent.requests, language.intl())} ${language.t("usage.maintenance.runs")}`}
                      fraction={props.metric === "cost" ? agent.costShare : agent.tokenShare}
                      value={formatPercent(
                        props.metric === "cost" ? agent.costShare : agent.tokenShare,
                        language.intl(),
                      )}
                      tooltip={
                        <DetailRows
                          title={meta.label}
                          rows={[
                            { label: language.t("usage.maintenance.role"), value: meta.detail },
                            {
                              label: language.t("usage.maintenance.requests"),
                              value: formatNumber(agent.requests, language.intl()),
                            },
                            {
                              label: language.t("usage.maintenance.tokens"),
                              value: formatTokens(agent.totalTokens, language.intl()),
                            },
                            {
                              label: language.t("usage.maintenance.spend"),
                              value: formatUSD(agent.cost + agent.estimatedCost, language.intl()),
                            },
                            {
                              label: language.t("usage.maintenance.sessions"),
                              value: formatNumber(agent.sessions, language.intl()),
                            },
                            {
                              label: language.t("usage.table.models"),
                              value: formatNumber(agent.models, language.intl()),
                            },
                          ]}
                        />
                      }
                    />
                  )
                }}
              </For>
            </div>
          </Show>
        </Panel>

        <Panel title={language.t("usage.maintenance.runtimeProfile")} flush>
          <RuleGrid class="grid-cols-2">
            <Stat
              label={language.t("usage.maintenance.measured")}
              value={formatPercent(measuredShare(), language.intl())}
              meter={measuredShare()}
              sub={`${formatNumber(totals().estimatedRecords, language.intl())} ${language.t("usage.maintenance.estimated")}`}
            />
            <Stat
              label={language.t("usage.maintenance.activeTime")}
              value={formatDuration(totals().durationMs, language.intl())}
              sub={`${formatNumber(totals().durationRecords, language.intl())} ${language.t("usage.maintenance.timed")}`}
            />
          </RuleGrid>
          <div class="border-t border-[var(--usage-line)] px-3 pb-3 pt-2.5">
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="text-[9px] font-[560] uppercase tracking-[0.05em] text-v2-text-text-faint">
                {language.t("usage.maintenance.timeline")}
              </span>
              <span class="text-[9px] font-[520] tabular-nums text-v2-text-text-faint">
                {props.metric === "cost" ? language.t("usage.metric.cost") : language.t("usage.metric.tokens")}
              </span>
            </div>
            <Show
              when={periods().length > 0 && periodMax() > 0}
              fallback={<div class="h-14 rounded-[4px] bg-[var(--usage-track)]" />}
            >
              <div class="flex h-14 items-end gap-px overflow-hidden rounded-[4px] bg-[var(--usage-track)] px-1 pt-1">
                <For each={periods()}>
                  {(period) => {
                    const value = () => (props.metric === "cost" ? period.cost : period.tokens)
                    const height = () => Math.max(value() > 0 ? 4 : 0, (value() / periodMax()) * 100)
                    return (
                      <div
                        class="min-w-px flex-1 rounded-t-[1px] bg-[var(--usage-accent)] opacity-80"
                        style={{ height: `${height()}%` }}
                        title={`${new Date(period.start).toLocaleString()} · ${props.metric === "cost" ? formatUSDCompact(period.cost, language.intl()) : formatTokens(period.tokens, language.intl())}`}
                      />
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>
        </Panel>
      </div>

      <Panel title={language.t("usage.maintenance.models")} tooltip={language.t("usage.maintenance.modelsHelp")} flush>
        <Show when={models().length > 0} fallback={<EmptyLine>{language.t("usage.maintenance.empty")}</EmptyLine>}>
          <div class="overflow-x-auto">
            <div class="min-w-[720px]">
              <div class="grid grid-cols-[minmax(180px,1.2fr)_minmax(220px,1.6fr)_80px_100px_88px] items-center border-b border-[var(--usage-line)] px-3 py-1.5 text-[9px] font-[560] uppercase tracking-[0.05em] text-v2-text-text-faint">
                <span>{language.t("usage.maintenance.agent")}</span>
                <span>{language.t("usage.table.model")}</span>
                <span class="text-right">{language.t("usage.table.requests")}</span>
                <span class="text-right">{language.t("usage.table.tokens")}</span>
                <span class="text-right">{language.t("usage.table.cost")}</span>
              </div>
              <For each={visibleModels()}>
                {(model) => {
                  const meta = agentMeta(model.agent)
                  return (
                    <div class="grid grid-cols-[minmax(180px,1.2fr)_minmax(220px,1.6fr)_80px_100px_88px] items-center border-b border-[var(--usage-line)] px-3 py-2 last:border-b-0 hover:bg-[var(--usage-hover)]">
                      <div class="min-w-0">
                        <div class="truncate text-[10px] font-[540] leading-4 text-v2-text-text-base">{meta.label}</div>
                        <div class="truncate text-[9px] leading-3 text-v2-text-text-faint">{meta.detail}</div>
                      </div>
                      <div class="min-w-0">
                        <div class="truncate text-[10px] font-[520] leading-4 text-v2-text-text-muted">
                          {model.modelID}
                        </div>
                        <div class="truncate text-[9px] leading-3 text-v2-text-text-faint">
                          {model.providerID}
                          <Show when={model.variant}> · {model.variant}</Show>
                        </div>
                      </div>
                      <span class="text-right text-[10px] font-[520] tabular-nums text-v2-text-text-muted">
                        {formatNumber(model.requests, language.intl())}
                      </span>
                      <span class="text-right text-[10px] font-[520] tabular-nums text-v2-text-text-muted">
                        {formatTokens(model.totalTokens, language.intl())}
                      </span>
                      <span class="text-right text-[10px] font-[600] tabular-nums text-v2-text-text-base">
                        {formatUSDCompact(model.cost + model.estimatedCost, language.intl())}
                      </span>
                    </div>
                  )
                }}
              </For>
              <Show when={hiddenModels() > 0}>
                <button
                  type="button"
                  class="w-full border-t border-[var(--usage-line)] px-3 py-2 text-left text-[10px] font-[560] text-v2-text-text-muted hover:bg-[var(--usage-hover)]"
                  onClick={() => setModelLimit((value) => value + MODEL_TABLE_PAGE_ROWS)}
                >
                  {language.t("common.showMore", { count: Math.min(MODEL_TABLE_PAGE_ROWS, hiddenModels()) })}
                </button>
              </Show>
            </div>
          </div>
        </Show>
      </Panel>
    </div>
  )
}
