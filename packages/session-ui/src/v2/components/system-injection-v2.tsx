import { Collapsible } from "@kobalte/core/collapsible"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ScrollViewOverlayScrollbar } from "@opencode-ai/ui/scroll-view"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import {
  type ComponentProps,
  For,
  Show,
  createMemo,
  createSignal,
  splitProps,
} from "solid-js"
import { Markdown } from "../../components/markdown"
import {
  hasInjectionStructure,
  injectionAttributeTone,
  injectionContentPreview,
  injectionContentTone,
  injectionTagPresentation,
  parseInjectionContent,
  type InjectionAttribute,
  type InjectionNode,
  type InjectionTone,
  type SystemInjectionKind,
} from "./system-injection-content"
import "./system-injection-v2.css"

/**
 * Renders the turn's SERVER-INJECTED context: `synthetic: true` text parts on a
 * user turn, first-class system/skill context rows, and whole automation turns
 * whose provenance gives them Synthetic semantics.
 *
 * Presentational only: it receives already-projected segments and owns no
 * filtering, classification, or part reads. The timeline decides which parts
 * are injections and keeps the open/closed state, because that state has to
 * survive the virtualizer unmounting this row.
 *
 * Collapsed it is a quiet right-aligned pill in the prompt column. Expanded it
 * becomes a full-width panel, because the payloads are real documents: XML-ish
 * envelopes around markdown bodies. The envelope is parsed into titled frames,
 * status pills and key/value chips; every leaf body goes through the same
 * markdown renderer the assistant's own text uses, inside a scroll viewport
 * wearing the app's overlay scrollbar.
 */
export type SystemInjectionSegment = {
  id: string
  text: string
}

export type { SystemInjectionKind }

const KIND_ICON: Record<SystemInjectionKind, string> = {
  system: "status",
  skill: "star",
  task: "layers",
  shell: "monitor",
  goal: "review",
  plan: "check",
  schedule: "clock",
  recovery: "reset",
  compaction: "compact",
  swarm: "branch",
  oxp: "chats",
  audit: "shield-check",
  title: "pencil-sparkles",
  automation: "cache",
}

function ChevronIcon() {
  return (
    <svg
      data-slot="system-injection-chevron"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M5.90795 9.62425C5.61628 9.81865 5.25 9.57825 5.25 9.19235V4.80837C5.25 4.42247 5.61628 4.18204 5.90795 4.37648L9.1959 6.56846C9.48535 6.7614 9.48535 7.2393 9.1959 7.43224L5.90795 9.62425Z"
        fill="currentColor"
      />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.75" stroke="currentColor" stroke-width="1.1" />
      <path
        d="M10.25 5.75V4.5C10.25 3.5335 9.4665 2.75 8.5 2.75H4.5C3.5335 2.75 2.75 3.5335 2.75 4.5V8.5C2.75 9.4665 3.5335 10.25 4.5 10.25H5.75"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linecap="round"
      />
    </svg>
  )
}

export interface SystemInjectionCardV2Props extends Omit<ComponentProps<"div">, "children" | "onCopy"> {
  /** Badge text, e.g. "System". */
  badge: string
  /** Semantic family; selects the glyph. Defaults to `system`. */
  kind?: SystemInjectionKind
  /** Accent override. When unset the tone is derived from the payload itself. */
  tone?: InjectionTone
  /** Collapsed one-line preview. Falls back to the payload's own summary. */
  preview?: string
  segments: readonly SystemInjectionSegment[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Accessible label for the trigger, toggled by `open`. */
  expandLabel: string
  collapseLabel: string
  copyLabel?: string
  copiedLabel?: string
  copied?: boolean
  onCopy?: (text: string) => void
  /** Labels for the rich/raw toggle, shown only when the payload has structure. */
  rawLabel?: string
  richLabel?: string
  /** Called after the expanded body changes size, so the virtualizer can remeasure. */
  onContentResize?: () => void
}

type ParsedSegment = {
  id: string
  text: string
  nodes: InjectionNode[]
  structured: boolean
}

export function SystemInjectionCardV2(props: SystemInjectionCardV2Props) {
  const [local, rest] = splitProps(props, [
    "badge",
    "kind",
    "tone",
    "preview",
    "segments",
    "open",
    "onOpenChange",
    "expandLabel",
    "collapseLabel",
    "copyLabel",
    "copiedLabel",
    "copied",
    "onCopy",
    "rawLabel",
    "richLabel",
    "onContentResize",
    "class",
    "classList",
  ])
  const i18n = useI18n()
  const [raw, setRaw] = createSignal(false)
  const [viewport, setViewport] = createSignal<HTMLDivElement>()
  const [shell, setShell] = createSignal<HTMLDivElement>()

  // Parsing is line-scanning over text the store already holds, and only runs
  // for segments this card actually draws. Memoized so re-renders from hover or
  // copy state never re-walk a multi-kilobyte reminder.
  const parsed = createMemo<ParsedSegment[]>(() =>
    local.segments.map((segment) => {
      const nodes = parseInjectionContent(segment.text)
      return { id: segment.id, text: segment.text, nodes, structured: hasInjectionStructure(nodes) }
    }),
  )

  // Callers derive their preview from the first non-blank line, which for an
  // enveloped payload is the machine open tag (`<task id="ses_…" state="…">`).
  // When the caller handed us one of those, the parsed summary is strictly
  // better; otherwise the caller knows something we don't (a skill's name).
  const preview = createMemo(() => {
    const given = local.preview?.trim()
    if (given && !given.startsWith("<")) return given
    for (const segment of parsed()) {
      const value = injectionContentPreview(segment.nodes)
      if (value) return value
    }
    return given ?? ""
  })

  // The leading status of the payload is worth showing before expanding: a
  // failed background task should read as failed from the collapsed row.
  const status = createMemo(() => {
    for (const segment of parsed()) {
      const found = findStatusAttribute(segment.nodes)
      if (found) return found
    }
  })

  const tone = createMemo<InjectionTone>(() => {
    if (local.tone) return local.tone
    for (const segment of parsed()) {
      const derived = injectionContentTone(segment.nodes)
      if (derived) return derived
    }
    return "neutral"
  })

  const structured = createMemo(() => parsed().some((segment) => segment.structured))
  const count = createMemo(() => local.segments.length)
  const joined = createMemo(() => local.segments.map((segment) => segment.text).join("\n\n"))
  const rich = () => structured() && !raw()

  return (
    <Collapsible
      {...rest}
      data-component="system-injection"
      data-tone={tone()}
      data-kind={local.kind ?? "system"}
      open={local.open}
      onOpenChange={local.onOpenChange}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Collapsible.Trigger
        data-slot="system-injection-trigger"
        aria-label={local.open ? local.collapseLabel : local.expandLabel}
      >
        <span data-slot="system-injection-badge">
          <Icon name={KIND_ICON[local.kind ?? "system"]} size="small" data-slot="system-injection-glyph" />
          <span data-slot="system-injection-badge-label">{local.badge}</span>
        </span>
        <Show when={status()}>
          {(attribute) => (
            <span data-slot="system-injection-status" data-tone={injectionAttributeTone(attribute()) ?? "neutral"}>
              {attribute().value}
            </span>
          )}
        </Show>
        <span data-slot="system-injection-preview">{preview()}</span>
        <Show when={count() > 1}>
          <span data-slot="system-injection-count">{count()}</span>
        </Show>
        <span data-slot="system-injection-chevron-wrap">
          <ChevronIcon />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content data-slot="system-injection-content">
        <div data-slot="system-injection-scroll" ref={setShell}>
          <div
            data-slot="system-injection-body"
            data-scrollable="true"
            data-view={rich() ? "rich" : "raw"}
            ref={setViewport}
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <For each={parsed()}>
              {(segment, index) => (
                <section data-slot="system-injection-segment">
                  <Show when={count() > 1}>
                    <div data-slot="system-injection-segment-index">{index() + 1}</div>
                  </Show>
                  <Show
                    when={rich()}
                    fallback={<pre data-slot="system-injection-raw">{segment.text}</pre>}
                  >
                    <InjectionNodes nodes={segment.nodes} depth={0} onResize={local.onContentResize} />
                  </Show>
                </section>
              )}
            </For>
          </div>
          <ScrollViewOverlayScrollbar
            viewport={viewport}
            hoverTarget={shell}
            orientation="vertical"
            refresh={() => [rich(), parsed()]}
          />
        </div>
        <div data-slot="system-injection-actions">
          <Show when={structured()}>
            <button
              type="button"
              data-slot="system-injection-view"
              data-active={raw() ? "true" : undefined}
              aria-pressed={raw()}
              onClick={() => {
                setRaw((value) => !value)
                local.onContentResize?.()
              }}
            >
              {raw() ? (local.richLabel ?? "Rich") : (local.rawLabel ?? "Raw")}
            </button>
          </Show>
          <Show when={local.onCopy}>
            {(onCopy) => (
              <button
                type="button"
                data-slot="system-injection-copy"
                data-copied={local.copied ? "true" : undefined}
                onClick={() => onCopy()(joined())}
              >
                <CopyIcon />
                {local.copied ? (local.copiedLabel ?? local.copyLabel) : local.copyLabel}
              </button>
            )}
          </Show>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

const STATUS_NAMES = new Set(["state", "status", "result", "outcome"])

function findStatusAttribute(nodes: readonly InjectionNode[]): InjectionAttribute | undefined {
  for (const node of nodes) {
    if (node.kind !== "element") continue
    const attribute = node.attributes.find((item) => STATUS_NAMES.has(item.name.toLowerCase()) && item.value.trim())
    if (attribute) return attribute
    const nested = findStatusAttribute(node.children)
    if (nested) return nested
  }
  return undefined
}

function InjectionNodes(props: { nodes: readonly InjectionNode[]; depth: number; onResize?: () => void }) {
  return (
    <For each={props.nodes}>
      {(node) =>
        node.kind === "element" ? (
          <InjectionElement node={node} depth={props.depth} onResize={props.onResize} />
        ) : (
          <InjectionMarkdown text={node.text} />
        )
      }
    </For>
  )
}

function InjectionMarkdown(props: { text: string }) {
  return (
    <Show when={/\S/.test(props.text)}>
      <Markdown data-slot="system-injection-markdown" text={props.text} />
    </Show>
  )
}

function InjectionElement(props: {
  node: Extract<InjectionNode, { kind: "element" }>
  depth: number
  onResize?: () => void
}) {
  const presentation = createMemo(() => injectionTagPresentation(props.node.tag))
  // Status-shaped attributes are already drawn as pills on the frame header, so
  // they are not repeated as key/value chips.
  const chips = createMemo(() => props.node.attributes.filter((item) => !injectionAttributeTone(item)))
  const pills = createMemo(() =>
    props.node.attributes.flatMap((item) => {
      const tone = injectionAttributeTone(item)
      return tone && item.value.trim() ? [{ item, tone }] : []
    }),
  )
  const hasHeader = createMemo(() => chips().length > 0 || pills().length > 0)

  return (
    <Show
      when={presentation().role !== "lead"}
      fallback={<p data-slot="system-injection-lead">{props.node.text}</p>}
    >
      <Show
        when={presentation().role !== "field"}
        fallback={
          <div data-slot="system-injection-field">
            <span data-slot="system-injection-field-name">{presentation().label}</span>
            <span data-slot="system-injection-field-value">{props.node.text}</span>
          </div>
        }
      >
        <div
          data-slot="system-injection-block"
          data-role={presentation().role}
          data-tag={props.node.tag}
          data-tone={presentation().tone ?? "neutral"}
          data-depth={Math.min(props.depth, 3)}
        >
          <div data-slot="system-injection-block-head">
            <span data-slot="system-injection-block-label">{presentation().label}</span>
            <Show when={hasHeader()}>
              <span data-slot="system-injection-block-meta">
                <For each={pills()}>
                  {(entry) => (
                    <span data-slot="system-injection-status" data-tone={entry.tone}>
                      {entry.item.value}
                    </span>
                  )}
                </For>
                <For each={chips()}>
                  {(attribute) => (
                    <span data-slot="system-injection-chip" title={`${attribute.name}=${attribute.value}`}>
                      <span data-slot="system-injection-chip-name">{attribute.name}</span>
                      <Show when={attribute.value}>
                        <span data-slot="system-injection-chip-value">{attribute.value}</span>
                      </Show>
                    </span>
                  )}
                </For>
              </span>
            </Show>
          </div>
          <Show when={props.node.children.length > 0}>
            <div data-slot="system-injection-block-body">
              <Show
                when={presentation().body !== "pre"}
                fallback={<pre data-slot="system-injection-pre">{props.node.text}</pre>}
              >
                <InjectionNodes nodes={props.node.children} depth={props.depth + 1} onResize={props.onResize} />
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  )
}
