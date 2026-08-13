// Viewport resize handles (west/east/south/southwest/southeast) for the
// freeform/preset device modes. Each handle is an absolutely-positioned hit
// area with the correct resize cursor; pointer + keyboard drags flow through
// the caller's `onResize` handler (drag state + live `{w} × {h}` readout
// live in HostedBrowserWebview). Dense v2 zinc: 8px hit zones, faint on idle,
// accent on hover/active.

import { Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import type { ViewportLayout } from "./browserViewportLayout"

export type ResizeDirection = "west" | "east" | "south" | "southwest" | "southeast"

const HANDLE = 8
const VISIBLE = 3

const DIRECTION_CURSOR: Record<ResizeDirection, string> = {
  west: "cursor-ew-resize",
  east: "cursor-ew-resize",
  south: "cursor-ns-resize",
  southwest: "cursor-nesw-resize",
  southeast: "cursor-nwse-resize",
}

const DIRECTION_LABEL: Record<
  ResizeDirection,
  "browser.resize.left" | "browser.resize.right" | "browser.resize.bottom" | "browser.resize.bottom-left" | "browser.resize.bottom-right"
> = {
  west: "browser.resize.left",
  east: "browser.resize.right",
  south: "browser.resize.bottom",
  southwest: "browser.resize.bottom-left",
  southeast: "browser.resize.bottom-right",
}

export function BrowserViewportResizeHandles(props: {
  layout: ViewportLayout
  activeDirection: ResizeDirection | null
  onPointerDown: (direction: ResizeDirection, event: PointerEvent) => void
  onKeyDown: (direction: ResizeDirection, event: KeyboardEvent) => void
}) {
  const { layout } = props
  const language = useLanguage()

  const handle = (direction: ResizeDirection, style: JSX.CSSProperties) => {
    const active = props.activeDirection === direction
    const handleStyle = style
    return (
      <div
        data-browser-resize-handle={direction}
        role="separator"
        aria-orientation={direction === "south" ? "horizontal" : "vertical"}
        aria-label={language.t(DIRECTION_LABEL[direction])}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
        tabindex="0"
        class={`absolute z-30 touch-none select-none ${DIRECTION_CURSOR[direction]}`}
        style={handleStyle}
        onPointerDown={(event) => props.onPointerDown(direction, event)}
        onKeyDown={(event) => props.onKeyDown(direction, event)}
        data-active={active || undefined}
      >
        <div
          class={`pointer-events-none absolute transition-colors duration-100 ${active ? "bg-v2-text-text-accent" : "bg-v2-border-border-strong"}`}
          style={
            {
              ...(direction.includes("west")
                ? { left: (HANDLE - VISIBLE) / 2, top: 0, bottom: 0, width: VISIBLE }
                : {}),
              ...(direction.includes("east")
                ? { right: (HANDLE - VISIBLE) / 2, top: 0, bottom: 0, width: VISIBLE }
                : {}),
              ...(direction === "south" || direction === "southwest" || direction === "southeast"
                ? { bottom: (HANDLE - VISIBLE) / 2, left: 0, right: 0, height: VISIBLE }
                : {}),
            } as JSX.CSSProperties
          }
        />
      </div>
    )
  }

  return (
    <Show when={!layout.fillsPanel}>
      {handle("west", {
        left: `${layout.viewportX - HANDLE / 2}px`,
        top: `${layout.viewportY + HANDLE}px`,
        bottom: `${layout.viewportY + layout.viewportHeight - HANDLE}px`,
        width: `${HANDLE}px`,
      })}
      {handle("east", {
        left: `${layout.viewportX + layout.viewportWidth - HANDLE / 2}px`,
        top: `${layout.viewportY + HANDLE}px`,
        bottom: `${layout.viewportY + layout.viewportHeight - HANDLE}px`,
        width: `${HANDLE}px`,
      })}
      {handle("south", {
        left: `${layout.viewportX + HANDLE}px`,
        right: `${layout.viewportX + layout.viewportWidth - HANDLE}px`,
        top: `${layout.viewportY + layout.viewportHeight - HANDLE / 2}px`,
        height: `${HANDLE}px`,
      })}
      {handle("southwest", {
        left: `${layout.viewportX - HANDLE / 2}px`,
        top: `${layout.viewportY + layout.viewportHeight - HANDLE / 2}px`,
        width: `${HANDLE}px`,
        height: `${HANDLE}px`,
      })}
      {handle("southeast", {
        left: `${layout.viewportX + layout.viewportWidth - HANDLE / 2}px`,
        top: `${layout.viewportY + layout.viewportHeight - HANDLE / 2}px`,
        width: `${HANDLE}px`,
        height: `${HANDLE}px`,
      })}
    </Show>
  )
}
