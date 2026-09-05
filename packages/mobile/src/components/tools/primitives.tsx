import { For, Show, createMemo, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { fileDir, fileName } from "../../format"

/**
 * Dense building blocks for tool bodies.
 *
 * These mirror the desktop client's tool primitives so both surfaces present
 * the same information in the same order — but the styling is native to this
 * PWA: class-based rather than `data-slot`, sized off `--font-2xs/xs/sm`, and
 * with no monospace, since styles.css deliberately renders the whole app in one
 * face and leans on `.tnum` for column alignment instead.
 *
 * Rows are 22px and taps are the interaction, so anything clickable gets a full
 * row rather than a small target.
 */

export type Tone = "neutral" | "ok" | "warn" | "bad" | "accent"

/* ── Chip ────────────────────────────────────────────────────────────────── */

export function Chip(props: { children: JSX.Element; tone?: Tone; soft?: boolean }) {
  return <span class={`tchip ${props.tone ?? "neutral"} ${props.soft ? "soft" : ""}`}>{props.children}</span>
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

export function Rows(props: { children: JSX.Element; scroll?: boolean }) {
  return <div class={`trows ${props.scroll ? "scroll" : ""}`}>{props.children}</div>
}

export function Row(props: {
  lead?: JSX.Element
  primary: JSX.Element
  secondary?: JSX.Element
  trailing?: JSX.Element
  tone?: Tone
  /** Paths read better truncated from the left so the filename survives. */
  truncate?: "start" | "end"
  onClick?: () => void
}) {
  return (
    <div
      class={`trow ${props.tone ?? ""} ${props.onClick ? "tappable" : ""}`}
      onClick={
        props.onClick
          ? (event) => {
              event.stopPropagation()
              props.onClick!()
            }
          : undefined
      }
    >
      <Show when={props.lead}>
        <span class="trow-lead">{props.lead}</span>
      </Show>
      <span class={`trow-primary ${props.truncate === "start" ? "rtl" : ""}`}>
        <span>{props.primary}</span>
      </span>
      <Show when={props.secondary}>
        <span class="trow-secondary">{props.secondary}</span>
      </Show>
      <Show when={props.trailing}>
        <span class="trow-trailing">{props.trailing}</span>
      </Show>
    </div>
  )
}

/* ── Bounded list ─────────────────────────────────────────────────────────
   A repo-wide grep or a 200-file status must not push the rest of the
   conversation off a phone screen. Show a head, then let the user ask. */

export function BoundedList<T>(props: {
  items: readonly T[]
  limit?: number
  scroll?: boolean
  children: (item: T, index: number) => JSX.Element
}) {
  const [expanded, setExpanded] = createSignal(false)
  const limit = () => props.limit ?? 8
  const visible = createMemo(() => (expanded() ? props.items : props.items.slice(0, limit())))
  const hidden = createMemo(() => Math.max(0, props.items.length - visible().length))

  return (
    <>
      <Rows scroll={props.scroll && expanded()}>
        <For each={visible()}>{(item, index) => props.children(item, index())}</For>
      </Rows>
      <Show when={hidden() > 0}>
        <button
          class="tmore"
          onClick={(event) => {
            event.stopPropagation()
            setExpanded(true)
          }}
        >
          {hidden()} more
        </button>
      </Show>
      <Show when={expanded() && props.items.length > limit()}>
        <button
          class="tmore"
          onClick={(event) => {
            event.stopPropagation()
            setExpanded(false)
          }}
        >
          Show less
        </button>
      </Show>
    </>
  )
}

/* ── Metric strip ────────────────────────────────────────────────────────── */

export function Stats(props: { items: { label: string; value: string; tone?: Tone }[] }) {
  return (
    <Show when={props.items.length > 0}>
      <div class="tstats">
        <For each={props.items}>
          {(item) => (
            <div class="tstat">
              <span class={`tstat-value tnum ${item.tone ?? ""}`}>{item.value}</span>
              <span class="tstat-label">{item.label}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

/* ── Key/value grid ──────────────────────────────────────────────────────── */

export function Fields(props: { items: { key: string; value: JSX.Element }[] }) {
  return (
    <Show when={props.items.length > 0}>
      <dl class="tfields">
        <For each={props.items}>
          {(item) => (
            <>
              <dt class="tfield-key">{item.key}</dt>
              <dd class="tfield-value">{item.value}</dd>
            </>
          )}
        </For>
      </dl>
    </Show>
  )
}

/* ── Notice ──────────────────────────────────────────────────────────────
   A tool that succeeded but has nothing to show — "skill not found", "already
   up to date". The `Use tool({...})` lines tools append are addressed to the
   model, not the reader, so they sit in a subordinate rail below the message. */

export function Notice(props: { message: string; hints?: readonly string[]; tone?: Tone; children?: JSX.Element }) {
  return (
    <div class={`tnotice ${props.tone ?? ""}`}>
      <div class="tnotice-msg">{props.message}</div>
      {props.children}
      <Show when={props.hints?.length}>
        <div class="tnotice-hints">
          <For each={props.hints}>{(hint) => <div class="tnotice-hint">{hint}</div>}</For>
        </div>
      </Show>
    </div>
  )
}

/* ── Status dot ──────────────────────────────────────────────────────────── */

export function Dot(props: { tone?: Tone; pulse?: boolean }) {
  return <span class={`tdot ${props.tone ?? "neutral"} ${props.pulse ? "pulse" : ""}`} />
}

/* ── Path ────────────────────────────────────────────────────────────────
   Dims the directory so the filename — the part you scan for — carries. */

export function Path(props: { path: string }) {
  const dir = () => fileDir(props.path)
  return (
    <span class="tpath">
      <Show when={dir()}>
        <span class="tpath-dir">{dir()}</span>
      </Show>
      <span class="tpath-name">{fileName(props.path)}</span>
    </span>
  )
}

/* ── Unified diff ────────────────────────────────────────────────────────
   For diffs with no file on disk behind them (a refactor preview), where the
   real diff view has nothing to mount against. Colours only. */

export function DiffLines(props: { text: string }) {
  const lines = createMemo(() => props.text.split("\n"))
  const kind = (line: string) => {
    if (/^(\+\+\+|---|diff |index |@@)/.test(line)) return "meta"
    if (line.startsWith("+")) return "add"
    if (line.startsWith("-")) return "del"
    return ""
  }
  return (
    <div class="tdifflines">
      <For each={lines()}>{(line) => <div class={`tdiffline ${kind(line)}`}>{line || " "}</div>}</For>
    </div>
  )
}
