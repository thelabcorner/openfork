import { createSignal, For, Show } from "solid-js"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { formatNumber, formatTokens, formatUSD, formatUSDCompact } from "./usage-format"

type Summary = UsageSummaryResponse

const WIDTH = 320
const HEIGHT = 72
const PAD_Y = 4

type Metric = "cost" | "tokens"

const valueFor = (bucket: { cost: number; tokens: number }, metric: Metric) =>
  metric === "cost" ? bucket.cost : bucket.tokens

/** Chart-local metric for the hero area chart only — a superset of the
 * page-wide cost/tokens toggle. Kept separate from `Metric` (used by the
 * heatmap, breakdown tables, and every other cost/tokens-typed section) so
 * adding a "turns over time" trend doesn't require widening those unrelated
 * binary-metric call sites. */
export type HeroChartMetric = Metric | "turns"

const heroValueFor = (bucket: { cost: number; tokens: number; messages: number }, metric: HeroChartMetric) =>
  metric === "cost" ? bucket.cost : metric === "tokens" ? bucket.tokens : bucket.messages

/** Label/value row for tooltip content — mirrors ModelTooltipRow in model-tooltip.tsx. */
function UsageTooltipRow(props: { label: string; value: string }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.label}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

export function UsageTooltipContent(props: { title: string; rows: { label: string; value: string }[] }) {
  return (
    <div class="flex w-max min-w-[140px] flex-col gap-1 text-[11px]">
      <span class="text-[9px] font-[600] uppercase tracking-[0.02em] text-v2-text-text-faint">{props.title}</span>
      <For each={props.rows}>{(row) => <UsageTooltipRow label={row.label} value={row.value} />}</For>
    </div>
  )
}

/** Smooth area chart for period buckets (cost or tokens over time), with a hover crosshair + tooltip. */
export function UsageAreaChart(props: { periods: Summary["periods"]; metric: Metric; resolution: "hour" | "day" }) {
  const language = useLanguage()
  const [hoverIndex, setHoverIndex] = createSignal<number | null>(null)

  const list = () => props.periods
  const max = () => {
    let value = 0
    for (const period of list()) value = Math.max(value, valueFor(period, props.metric))
    return value
  }
  const points = () => {
    const data = list()
    const count = data.length
    if (count === 0) return []
    return data.map((period, index) => {
      const x = (index / Math.max(1, count - 1)) * WIDTH
      const y = HEIGHT - PAD_Y - (max() > 0 ? (valueFor(period, props.metric) / max()) * (HEIGHT - PAD_Y * 2) : 0)
      return { x, y, period }
    })
  }
  const pointsAttr = () => points().map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  const areaPath = () => {
    const pts = points()
    if (pts.length === 0) return ""
    const base = HEIGHT - PAD_Y
    const first = pts[0]
    const last = pts[pts.length - 1]
    const mid = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")
    return `M ${first.x.toFixed(1)},${first.y.toFixed(1)} L ${mid} L ${last.x.toFixed(1)},${base.toFixed(1)} L ${first.x.toFixed(1)},${base.toFixed(1)} Z`
  }

  const handleMove = (event: MouseEvent & { currentTarget: SVGSVGElement }) => {
    const count = list().length
    if (count === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    setHoverIndex(Math.round(ratio * (count - 1)))
  }

  const hovered = () => {
    const index = hoverIndex()
    if (index === null) return null
    return points()[index] ?? null
  }

  const bucketLabel = (start: number) => {
    const date = new Date(start)
    return props.resolution === "hour"
      ? date.toLocaleString(language.intl(), { month: "short", day: "numeric", hour: "numeric" })
      : date.toLocaleDateString(language.intl(), { month: "short", day: "numeric", year: "numeric" })
  }

  return (
    <Show
      when={list().length > 1}
      fallback={
        <div class="flex h-[72px] items-center justify-center text-[10px] font-[440] text-v2-text-text-faint">
          —
        </div>
      }
    >
      <div class="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          class="h-[72px] w-full cursor-crosshair"
          preserveAspectRatio="none"
          aria-hidden="true"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id="usage-area-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--usage-accent, var(--v2-text-text-accent))" stop-opacity="0.28" />
              <stop offset="100%" stop-color="var(--usage-accent, var(--v2-text-text-accent))" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath()} fill="url(#usage-area-fill)" />
          <polyline points={pointsAttr()} fill="none" stroke="var(--usage-accent-strong, var(--v2-text-text-accent))" stroke-width="1.5" stroke-linejoin="round" />
          <Show when={hovered()}>
            {(point) => (
              <line
                x1={point().x}
                y1="0"
                x2={point().x}
                y2={HEIGHT}
                stroke="var(--usage-line, var(--v2-border-border-strong))"
                stroke-width="1"
                stroke-dasharray="2,2"
              />
            )}
          </Show>
        </svg>

        <Show when={hovered()}>
          {(point) => (
            <>
              {/* Rendered as plain HTML (not SVG) so the non-uniform viewBox scaling
                  (wide/short chart) doesn't stretch the dot into an ellipse. */}
              <div
                class="pointer-events-none absolute size-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-v2-background-bg-base"
                style={{
                  left: `${(point().x / WIDTH) * 100}%`,
                  top: `${(point().y / HEIGHT) * 100}%`,
                  "background-color": "var(--usage-accent-strong, var(--v2-text-text-accent))",
                }}
              />
              <div
                class="pointer-events-none absolute top-0 z-10 rounded-md border border-v2-border-border-muted bg-v2-background-bg-overlay px-2 py-1.5 shadow-[var(--v2-elevation-raised)]"
                style={{
                  left: `${Math.min(78, Math.max(0, (point().x / WIDTH) * 100))}%`,
                  transform: point().x / WIDTH > 0.72 ? "translateX(-100%)" : "translateX(4px)",
                }}
              >
                <UsageTooltipContent
                  title={bucketLabel(point().period.start)}
                  rows={[
                    { label: language.t("usage.metric.cost"), value: formatUSD(point().period.cost, language.intl()) },
                    { label: language.t("usage.metric.tokens"), value: formatTokens(point().period.tokens, language.intl()) },
                    { label: language.t("usage.table.requests"), value: formatNumber(point().period.messages, language.intl()) },
                  ]}
                />
              </div>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}

const HERO_WIDTH = 1040
const HERO_HEIGHT = 240
const HERO_PAD_Y = 8
const HERO_GRID_LINES = 4
const HERO_AXIS_COLUMN = 44

/**
 * Full-width hero chart for the standalone Usage page — same crosshair/tooltip
 * mechanics as `UsageAreaChart`, scaled up with y-axis gridlines/$-or-token
 * ticks and three x-axis date labels (start/mid/end), matching the density of
 * a dedicated analytics page rather than a sidebar sparkline. Axis lines and
 * labels stay on recessive muted/faint tokens so the accent-colored data line
 * remains the only thing that reads as "the chart."
 */
export function UsageHeroAreaChart(props: { periods: Summary["periods"]; metric: HeroChartMetric; resolution: "hour" | "day" }) {
  const language = useLanguage()
  const [hoverIndex, setHoverIndex] = createSignal<number | null>(null)

  const list = () => props.periods
  const max = () => {
    let value = 0
    for (const period of list()) value = Math.max(value, heroValueFor(period, props.metric))
    return value
  }
  const points = () => {
    const data = list()
    const count = data.length
    if (count === 0) return []
    return data.map((period, index) => {
      const x = (index / Math.max(1, count - 1)) * HERO_WIDTH
      const y = HERO_HEIGHT - HERO_PAD_Y - (max() > 0 ? (heroValueFor(period, props.metric) / max()) * (HERO_HEIGHT - HERO_PAD_Y * 2) : 0)
      return { x, y, period }
    })
  }
  const pointsAttr = () => points().map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  const areaPath = () => {
    const pts = points()
    if (pts.length === 0) return ""
    const base = HERO_HEIGHT - HERO_PAD_Y
    const first = pts[0]
    const last = pts[pts.length - 1]
    const mid = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")
    return `M ${first.x.toFixed(1)},${first.y.toFixed(1)} L ${mid} L ${last.x.toFixed(1)},${base.toFixed(1)} L ${first.x.toFixed(1)},${base.toFixed(1)} Z`
  }

  const handleMove = (event: MouseEvent & { currentTarget: SVGSVGElement }) => {
    const count = list().length
    if (count === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    setHoverIndex(Math.round(ratio * (count - 1)))
  }

  const hovered = () => {
    const index = hoverIndex()
    if (index === null) return null
    return points()[index] ?? null
  }

  const bucketLabel = (start: number) => {
    const date = new Date(start)
    return props.resolution === "hour"
      ? date.toLocaleString(language.intl(), { month: "short", day: "numeric", hour: "numeric" })
      : date.toLocaleDateString(language.intl(), { month: "short", day: "numeric" })
  }

  const formatAxis = (value: number) =>
    props.metric === "cost"
      ? formatUSDCompact(value, language.intl())
      : props.metric === "tokens"
        ? formatTokens(value, language.intl())
        : formatNumber(value, language.intl())

  const gridLines = () => {
    const top = max()
    return Array.from({ length: HERO_GRID_LINES + 1 }, (_, i) => {
      const value = top > 0 ? (top / HERO_GRID_LINES) * (HERO_GRID_LINES - i) : 0
      const y = HERO_PAD_Y + ((HERO_HEIGHT - HERO_PAD_Y * 2) / HERO_GRID_LINES) * i
      return { value, y }
    })
  }

  const xLabels = () => {
    const pts = points()
    if (pts.length < 2) return []
    const mid = pts[Math.floor((pts.length - 1) / 2)]
    return [pts[0], mid, pts[pts.length - 1]]
  }

  return (
    <Show
      when={list().length > 1}
      fallback={
        <div class="flex h-[240px] items-center justify-center text-[11px] font-[440] text-v2-text-text-faint">
          —
        </div>
      }
    >
      <div class="flex gap-2">
        <div
          class="flex shrink-0 flex-col justify-between py-1 text-right"
          style={{ width: `${HERO_AXIS_COLUMN}px`, height: `${HERO_HEIGHT}px` }}
        >
          <For each={gridLines()}>
            {(line) => (
              <span class="text-[9px] font-[500] tabular-nums leading-none text-v2-text-text-faint">{formatAxis(line.value)}</span>
            )}
          </For>
        </div>
        <div class="relative min-w-0 flex-1">
          <svg
            viewBox={`0 0 ${HERO_WIDTH} ${HERO_HEIGHT}`}
            class="w-full cursor-crosshair"
            style={{ height: `${HERO_HEIGHT}px` }}
            preserveAspectRatio="none"
            aria-hidden="true"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <defs>
              <linearGradient id="usage-hero-area-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--usage-accent, var(--v2-text-text-accent))" stop-opacity="0.24" />
                <stop offset="100%" stop-color="var(--usage-accent, var(--v2-text-text-accent))" stop-opacity="0" />
              </linearGradient>
            </defs>
            <For each={gridLines()}>
              {(line) => (
                <line
                  x1="0"
                  y1={line.y}
                  x2={HERO_WIDTH}
                  y2={line.y}
                  stroke="var(--v2-border-border-muted)"
                  stroke-width="1"
                  stroke-dasharray="1,4"
                />
              )}
            </For>
            <path d={areaPath()} fill="url(#usage-hero-area-fill)" />
            <polyline points={pointsAttr()} fill="none" stroke="var(--usage-accent-strong, var(--v2-text-text-accent))" stroke-width="2" stroke-linejoin="round" />
            <Show when={hovered()}>
              {(point) => (
                <line
                  x1={point().x}
                  y1={HERO_PAD_Y}
                  x2={point().x}
                  y2={HERO_HEIGHT - HERO_PAD_Y}
                  stroke="var(--usage-line, var(--v2-border-border-strong))"
                  stroke-width="1"
                  stroke-dasharray="2,2"
                />
              )}
            </Show>
          </svg>

          <Show when={hovered()}>
            {(point) => (
              <>
                {/* Plain HTML (not SVG) so the non-uniform viewBox scaling doesn't stretch the dot into an ellipse. */}
                <div
                  class="pointer-events-none absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-v2-background-bg-base"
                  style={{
                    left: `${(point().x / HERO_WIDTH) * 100}%`,
                    top: `${(point().y / HERO_HEIGHT) * 100}%`,
                    "background-color": "var(--usage-accent-strong, var(--v2-text-text-accent))",
                  }}
                />
                <div
                  class="pointer-events-none absolute top-0 z-10 rounded-md border border-v2-border-border-muted bg-v2-background-bg-overlay px-2 py-1.5 shadow-[var(--v2-elevation-raised)]"
                  style={{
                    left: `${Math.min(82, Math.max(0, (point().x / HERO_WIDTH) * 100))}%`,
                    transform: point().x / HERO_WIDTH > 0.78 ? "translateX(-100%)" : "translateX(4px)",
                  }}
                >
                  <UsageTooltipContent
                    title={bucketLabel(point().period.start)}
                    rows={[
                      { label: language.t("usage.metric.cost"), value: formatUSD(point().period.cost, language.intl()) },
                      { label: language.t("usage.metric.tokens"), value: formatTokens(point().period.tokens, language.intl()) },
                      { label: language.t("usage.table.requests"), value: formatNumber(point().period.messages, language.intl()) },
                    ]}
                  />
                </div>
              </>
            )}
          </Show>
        </div>
      </div>
      <div
        class="flex items-center justify-between pt-1.5 text-[9px] font-[520] uppercase leading-3 tracking-[0.04em] text-v2-text-text-faint"
        style={{ "margin-left": `${HERO_AXIS_COLUMN + 8}px` }}
      >
        <For each={xLabels()}>{(point) => <span>{bucketLabel(point.period.start)}</span>}</For>
      </div>
    </Show>
  )
}

/** One horizontal proportional bar with a label, share and optional sub-value — hover shows the exact figures. */
export function UsageBarRow(props: {
  label: string
  value: number
  max: number
  display: string
  share?: number
  tooltipRows?: { label: string; value: string }[]
}) {
  const language = useLanguage()
  const fraction = () => (props.max > 0 ? Math.max(0, Math.min(1, props.value / props.max)) : 0)
  const rows = () =>
    props.tooltipRows ?? [
      { label: language.t("usage.metric.cost"), value: props.display },
      ...(props.share !== undefined ? [{ label: language.t("usage.table.share"), value: `${Math.round(props.share * 100)}%` }] : []),
    ]

  return (
    <TooltipV2 placement="top" value={<UsageTooltipContent title={props.label} rows={rows()} />} class="w-full">
      <div class="flex w-full items-center gap-2">
        <span class="w-24 shrink-0 truncate text-[10px] font-[440] leading-3 text-v2-text-text-muted">{props.label}</span>
        <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-v2-background-bg-layer-03">
          <div
            class="h-full rounded-full"
            style={{
              width: `${fraction() * 100}%`,
              "background-color": "var(--usage-accent-strong, var(--v2-text-text-accent))",
            }}
          />
        </div>
        <span class="w-16 shrink-0 text-right text-[10px] font-[520] leading-3 tabular-nums text-v2-text-text-base">
          {props.display}
        </span>
        <Show when={props.share !== undefined}>
          <span class="w-9 shrink-0 text-right text-[10px] font-[440] leading-3 tabular-nums text-v2-text-text-faint">
            {Math.round((props.share ?? 0) * 100)}%
          </span>
        </Show>
      </div>
    </TooltipV2>
  )
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** 7 day-of-week bars. */
export function UsageDOWChart(props: { dow: Summary["dow"] }) {
  const language = useLanguage()
  const max = () => Math.max(...props.dow.map((bucket) => bucket.messages), 1)
  return (
    <div class="flex items-end gap-1">
      <For each={props.dow}>
        {(bucket, index) => {
          const height = () => `${Math.max(4, (bucket.messages / max()) * 40)}px`
          return (
            <TooltipV2
              placement="top"
              value={
                <UsageTooltipContent
                  title={DOW_LABELS[index()]}
                  rows={[
                    { label: language.t("usage.table.requests"), value: formatNumber(bucket.messages, language.intl()) },
                    { label: language.t("usage.metric.cost"), value: formatUSD(bucket.cost, language.intl()) },
                    { label: language.t("usage.metric.tokens"), value: formatTokens(bucket.tokens, language.intl()) },
                  ]}
                />
              }
              class="flex-1"
            >
              <div class="flex w-full flex-col items-center gap-1">
                <div
                  class="w-full rounded-sm"
                  style={{
                    height: height(),
                    "background-color": bucket.messages > 0 ? "var(--usage-accent, var(--v2-text-text-accent))" : "var(--usage-track, var(--v2-background-bg-layer-03))",
                  }}
                />
              </div>
            </TooltipV2>
          )
        }}
      </For>
    </div>
  )
}

const HOUR_LABEL_EVERY = 3

/** 24 hour-of-day bars with sparse 12-hour AM/PM labels. */
export function UsageHourChart(props: { hours: Summary["hours"] }) {
  const language = useLanguage()
  const max = () => Math.max(...props.hours.map((bucket) => bucket.messages), 1)
  const label = (hour: number) => {
    const suffix = hour < 12 ? "AM" : "PM"
    const display = hour % 12 === 0 ? 12 : hour % 12
    return `${display}${suffix}`
  }
  return (
    <div class="flex items-end gap-[3px]">
      <For each={props.hours}>
        {(bucket, index) => {
          const hour = index()
          const height = () => `${Math.max(4, (bucket.messages / max()) * 36)}px`
          return (
            <TooltipV2
              placement="top"
              value={
                <UsageTooltipContent
                  title={label(hour)}
                  rows={[
                    { label: language.t("usage.table.requests"), value: formatNumber(bucket.messages, language.intl()) },
                    { label: language.t("usage.metric.cost"), value: formatUSD(bucket.cost, language.intl()) },
                    { label: language.t("usage.metric.tokens"), value: formatTokens(bucket.tokens, language.intl()) },
                  ]}
                />
              }
              class="flex-1"
            >
              <div class="flex w-full flex-col items-center">
                <div
                  class="w-full rounded-[2px]"
                  style={{
                    height: height(),
                    "background-color": bucket.messages > 0 ? "var(--usage-accent, var(--v2-text-text-accent))" : "var(--usage-track, var(--v2-background-bg-layer-03))",
                  }}
                />
                <Show when={hour % HOUR_LABEL_EVERY === 0}>
                  <span class="mt-1 text-[7px] font-[440] leading-[10px] text-v2-text-text-faint">{label(hour)}</span>
                </Show>
              </div>
            </TooltipV2>
          )
        }}
      </For>
    </div>
  )
}

const HEATMAP_MAX_DAYS = 120
const CELL = 12

/** GitHub-contribution-style monthly token/cost heatmap from day buckets. */
export function UsageHeatmap(props: { days: Summary["days"]; metric: Metric }) {
  const language = useLanguage()
  const cells = () => {
    const days = props.days.slice(-HEATMAP_MAX_DAYS)
    const max = Math.max(...days.map((day) => valueFor(day, props.metric)), 1)
    return days.map((day) => ({
      start: day.start,
      messages: day.messages,
      sessions: day.sessions,
      cost: day.cost,
      tokens: day.tokens,
      level: Math.min(4, Math.ceil((valueFor(day, props.metric) / max) * 4)),
    }))
  }
  const weeks = () => {
    const list = cells()
    if (list.length === 0) return []
    const firstDay = new Date(list[0].start).getDay()
    const weeks: (typeof list)[] = []
    let week: typeof list = []
    for (let i = 0; i < firstDay; i++) week.push({ start: 0, messages: 0, sessions: 0, cost: 0, tokens: 0, level: 0 })
    for (const cell of list) {
      week.push(cell)
      if (week.length === 7) {
        weeks.push(week)
        week = []
      }
    }
    if (week.length > 0) weeks.push(week)
    return weeks
  }
  const fillFor = (level: number) =>
    level === 0
      ? "var(--usage-track, var(--v2-background-bg-layer-03))"
      : `color-mix(in srgb, var(--usage-accent-strong, var(--v2-text-text-accent)) ${12 + level * 22}%, transparent)`

  return (
    <Show
      when={cells().length > 0}
      fallback={<div class="py-1 text-[10px] font-[440] text-v2-text-text-faint">—</div>}
    >
      <div class="flex gap-[3px]">
        <For each={weeks()}>
          {(week) => (
            <div class="flex flex-col gap-[2px]">
              <For each={week}>
                {(cell) => (
                  <Show
                    when={cell.start > 0}
                    fallback={
                      <div
                        class="rounded-[2px]"
                        style={{ width: `${CELL}px`, height: `${CELL}px`, "background-color": fillFor(0) }}
                      />
                    }
                  >
                    <TooltipV2
                      placement="top"
                      value={
                        <UsageTooltipContent
                          title={new Date(cell.start).toLocaleDateString(language.intl(), {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                          })}
                          rows={[
                            { label: language.t("usage.table.turns"), value: formatNumber(cell.messages, language.intl()) },
                            { label: language.t("usage.table.sessions"), value: formatNumber(cell.sessions, language.intl()) },
                            { label: language.t("usage.metric.cost"), value: formatUSD(cell.cost, language.intl()) },
                            { label: language.t("usage.metric.tokens"), value: formatTokens(cell.tokens, language.intl()) },
                          ]}
                        />
                      }
                    >
                      <div
                        class="rounded-[2px]"
                        style={{ width: `${CELL}px`, height: `${CELL}px`, "background-color": fillFor(cell.level) }}
                      />
                    </TooltipV2>
                  </Show>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
