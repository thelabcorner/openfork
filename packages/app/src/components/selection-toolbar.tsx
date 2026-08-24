import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { createTextSelection } from "@/hooks/useTextSelection"
import "./selection-toolbar.css"

export type SelectionToolbarAction = {
  id: string
  label: string
  icon?: string
  shortcut?: string
  onSelect: (text: string, range: Range | null) => void
}

export function SelectionToolbar(props: {
  container: () => HTMLElement | undefined | null
  actions: SelectionToolbarAction[]
  enabled?: () => boolean
}) {
  const selection = createTextSelection({ container: props.container, enabled: props.enabled })
  const [pos, setPos] = createSignal<{ left: number; top: number; flipped: boolean } | null>(null)
  let toolbarRef: HTMLDivElement | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const toolbarWidth = 260 // estimated; measured after mount

  const updatePosition = () => {
    const rect = selection.state().rect
    if (!rect || !selection.visible()) {
      setPos(null)
      return
    }
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = toolbarRef?.offsetWidth ?? toolbarWidth
    const h = toolbarRef?.offsetHeight ?? 40
    const gap = 8
    let left = rect.left + rect.width / 2 - w / 2
    left = Math.max(8, Math.min(left, vw - w - 8))
    let flipped = false
    let top = rect.top - h - gap
    if (top < 8) {
      top = rect.bottom + gap
      flipped = true
    }
    // Clamp vertically
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8)
    setPos({ left, top, flipped })
  }

  createEffect(() => {
    // Recompute when selection becomes visible or rect changes
    void selection.visible()
    void selection.state().rect
    if (!selection.visible()) {
      setPos(null)
      return
    }
    // Next frame so toolbarRef is measured
    requestAnimationFrame(() => requestAnimationFrame(updatePosition))
  })

  // Reposition on scroll/resize
  createEffect(() => {
    const onReposition = () => {
      if (selection.visible()) updatePosition()
    }
    window.addEventListener("scroll", onReposition, true)
    window.addEventListener("resize", onReposition)
    onCleanup(() => {
      window.removeEventListener("scroll", onReposition, true)
      window.removeEventListener("resize", onReposition)
    })
  })

  // Dismiss on click outside, Escape, or mousedown on toolbar shouldn't clear selection
  createEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!selection.visible()) return
      const t = e.target as Element | null
      if (toolbarRef?.contains(t as Node)) return
      // Small delay — allow toolbar button click to fire before we hide
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        // If selection is still the same, keep — mousedown outside often collapses it anyway
        // selectionchange will hide it; no need to force
      }, 10)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") selection.clear()
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown)
      if (hideTimer) clearTimeout(hideTimer)
    })
  })

  const handleAction = (action: SelectionToolbarAction) => {
    const text = selection.state().text
    const range = selection.state().range
    action.onSelect(text, range)
    // Keep selection visible briefly so user sees feedback, then clear? Design: toolbar stays until selection changes
  }

  return (
    <Show when={selection.visible() && pos()}>
      {(p) => (
        <Portal>
          <div
            ref={toolbarRef}
            data-component="selection-toolbar"
            data-flipped={p().flipped ? "" : undefined}
            style={{
              left: `${p().left}px`,
              top: `${p().top}px`,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div data-component="selection-toolbar-arrow" aria-hidden="true" />
            <For each={props.actions}>
              {(action, idx) => (
                <>
                  <Show when={idx() > 0}>
                    <div data-slot="selection-toolbar-separator" aria-hidden="true" />
                  </Show>
                  <button
                    type="button"
                    data-slot="selection-toolbar-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleAction(action)}
                  >
                    <Show when={action.icon}>
                      <span data-slot="selection-toolbar-icon">
                        <Icon name={action.icon as any} size="small" />
                      </span>
                    </Show>
                    {action.label}
                  </button>
                </>
              )}
            </For>
          </div>
        </Portal>
      )}
    </Show>
  )
}
