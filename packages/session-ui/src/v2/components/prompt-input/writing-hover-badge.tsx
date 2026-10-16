import { Show } from "solid-js"

export type WritingHoverBadgeValue = {
  kind: "corrected" | "suggestion"
  id: string
  original: string
  replacement?: string
  category?: "spelling" | "grammar"
  x: number
  y: number
}

type Props = {
  value: WritingHoverBadgeValue
  onOpen: () => void
  onReject: () => void
  onClose: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}

/**
 * T3-style compact contextual chip for ordinary, fully editable text.
 * Unlike a ProseMirror mention atom, this is a detached presentation layer:
 * never contenteditable, never modifies the actual prompt DOM.
 */
export function WritingHoverBadge(props: Props) {
  const corrected = () => props.value.kind === "corrected"
  return (
    <div
      data-action="prompt-writing-hover-badge"
      role="group"
      aria-label={corrected() ? "Automatic correction controls" : "Writing suggestion controls"}
      class="fixed z-[112] flex max-w-[calc(100vw-16px)] items-center gap-0.5 rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-0.5 text-v2-text-text-base shadow-lg"
      style={{ left: `${props.value.x}px`, top: `${props.value.y}px` }}
      onPointerDown={(event) => event.preventDefault()}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        event.preventDefault()
        props.onClose()
      }}
    >
      <button type="button"
        data-action="prompt-writing-hover-open"
        class="flex min-w-0 max-w-[238px] items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] leading-4 hover:bg-v2-background-bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-v2-border-border-focus"
        aria-label={corrected() ? `Review correction ${props.value.original} to ${props.value.replacement}` :
          `Review ${props.value.category} suggestion ${props.value.original}`}
        onClick={props.onOpen}>
        <span class="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-v2-background-bg-hover text-[10px] font-semibold text-v2-text-text-muted"
          aria-hidden="true">{corrected() ? "✓" : "!"}</span>
        <span class="shrink-0 text-v2-text-text-muted">
          {corrected() ? "Fixed" : props.value.category === "grammar" ? "Grammar" : "Spelling"}
        </span>
        <span class="min-w-0 truncate font-medium">
          <Show when={corrected()} fallback={props.value.original}>
            {props.value.original} <span class="text-v2-text-text-muted">→</span> {props.value.replacement}
          </Show>
        </span>
      </button>
      <div class="mx-0.5 h-4 w-px shrink-0 bg-v2-border-border-muted" aria-hidden="true" />
      <button type="button"
        data-action="prompt-writing-hover-reject"
        class="flex size-6 shrink-0 items-center justify-center rounded text-v2-text-text-muted hover:bg-v2-background-bg-hover hover:text-v2-text-text-base focus-visible:outline focus-visible:outline-1 focus-visible:outline-v2-border-border-focus"
        aria-label={corrected() ? `Restore ${props.value.original}` : `Dismiss ${props.value.original} suggestion`}
        title={corrected() ? "Restore original spelling" : "Dismiss this suggestion"}
        onClick={props.onReject}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
