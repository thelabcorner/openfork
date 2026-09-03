import { For, Show, type JSX } from "solid-js"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import "./usage-page.css"

/**
 * Usage dashboard primitives.
 *
 * The previous page nested a bordered `MetricCell` inside a bordered
 * `UsageCard` inside a `Section`, so every number arrived wrapped in three
 * boxes and the page read as a scrapbook of unrelated tiles. These replace
 * that with one rule: a `Panel` is the only thing with a border, and
 * everything inside it is separated by hairlines from the shared
 * `--usage-line`. Colours all come from the page-scoped palette in
 * usage-page.css — nothing here reaches for a raw accent token.
 */

export function Panel(props: {
  title?: string
  /** Small right-aligned figure or control in the panel header. */
  accessory?: JSX.Element
  tooltip?: string
  /** Drop the body padding — for panels whose child is a full-bleed table or rule grid. */
  flush?: boolean
  class?: string
  children: JSX.Element
}) {
  return (
    <section
      class={`flex min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--usage-line)] bg-[var(--usage-panel)] ${props.class ?? ""}`}
    >
      <Show when={props.title}>
        <header class="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-[var(--usage-line)] px-3">
          <h3 class="flex min-w-0 items-center gap-1 truncate text-[10px] font-[600] uppercase leading-3 tracking-[0.04em] text-v2-text-text-faint">
            <span class="truncate">{props.title}</span>
            <Show when={props.tooltip}>
              {(tooltip) => (
                <TooltipV2 value={<div class="max-w-64 text-11-regular">{tooltip()}</div>}>
                  <span class="inline-flex shrink-0 text-v2-text-text-faint hover:text-v2-text-text-muted" tabIndex={0}>
                    <IconV2 name="help" size="small" />
                  </span>
                </TooltipV2>
              )}
            </Show>
          </h3>
          <Show when={props.accessory}>
            <div class="flex shrink-0 items-center gap-2">{props.accessory}</div>
          </Show>
        </header>
      </Show>
      <div class={props.flush ? "min-w-0 flex-1" : "min-w-0 flex-1 p-3"}>{props.children}</div>
    </section>
  )
}

/** Hairline-ruled grid — the gaps between children ARE the dividers. Pass
 * either `columns` (an explicit template) or responsive `grid-cols-*` classes. */
export function RuleGrid(props: { columns?: string; class?: string; children: JSX.Element }) {
  return (
    <div
      data-slot="usage-rule-grid"
      class={props.class}
      style={props.columns ? { "grid-template-columns": props.columns } : undefined}
    >
      {props.children}
    </div>
  )
}

export type StatTone = "default" | "accent" | "credit"

const TONE_CLASS: Record<StatTone, string> = {
  default: "text-v2-text-text-base",
  accent: "text-[var(--usage-accent-strong)]",
  credit: "text-[var(--usage-credit)]",
}

/**
 * One figure. Deliberately borderless — it gets its edges from the `RuleGrid`
 * it sits in, so a row of stats reads as one instrument cluster rather than
 * eight separate cards.
 */
export function Stat(props: {
  label: string
  value: string | JSX.Element
  sub?: string
  tooltip?: string
  tone?: StatTone
  /** Optional 0..1 bar under the value — for figures that are a share of something. */
  meter?: number
  size?: "md" | "lg"
}) {
  return (
    <div class="flex min-w-0 flex-col gap-1 px-3 py-2.5">
      <div class="flex min-w-0 items-center gap-1">
        <span class="min-w-0 truncate text-[9px] font-[560] uppercase leading-3 tracking-[0.05em] text-v2-text-text-faint">
          {props.label}
        </span>
        <Show when={props.tooltip}>
          {(tooltip) => (
            <TooltipV2 value={<div class="max-w-64 text-11-regular">{tooltip()}</div>}>
              <span class="inline-flex shrink-0 text-v2-text-text-faint hover:text-v2-text-text-muted" tabIndex={0}>
                <IconV2 name="help" size="small" />
              </span>
            </TooltipV2>
          )}
        </Show>
      </div>
      <span
        class={`min-w-0 truncate tabular-nums ${props.size === "lg" ? "text-[22px] font-[640] leading-7" : "text-[15px] font-[600] leading-5"} ${TONE_CLASS[props.tone ?? "default"]}`}
      >
        {props.value}
      </span>
      <Show when={props.meter !== undefined}>
        <div class="h-[3px] w-full overflow-hidden rounded-full bg-[var(--usage-track)]">
          <div
            class="h-full rounded-full"
            style={{
              width: `${Math.max(0, Math.min(1, props.meter ?? 0)) * 100}%`,
              "background-color": props.tone === "credit" ? "var(--usage-credit)" : "var(--usage-accent)",
            }}
          />
        </div>
      </Show>
      <Show when={props.sub}>
        <span class="truncate text-[9px] font-[440] leading-3 text-v2-text-text-faint">{props.sub}</span>
      </Show>
    </div>
  )
}

/** Empty-state line, sized to sit inside a panel body without collapsing it. */
export function EmptyLine(props: { children: JSX.Element }) {
  return (
    <div class="flex min-h-16 items-center justify-center px-3 text-center text-[10px] font-[440] text-v2-text-text-faint">
      {props.children}
    </div>
  )
}

/**
 * A ranked list row: leading slot, label, proportional bar, value.
 *
 * Replaces the old `UsageBarRow`'s fixed 96px label column, which truncated
 * almost every real model name into uselessness ("Muse Spark 1.2 Fr…"). Here
 * the label takes the remaining space and the bar is a fixed track, so long
 * names stay readable and bars stay comparable across rows.
 */
export function RankRow(props: {
  label: string
  /** Optional secondary label shown under/next to the main one. */
  detail?: string
  leading?: JSX.Element
  /** 0..1 fill. */
  fraction: number
  value: string
  tone?: "default" | "credit"
  tooltip?: JSX.Element
}) {
  const body = (
    <div class="flex w-full items-center gap-2 rounded-[4px] px-1.5 py-1 hover:bg-[var(--usage-hover)]">
      <Show when={props.leading}>
        <span class="flex shrink-0 items-center">{props.leading}</span>
      </Show>
      <span class="min-w-0 flex-1 truncate text-[10px] font-[480] leading-4 text-v2-text-text-muted">
        {props.label}
        <Show when={props.detail}>
          <span class="ml-1.5 text-v2-text-text-faint">{props.detail}</span>
        </Show>
      </span>
      <div class="h-[5px] w-24 shrink-0 overflow-hidden rounded-full bg-[var(--usage-track)]">
        <div
          class="h-full rounded-full"
          style={{
            width: `${Math.max(0, Math.min(1, props.fraction)) * 100}%`,
            "background-color": props.tone === "credit" ? "var(--usage-credit)" : "var(--usage-accent)",
          }}
        />
      </div>
      <span class="w-16 shrink-0 text-right text-[10px] font-[560] leading-4 tabular-nums text-v2-text-text-base">
        {props.value}
      </span>
    </div>
  )
  return (
    <Show when={props.tooltip} fallback={body}>
      <TooltipV2 placement="top" class="w-full" value={props.tooltip}>
        {body}
      </TooltipV2>
    </Show>
  )
}

/** Compact label/value pairs for tooltips — same shape everywhere on the page. */
export function DetailRows(props: { title: string; rows: { label: string; value: string }[] }) {
  return (
    <div class="flex w-max min-w-[150px] max-w-[280px] flex-col gap-1 text-[11px]">
      <span class="truncate text-[9px] font-[600] uppercase tracking-[0.04em] text-v2-text-text-faint">{props.title}</span>
      <For each={props.rows}>
        {(row) => (
          <div class="flex min-w-0 items-center gap-4">
            <span class="shrink-0 text-v2-text-text-muted">{row.label}</span>
            <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{row.value}</span>
          </div>
        )}
      </For>
    </div>
  )
}

/**
 * Legacy card surface, still used by the hero. Kept so the one section the
 * user was happy with keeps its exact layout while everything around it moves
 * to `Panel`; it now draws from the dashboard palette so it darkens with the
 * rest of the page.
 */
export function UsageCard(props: { class?: string; children: JSX.Element }) {
  return (
    <div class={`rounded-lg border border-[var(--usage-line)] bg-[var(--usage-panel)] p-4 ${props.class ?? ""}`}>
      {props.children}
    </div>
  )
}
