import { createEffect, createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { UsageHeatmap } from "@/components/usage/usage-chart"
import { UsagePunchcard } from "@/components/usage/usage-punchcard"
import { SortHeader } from "@/components/usage/usage-table"
import { createColumnSort } from "@/components/usage/usage-sort"
import {
  formatDuration,
  formatNumber,
  formatPercent,
  formatTokens,
  formatUSD,
  formatUSDCompact,
  hourLabel,
} from "@/components/usage/usage-format"
import { DetailRows, EmptyLine, Panel, RankRow, RuleGrid, Stat } from "./usage-page-primitives"

type Metric = "cost" | "tokens"

const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Activity, rebuilt from nothing.
 *
 * The old version was six unrelated cards that between them answered no
 * question a person actually has: a token-type bar chart, a variant share
 * list, a project table, a 7-bar day chart, a 24-bar hour chart, and a
 * calendar heatmap. The two time charts were the marginals of a distribution
 * whose cross product is the interesting part, and nothing anywhere connected
 * activity back to the work that produced it.
 *
 * This is organised as one narrative instead: a rhythm summary, the punchcard
 * that shows when you actually work, the calendar for how that has trended,
 * and then the sessions and projects that account for it — with composition
 * detail last, where reference material belongs.
 */
export function UsagePageActivity(props: { data: UsageSummaryResponse; metric: Metric; projectID: string | null }) {
  const language = useLanguage()

  return (
    <div class="flex flex-col gap-3">
      <UsageActivityRhythm data={props.data} />

      <Panel title={language.t("usage.activity.punchcard")} tooltip={language.t("usage.activity.punchcardHelp")}>
        <UsagePunchcard punchcard={props.data.punchcard} />
      </Panel>

      <Panel
        title={language.t("usage.section.heatmap")}
        accessory={
          <span class="text-[9px] font-[440] uppercase tracking-[0.04em] text-v2-text-text-faint">
            {props.metric === "cost" ? language.t("usage.heatmap.cost") : language.t("usage.heatmap.tokens")}
          </span>
        }
      >
        <UsageHeatmap days={props.data.days} metric={props.metric} />
      </Panel>

      <UsageSessionsTable sessions={props.data.sessions} />

      <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Show when={props.projectID === null && props.data.projects.length > 0}>
          <UsageProjectsPanel projects={props.data.projects} metric={props.metric} />
        </Show>
        <UsageCompositionPanel data={props.data} />
      </div>
    </div>
  )
}

/**
 * The summary that makes the punchcard below it legible: how many days you
 * actually worked, how concentrated that work was, and when the peak is.
 * Streaks and active days come from the day buckets, which only exist for days
 * with activity — so "active days" is a count of present buckets, not a
 * subtraction over the window.
 */
function UsageActivityRhythm(props: { data: UsageSummaryResponse }) {
  const language = useLanguage()
  const totals = () => props.data.totals

  const days = createMemo(() => [...props.data.days].sort((a, b) => a.start - b.start))

  const busiestDay = createMemo(() => {
    let best: UsageSummaryResponse["days"][number] | undefined
    for (const day of days()) if (!best || day.messages > best.messages) best = day
    return best
  })

  // Consecutive calendar days with any activity. Day starts are local
  // midnights, so a DST shift makes the gap 23h or 25h rather than exactly
  // 24h — rounding the ratio absorbs that without a date library.
  const longestStreak = createMemo(() => {
    const list = days()
    let best = 0
    let run = 0
    let previous: number | undefined
    for (const day of list) {
      if (previous !== undefined && Math.round((day.start - previous) / DAY_MS) === 1) run += 1
      else run = 1
      previous = day.start
      if (run > best) best = run
    }
    return best
  })

  const peakHour = createMemo(() => {
    let index = 0
    props.data.hours.forEach((bucket, i) => {
      if (bucket.messages > props.data.hours[index].messages) index = i
    })
    return { hour: index, bucket: props.data.hours[index] }
  })

  const peakDay = createMemo(() => {
    let index = 0
    props.data.dow.forEach((bucket, i) => {
      if (bucket.messages > props.data.dow[index].messages) index = i
    })
    return { day: index, bucket: props.data.dow[index] }
  })

  const activeDays = () => days().length
  const turnsPerActiveDay = () => (activeDays() > 0 ? totals().messages / activeDays() : 0)
  const turnsPerSession = () => (totals().sessions > 0 ? totals().messages / totals().sessions : 0)
  const totalTurns = () => totals().messages

  return (
    <Panel title={language.t("usage.section.rhythm")} flush>
      <RuleGrid class="grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label={language.t("usage.activity.activeDays")} value={formatNumber(activeDays(), language.intl())} size="lg" />
        <Stat
          label={language.t("usage.activity.longestStreak")}
          value={language.t("usage.activity.streakValue", { count: formatNumber(longestStreak(), language.intl()) })}
        />
        <Stat
          label={language.t("usage.activity.turnsPerDay")}
          value={formatNumber(turnsPerActiveDay(), language.intl())}
          sub={language.t("usage.activity.turnsPerDaySub")}
        />
        <Stat label={language.t("usage.activity.turnsPerSession")} value={formatNumber(turnsPerSession(), language.intl())} />
        <Stat
          label={language.t("usage.activity.peakDay")}
          value={DOW_LABELS[peakDay().day]}
          meter={totalTurns() > 0 ? peakDay().bucket.messages / totalTurns() : 0}
          sub={formatPercent(totalTurns() > 0 ? peakDay().bucket.messages / totalTurns() : 0, language.intl())}
        />
        <Stat
          label={language.t("usage.activity.peakHour")}
          value={hourLabel(peakHour().hour)}
          meter={totalTurns() > 0 ? peakHour().bucket.messages / totalTurns() : 0}
          sub={
            busiestDay()
              ? language.t("usage.activity.busiestDay", {
                  date: new Date(busiestDay()!.start).toLocaleDateString(language.intl(), { month: "short", day: "numeric" }),
                  count: formatNumber(busiestDay()!.messages, language.intl()),
                })
              : undefined
          }
        />
      </RuleGrid>
    </Panel>
  )
}

const SESSION_GRID = "grid-cols-[minmax(0,1fr)_112px_44px_40px_60px_62px_60px_76px]"

type SessionSortColumn = "session" | "project" | "turns" | "models" | "tokens" | "cost" | "span" | "when"

/**
 * The heaviest individual pieces of work in the window.
 *
 * This is the thing the old activity page most conspicuously lacked: every
 * chart on it aggregated away the unit a person actually recognises. The
 * server ranks these by tokens rather than cost, so a session run entirely on
 * free models still shows up as the large piece of work it was; the table can
 * then be re-sorted by any column.
 */
function UsageSessionsTable(props: { sessions: UsageSummaryResponse["sessions"] }) {
  const language = useLanguage()
  type Row = UsageSummaryResponse["sessions"][number]

  const sort = createColumnSort<Row, SessionSortColumn>("tokens", (session, column) => {
    switch (column) {
      case "session":
        return session.title
      case "project":
        return session.projectName
      case "turns":
        return session.messages
      case "models":
        return session.models
      case "tokens":
        return session.tokens
      case "cost":
        return session.cost
      case "span":
        return session.end - session.start
      case "when":
        return session.end
    }
  })
  const sorted = createMemo(() => sort.sort([...props.sessions]))

  return (
    <Panel
      title={language.t("usage.section.sessions")}
      tooltip={language.t("usage.sessions.help")}
      accessory={
        <span class="text-[10px] font-[440] tabular-nums text-v2-text-text-faint">
          {formatNumber(props.sessions.length, language.intl())}
        </span>
      }
      flush
    >
      <div class={`grid ${SESSION_GRID} items-center gap-1 border-b border-[var(--usage-line)] bg-[var(--usage-inset)] px-3 py-1.5`}>
        <SortHeader label={language.t("usage.table.session")} column="session" active={sort.column()} direction={sort.direction()} onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.project")} column="project" active={sort.column()} direction={sort.direction()} onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.turns")} column="turns" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.models")} column="models" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.tokens")} column="tokens" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.cost")} column="cost" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.span")} column="span" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
        <SortHeader label={language.t("usage.table.when")} column="when" active={sort.column()} direction={sort.direction()} align="right" onClick={sort.toggle} />
      </div>
      <Show when={sorted().length > 0} fallback={<EmptyLine>{language.t("usage.sessions.empty")}</EmptyLine>}>
        <div class="flex flex-col">
          <For each={sorted()}>
            {(session) => (
              <div
                class={`grid ${SESSION_GRID} items-center gap-1 border-b border-[var(--usage-line)] px-3 py-1.5 last:border-0 hover:bg-[var(--usage-hover)]`}
              >
                <span class="min-w-0 truncate text-[10px] font-[480] leading-4 text-v2-text-text-base">
                  {session.title || language.t("usage.sessions.untitled")}
                </span>
                <span class="min-w-0 truncate text-[10px] font-[440] leading-4 text-v2-text-text-muted">{session.projectName}</span>
                <span class="truncate text-right text-[10px] font-[440] leading-4 tabular-nums text-v2-text-text-muted">
                  {formatNumber(session.messages, language.intl())}
                </span>
                <span class="truncate text-right text-[10px] font-[440] leading-4 tabular-nums text-v2-text-text-faint">
                  {formatNumber(session.models, language.intl())}
                </span>
                <span class="truncate text-right text-[10px] font-[440] leading-4 tabular-nums text-v2-text-text-muted">
                  {formatTokens(session.tokens, language.intl())}
                </span>
                <span class="truncate text-right text-[10px] font-[560] leading-4 tabular-nums text-v2-text-text-base">
                  {formatUSDCompact(session.cost, language.intl())}
                </span>
                <span class="truncate text-right text-[10px] font-[440] leading-4 tabular-nums text-v2-text-text-faint">
                  {formatDuration(session.end - session.start, language.intl())}
                </span>
                <span class="truncate text-right text-[10px] font-[440] leading-4 tabular-nums text-v2-text-text-faint">
                  {new Date(session.end).toLocaleDateString(language.intl(), { month: "short", day: "numeric" })}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Panel>
  )
}

type ProjectSortColumn = "project" | "sessions" | "cost" | "tokens"

/** Where the window's work came from. Hidden entirely when a single project is
 * already selected in the header, since a one-row comparison table is noise. */
function UsageProjectsPanel(props: { projects: UsageSummaryResponse["projects"]; metric: Metric }) {
  const language = useLanguage()
  type Row = UsageSummaryResponse["projects"][number]

  const sort = createColumnSort<Row, ProjectSortColumn>(props.metric === "tokens" ? "tokens" : "cost", (project, column) => {
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
  const sorted = createMemo(() => sort.sort([...props.projects]))

  const max = createMemo(() =>
    Math.max(...props.projects.map((project) => (props.metric === "tokens" ? project.tokens : project.cost)), 0),
  )

  return (
    <Panel title={language.t("usage.section.projects")}>
      <div class="flex flex-col gap-0.5">
        <For each={sorted()}>
          {(project) => {
            const value = () => (props.metric === "tokens" ? project.tokens : project.cost)
            return (
              <RankRow
                label={project.name}
                detail={language.plural("usage.sessions", project.sessions)}
                fraction={max() > 0 ? value() / max() : 0}
                value={
                  props.metric === "tokens"
                    ? formatTokens(project.tokens, language.intl())
                    : formatUSDCompact(project.cost, language.intl())
                }
                tooltip={
                  <DetailRows
                    title={project.name}
                    rows={[
                      { label: language.t("usage.table.sessions"), value: formatNumber(project.sessions, language.intl()) },
                      { label: language.t("usage.table.turns"), value: formatNumber(project.messages, language.intl()) },
                      { label: language.t("usage.metric.cost"), value: formatUSD(project.cost, language.intl()) },
                      { label: language.t("usage.metric.tokens"), value: formatTokens(project.tokens, language.intl()) },
                    ]}
                  />
                }
              />
            )
          }}
        </For>
      </div>
    </Panel>
  )
}

/** Reference detail: what the tokens were made of, and which model variants
 * served them. Last on the page because it explains the numbers above rather
 * than raising a question of its own. */
function UsageCompositionPanel(props: { data: UsageSummaryResponse }) {
  const language = useLanguage()

  const tokenRows = createMemo(() => {
    const tokens = props.data.totals.tokens
    const entries = [
      { label: language.t("usage.tokenType.input"), value: tokens.input },
      { label: language.t("usage.tokenType.cacheRead"), value: tokens.cacheRead },
      { label: language.t("usage.tokenType.cacheWrite"), value: tokens.cacheWrite },
      { label: language.t("usage.tokenType.output"), value: tokens.output },
      { label: language.t("usage.tokenType.reasoning"), value: tokens.reasoning },
    ].filter((entry) => entry.value > 0)
    const total = entries.reduce((sum, entry) => sum + entry.value, 0)
    return entries
      .sort((a, b) => b.value - a.value)
      .map((entry) => ({ ...entry, share: total > 0 ? entry.value / total : 0 }))
  })

  const variantRows = createMemo(() => {
    const max = Math.max(...props.data.variants.map((variant) => variant.messages), 0)
    return props.data.variants.map((variant) => ({
      label: variant.variant === null || variant.variant === "" ? language.t("usage.variant.default") : variant.variant,
      messages: variant.messages,
      share: variant.share,
      fraction: max > 0 ? variant.messages / max : 0,
    }))
  })

  return (
    <Panel title={language.t("usage.section.composition")} flush>
      <div class="p-3">
        <span class="mb-1.5 block text-[9px] font-[560] uppercase leading-3 tracking-[0.05em] text-v2-text-text-faint">
          {language.t("usage.section.tokenBreakdown")}
        </span>
        <Show when={tokenRows().length > 0} fallback={<EmptyLine>{language.t("usage.models.empty")}</EmptyLine>}>
          <div class="flex flex-col gap-0.5">
            <For each={tokenRows()}>
              {(row) => (
                <RankRow
                  label={row.label}
                  detail={formatPercent(row.share, language.intl())}
                  fraction={row.share}
                  value={formatTokens(row.value, language.intl())}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={variantRows().length > 0}>
        <div class="border-t border-[var(--usage-line)] p-3">
          <span class="mb-1.5 block text-[9px] font-[560] uppercase leading-3 tracking-[0.05em] text-v2-text-text-faint">
            {language.t("usage.section.variants")}
          </span>
          <div class="flex flex-col gap-0.5">
            <For each={variantRows()}>
              {(row) => (
                <RankRow
                  label={row.label}
                  detail={formatPercent(row.share, language.intl())}
                  fraction={row.fraction}
                  value={formatNumber(row.messages, language.intl())}
                />
              )}
            </For>
          </div>
        </div>
      </Show>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--usage-line)] px-3 py-2 text-[9px] font-[440] leading-3 text-v2-text-text-faint">
        <span>
          {language.t("usage.footnote.priced")} {formatNumber(props.data.totals.pricedRecords, language.intl())}
        </span>
        <span>
          {language.t("usage.footnote.unpriced")} {formatNumber(props.data.totals.unpricedRecords, language.intl())}
        </span>
        <Show when={props.data.rates.cacheSavingsCoverage < 1}>
          <span>{language.t("usage.footnote.savingsCoverage")}</span>
        </Show>
      </div>
    </Panel>
  )
}
