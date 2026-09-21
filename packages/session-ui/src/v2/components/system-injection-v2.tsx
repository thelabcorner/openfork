import { Collapsible } from "@kobalte/core/collapsible"
import { type ComponentProps, For, Show, createMemo, splitProps } from "solid-js"
import "./system-injection-v2.css"

/**
 * Renders the turn's SERVER-INJECTED context (`synthetic: true` text parts).
 *
 * Presentational only: it receives already-projected segments and owns no
 * filtering, classification, or part reads. The timeline decides which parts
 * are injections and keeps the open/closed state, because that state has to
 * survive the virtualizer unmounting this row.
 */
export type SystemInjectionSegment = {
  id: string
  text: string
}

function BracesIcon() {
  return (
    <svg
      data-slot="system-injection-glyph"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M6.4 2.5H5.6C4.71634 2.5 4 3.21634 4 4.1V6.1C4 6.98366 3.28366 7.7 2.4 7.7H2V8.3H2.4C3.28366 8.3 4 9.01634 4 9.9V11.9C4 12.7837 4.71634 13.5 5.6 13.5H6.4M9.6 2.5H10.4C11.2837 2.5 12 3.21634 12 4.1V6.1C12 6.98366 12.7163 7.7 13.6 7.7H14V8.3H13.6C12.7163 8.3 12 9.01634 12 9.9V11.9C12 12.7837 11.2837 13.5 10.4 13.5H9.6"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linecap="round"
      />
    </svg>
  )
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
  /** Collapsed one-line preview. Falls back to the first segment's first line. */
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
}

function firstLine(text: string) {
  const line = text.split("\n", 1)[0] ?? ""
  return line.trim()
}

export function SystemInjectionCardV2(props: SystemInjectionCardV2Props) {
  const [local, rest] = splitProps(props, [
    "badge",
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
    "class",
    "classList",
  ])

  const preview = createMemo(() => local.preview ?? firstLine(local.segments[0]?.text ?? ""))
  const count = createMemo(() => local.segments.length)
  const joined = createMemo(() => local.segments.map((segment) => segment.text).join("\n\n"))

  return (
    <Collapsible
      {...rest}
      data-component="system-injection"
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
          <BracesIcon />
          {local.badge}
        </span>
        <Show when={count() > 1}>
          <span data-slot="system-injection-count">{count()}</span>
        </Show>
        <span data-slot="system-injection-preview">{preview()}</span>
        <span data-slot="system-injection-chevron-wrap">
          <ChevronIcon />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content data-slot="system-injection-content">
        <div data-slot="system-injection-body" data-scrollable="true">
          <For each={local.segments}>
            {(segment, index) => (
              <div data-slot="system-injection-segment">
                <Show when={count() > 1}>
                  <div data-slot="system-injection-segment-index">{index() + 1}</div>
                </Show>
                <div data-slot="system-injection-text">{segment.text}</div>
              </div>
            )}
          </For>
        </div>
        <Show when={local.onCopy}>
          {(onCopy) => (
            <div data-slot="system-injection-actions">
              <button
                type="button"
                data-slot="system-injection-copy"
                data-copied={local.copied ? "true" : undefined}
                onClick={() => onCopy()(joined())}
              >
                <CopyIcon />
                {local.copied ? (local.copiedLabel ?? local.copyLabel) : local.copyLabel}
              </button>
            </div>
          )}
        </Show>
      </Collapsible.Content>
    </Collapsible>
  )
}
