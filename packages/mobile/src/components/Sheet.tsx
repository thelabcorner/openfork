import type { JSX } from "solid-js"
import { Show, onCleanup, onMount } from "solid-js"
import { IconX } from "../icons"

export function Sheet(props: {
  open: boolean
  onClose: () => void
  title?: string
  height?: "auto" | "half" | "tall" | "full"
  children: JSX.Element
}) {
  onMount(() => {
    onCleanup(() => {
      document.body.style.overflow = ""
    })
  })

  return (
    <Show when={props.open}>
      <div
        class="sheet-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
      >
        <div class={`sheet h-${props.height ?? "auto"}`}>
          <div class="sheet-handle-row">
            <div class="sheet-handle" />
          </div>
          <Show when={props.title}>
            <div class="sheet-header">
              <h2 class="sheet-title">{props.title}</h2>
              <button class="sheet-close" onClick={props.onClose} aria-label="Close">
                <IconX size={15} />
              </button>
            </div>
          </Show>
          <div class="sheet-body">{props.children}</div>
          <div class="sheet-safe-bottom" />
        </div>
      </div>
    </Show>
  )
}
