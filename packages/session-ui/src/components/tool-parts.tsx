import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"

/**
 * Dense building blocks for tool output.
 *
 * Every tool used to fall back to a JSON dump plus a markdown blob, which is
 * why expanded rows read as noise. These primitives are the vocabulary that
 * replaces that: a param strip, dense list rows, metric strips, and bounded
 * lists. They are deliberately small and compose-able so a new tool renderer is
 * a handful of lines rather than a bespoke stylesheet.
 *
 * Sizing is fixed and tight on purpose — 20px rows, 11.5px mono for anything
 * you might copy (paths, ids, commands), 12px sans for prose.
 */

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "accent"

/* ── Params ────────────────────────────────────────────────────────────────
   Replaces the "INPUT" JSON block. Scalars become inline chips; long strings
   get their own full-width row so they stay readable. */

const PARAM_SKIP = new Set(["action", "mode"])

function paramValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.length ? `${value.length} items` : undefined
  return undefined
}

export function ToolParams(props: { input?: Record<string, unknown>; skip?: string[]; longThreshold?: number }) {
  const entries = createMemo(() => {
    const input = props.input
    if (!input) return []
    const skip = new Set([...PARAM_SKIP, ...(props.skip ?? [])])
    return Object.entries(input)
      .filter(([key]) => !skip.has(key))
      .flatMap(([key, raw]) => {
        const value = paramValue(raw)
        if (value === undefined || value === "") return []
        return [{ key, value, long: value.length > (props.longThreshold ?? 48) }]
      })
  })

  return (
    <Show when={entries().length > 0}>
      <div data-component="tool-params">
        <For each={entries()}>
          {(entry) => (
            <div data-slot="tool-param" data-long={entry.long ? "true" : undefined}>
              <span data-slot="tool-param-key">{entry.key}</span>
              <span data-slot="tool-param-value">{entry.value}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

/* ── Section ─────────────────────────────────────────────────────────────── */

export function ToolBlock(props: { label?: string; trailing?: JSX.Element; children: JSX.Element }) {
  return (
    <div data-component="tool-block">
      <Show when={props.label || props.trailing}>
        <div data-slot="tool-block-head">
          <Show when={props.label}>
            <span data-slot="tool-block-label">{props.label}</span>
          </Show>
          <Show when={props.trailing}>
            <span data-slot="tool-block-trailing">{props.trailing}</span>
          </Show>
        </div>
      </Show>
      {props.children}
    </div>
  )
}

/* ── Metric strip ────────────────────────────────────────────────────────── */

export function ToolStats(props: { items: { label: string; value: string; tone?: Tone }[] }) {
  return (
    <Show when={props.items.length > 0}>
      <div data-component="tool-stats">
        <For each={props.items}>
          {(item) => (
            <div data-slot="tool-stat">
              <span data-slot="tool-stat-value" data-tone={item.tone}>
                {item.value}
              </span>
              <span data-slot="tool-stat-label">{item.label}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

/* ── Badge ───────────────────────────────────────────────────────────────── */

export function ToolBadge(props: { children: JSX.Element; tone?: Tone; mono?: boolean }) {
  return (
    <span data-component="tool-badge" data-tone={props.tone} data-mono={props.mono ? "true" : undefined}>
      {props.children}
    </span>
  )
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

export function ToolRows(props: { children: JSX.Element; scroll?: boolean }) {
  return (
    <div data-component="tool-rows" data-scroll={props.scroll ? "true" : undefined}>
      {props.children}
    </div>
  )
}

export function ToolRow(props: {
  lead?: JSX.Element
  /** Primary identifier — rendered mono, truncates from the left for paths. */
  primary: JSX.Element
  secondary?: JSX.Element
  trailing?: JSX.Element
  tone?: Tone
  mono?: boolean
  truncate?: "start" | "end"
  onClick?: () => void
}) {
  return (
    <div
      data-component="tool-row"
      data-tone={props.tone}
      data-clickable={props.onClick ? "true" : undefined}
      onClick={props.onClick}
    >
      <Show when={props.lead}>
        <span data-slot="tool-row-lead">{props.lead}</span>
      </Show>
      <span
        data-slot="tool-row-primary"
        data-mono={props.mono === false ? undefined : "true"}
        data-truncate={props.truncate}
      >
        <span>{props.primary}</span>
      </span>
      <Show when={props.secondary}>
        <span data-slot="tool-row-secondary">{props.secondary}</span>
      </Show>
      <Show when={props.trailing}>
        <span data-slot="tool-row-trailing">{props.trailing}</span>
      </Show>
    </div>
  )
}

/* ── Bounded list ─────────────────────────────────────────────────────────
   Long tool output (a 200-file git status) should not push the conversation
   off-screen. Show a head, then an explicit opt-in for the rest. */

export function ToolBoundedList<T>(props: {
  items: readonly T[]
  limit?: number
  children: (item: T, index: number) => JSX.Element
  scroll?: boolean
}) {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const limit = () => props.limit ?? 8
  const visible = createMemo(() => (expanded() ? props.items : props.items.slice(0, limit())))
  const hidden = createMemo(() => Math.max(0, props.items.length - visible().length))

  return (
    <>
      <ToolRows scroll={props.scroll && expanded()}>
        <For each={visible()}>{(item, index) => props.children(item, index())}</For>
      </ToolRows>
      <Show when={hidden() > 0}>
        <button type="button" data-component="tool-more" onClick={() => setExpanded(true)}>
          {i18n.t("ui.toolParts.showMore", { count: hidden() })}
        </button>
      </Show>
      <Show when={expanded() && props.items.length > limit()}>
        <button type="button" data-component="tool-more" onClick={() => setExpanded(false)}>
          {i18n.t("ui.toolParts.showLess")}
        </button>
      </Show>
    </>
  )
}

/* ── Empty ───────────────────────────────────────────────────────────────── */

export function ToolEmpty(props: { children: JSX.Element }) {
  return <div data-component="tool-empty">{props.children}</div>
}

/* ── Key/value detail grid ───────────────────────────────────────────────── */

export function ToolFields(props: { items: { key: string; value: JSX.Element; mono?: boolean }[] }) {
  return (
    <Show when={props.items.length > 0}>
      <dl data-component="tool-fields">
        <For each={props.items}>
          {(item) => (
            <>
              <dt data-slot="tool-field-key">{item.key}</dt>
              <dd data-slot="tool-field-value" data-mono={item.mono ? "true" : undefined}>
                {item.value}
              </dd>
            </>
          )}
        </For>
      </dl>
    </Show>
  )
}

/* ── Path ────────────────────────────────────────────────────────────────
   Dims the directory so the filename — the part you scan for — carries. */

export function ToolPath(props: { path: string }) {
  const parts = createMemo(() => {
    const normalized = props.path.replace(/\\/g, "/")
    const index = normalized.lastIndexOf("/")
    if (index < 0) return { dir: "", name: normalized }
    return { dir: normalized.slice(0, index + 1), name: normalized.slice(index + 1) }
  })
  return (
    <span data-component="tool-path">
      <Show when={parts().dir}>
        <span data-slot="tool-path-dir">{parts().dir}</span>
      </Show>
      <span data-slot="tool-path-name">{parts().name}</span>
    </span>
  )
}
