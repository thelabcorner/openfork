import { For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"

export function Section(props: { title: string; value?: string; tooltip?: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-2">
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="flex items-center gap-1 text-[10px] font-[600] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
          <span>{props.title}</span>
          <Show when={props.tooltip}>
            {(tooltip) => (
              <TooltipV2 value={<div class="max-w-64 text-11-regular">{tooltip()}</div>}>
                <span class="inline-flex text-v2-text-text-faint hover:text-v2-text-text-muted" tabIndex={0}>
                  <IconV2 name="help" size="small" />
                </span>
              </TooltipV2>
            )}
          </Show>
        </h3>
        <Show when={props.value}>
          <span class="text-[10px] font-[520] tabular-nums text-v2-text-text-muted">{props.value}</span>
        </Show>
      </div>
      {props.children}
    </section>
  )
}

function LiveDot(props: { color?: string }) {
  return (
    <span class="relative flex size-1.5 shrink-0">
      <span
        class="absolute inline-flex size-full animate-ping rounded-full opacity-60"
        style={{ "background-color": props.color ?? "var(--syntax-success)" }}
      />
      <span class="relative inline-flex size-1.5 rounded-full" style={{ "background-color": props.color ?? "var(--syntax-success)" }} />
    </span>
  )
}

export function MetricCell(props: {
  label: string
  value: string | JSX.Element
  sub?: string
  tooltip?: string
  live?: boolean
  accent?: boolean
}) {
  return (
    <div class="flex min-w-0 flex-col gap-0.5 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1.5">
      <div class="flex items-center gap-1">
        <Show when={props.live}>
          <LiveDot />
        </Show>
        <span class="min-w-0 truncate text-[9px] font-[500] uppercase leading-3 tracking-[0.02em] text-v2-text-text-faint">
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
        class="min-w-0 truncate text-[13px] font-[600] leading-4 tabular-nums text-v2-text-text-base"
        classList={{ "text-v2-text-text-accent": !!props.accent }}
      >
        {props.value}
      </span>
      <Show when={props.sub}>
        <span class="truncate text-[9px] font-[440] leading-3 text-v2-text-text-faint">{props.sub}</span>
      </Show>
    </div>
  )
}

export function SegmentedTabs(props: {
  value: string
  onChange: (value: string) => void
  onIntent?: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div class="flex min-w-0 flex-1 items-center rounded-md bg-v2-background-bg-layer-02 p-0.5" role="tablist">
      <For each={props.options}>
        {(option) => {
          const active = () => props.value === option.value
          return (
            <button
              type="button"
              class="h-5 flex-1 rounded-[5px] px-2 text-[10px] font-[560] leading-5 transition-colors"
              classList={{
                "bg-v2-background-bg-base text-v2-text-text-base shadow-[var(--v2-elevation-switch-on)]": active(),
                "text-v2-text-text-muted hover:text-v2-text-text-base": !active(),
              }}
              onClick={() => props.onChange(option.value)}
              onPointerEnter={() => props.onIntent?.(option.value)}
              onFocus={() => props.onIntent?.(option.value)}
              aria-pressed={active()}
              role="tab"
              aria-selected={active()}
            >
              {option.label}
            </button>
          )
        }}
      </For>
    </div>
  )
}

export function PageTab(props: { active: boolean; label: string; onClick: () => void }) {
  const active = () => props.active
  return (
    <button
      type="button"
      class="h-5 flex-1 rounded-[5px] px-2 text-[10px] font-[560] leading-5 transition-colors"
      classList={{
        "bg-v2-background-bg-base text-v2-text-text-base shadow-[var(--v2-elevation-switch-on)]": active(),
        "text-v2-text-text-muted": !active(),
      }}
      onClick={props.onClick}
      aria-pressed={active()}
    >
      {props.label}
    </button>
  )
}
