// Viewport resize handles (west/east/south/southwest/southeast) for the
// freeform/preset device modes — T3Code-style device frame handles: the
// draggable HIT AREA spans the full edge (interaction target > visual
// affordance — don't make the user aim at a thin line), but the VISIBLE grip
// is a small glyph centered on the edge/corner: a double vertical bar on
// west/east, a single horizontal bar on south, a diagonal tick on the
// corners. Faint on idle, brightens on hover/focus, full accent while
// actively dragging.

import { Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { BROWSER_VIEWPORT_RESIZE_RAIL_SIZE, type ResizeDirection, type ViewportLayout } from "./browserViewportLayout"

export type { ResizeDirection } from "./browserViewportLayout"

const HANDLE = BROWSER_VIEWPORT_RESIZE_RAIL_SIZE

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

const GRIP_TONE =
  "bg-v2-border-border-strong/70 group-hover/handle:bg-v2-text-text-accent/80 group-focus-visible/handle:bg-v2-text-text-accent group-data-[active=true]/handle:bg-v2-text-text-accent"

/** How far the glyph floats from the exact edge/corner line, outward (away
 * from the device frame's content), so it doesn't sit flush against the
 * frame border. */
const GRIP_INSET = 4

/** Centers the glyph on the hit area, then nudges it GRIP_INSET further
 * outward along the direction's natural axis so it reads as a distinct
 * floating mark rather than touching the frame edge. */
function gripTransform(direction: ResizeDirection): string {
  switch (direction) {
    case "west":
      return `translate(calc(-50% - ${GRIP_INSET}px), -50%)`
    case "east":
      return `translate(calc(-50% + ${GRIP_INSET}px), -50%)`
    case "south":
      return `translate(-50%, calc(-50% + ${GRIP_INSET}px))`
    case "southwest":
      return `translate(calc(-50% - ${GRIP_INSET}px), calc(-50% + ${GRIP_INSET}px)) rotate(45deg)`
    case "southeast":
      return `translate(calc(-50% + ${GRIP_INSET}px), calc(-50% + ${GRIP_INSET}px)) rotate(-45deg)`
  }
}

/** Small floating glyph — the visible affordance, distinct from the (larger)
 * invisible hit area it sits inside. */
function GripGlyph(props: { direction: ResizeDirection }) {
  if (props.direction === "west" || props.direction === "east") {
    return (
      <div class="pointer-events-none absolute left-1/2 top-1/2 flex gap-[2.5px]" style={{ transform: gripTransform(props.direction) }}>
        <span class={`h-3.5 w-px rounded-full transition-colors duration-100 ${GRIP_TONE}`} />
        <span class={`h-3.5 w-px rounded-full transition-colors duration-100 ${GRIP_TONE}`} />
      </div>
    )
  }
  if (props.direction === "south") {
    return (
      <div class="pointer-events-none absolute left-1/2 top-1/2" style={{ transform: gripTransform(props.direction) }}>
        <span class={`block h-px w-3.5 rounded-full transition-colors duration-100 ${GRIP_TONE}`} />
      </div>
    )
  }
  // southwest / southeast: a single diagonal tick, angled to match the
  // corner's resize direction (matches the ⤡/⤢-style corner grips DevTools
  // and T3Code both use).
  return (
    <div class="pointer-events-none absolute left-1/2 top-1/2" style={{ transform: gripTransform(props.direction) }}>
      <span class={`block h-3 w-px rounded-full transition-colors duration-100 ${GRIP_TONE}`} />
    </div>
  )
}

function ResizeHandleControl(props: {
  direction: ResizeDirection
  style: JSX.CSSProperties
  activeDirection: ResizeDirection | null
  onPointerDown: (direction: ResizeDirection, event: PointerEvent) => void
  onKeyDown: (direction: ResizeDirection, event: KeyboardEvent) => void
}) {
  const language = useLanguage()
  // Read props.activeDirection directly in each reactive spot below (never
  // pre-compute into a local `const active = ...`) — a plain local variable
  // captures the value once at whatever render pass created this JSX and
  // never updates again, which is exactly the bug that made every handle's
  // active/idle highlighting freeze at its very first state.
  return (
    <div
      data-browser-resize-handle={props.direction}
      data-active={props.activeDirection === props.direction || undefined}
      role="separator"
      aria-orientation={props.direction === "south" ? "horizontal" : "vertical"}
      aria-label={language.t(DIRECTION_LABEL[props.direction])}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
      tabindex="0"
      class={`group/handle absolute z-30 touch-none select-none focus-visible:outline-none ${DIRECTION_CURSOR[props.direction]}`}
      style={props.style}
      onPointerDown={(event) => props.onPointerDown(props.direction, event)}
      onKeyDown={(event) => props.onKeyDown(props.direction, event)}
    >
      <GripGlyph direction={props.direction} />
    </div>
  )
}

export function BrowserViewportResizeHandles(props: {
  layout: ViewportLayout
  activeDirection: ResizeDirection | null
  onPointerDown: (direction: ResizeDirection, event: PointerEvent) => void
  onKeyDown: (direction: ResizeDirection, event: KeyboardEvent) => void
}) {
  // NEVER destructure `props` in Solid — `const { layout } = props` reads
  // props.layout's getter exactly once at setup and freezes that value, so
  // this component would render whatever layout existed at first mount
  // forever (in practice: the "fill" default before the store populates,
  // permanently hiding every handle regardless of the mode the user later
  // switches to). Read `props.layout` fresh at each use instead.
  return (
    <Show when={!props.layout.fillsPanel}>
      <ResizeHandleControl
        direction="west"
        activeDirection={props.activeDirection}
        onPointerDown={props.onPointerDown}
        onKeyDown={props.onKeyDown}
        style={{
          left: `${props.layout.viewportX - HANDLE / 2}px`,
          top: `${props.layout.viewportY + HANDLE}px`,
          height: `${Math.max(0, props.layout.viewportHeight - HANDLE * 2)}px`,
          width: `${HANDLE}px`,
        }}
      />
      <ResizeHandleControl
        direction="east"
        activeDirection={props.activeDirection}
        onPointerDown={props.onPointerDown}
        onKeyDown={props.onKeyDown}
        style={{
          left: `${props.layout.viewportX + props.layout.viewportWidth - HANDLE / 2}px`,
          top: `${props.layout.viewportY + HANDLE}px`,
          height: `${Math.max(0, props.layout.viewportHeight - HANDLE * 2)}px`,
          width: `${HANDLE}px`,
        }}
      />
      <ResizeHandleControl
        direction="south"
        activeDirection={props.activeDirection}
        onPointerDown={props.onPointerDown}
        onKeyDown={props.onKeyDown}
        style={{
          left: `${props.layout.viewportX + HANDLE}px`,
          width: `${Math.max(0, props.layout.viewportWidth - HANDLE * 2)}px`,
          top: `${props.layout.viewportY + props.layout.viewportHeight - HANDLE / 2}px`,
          height: `${HANDLE}px`,
        }}
      />
      <ResizeHandleControl
        direction="southwest"
        activeDirection={props.activeDirection}
        onPointerDown={props.onPointerDown}
        onKeyDown={props.onKeyDown}
        style={{
          left: `${props.layout.viewportX - HANDLE / 2}px`,
          top: `${props.layout.viewportY + props.layout.viewportHeight - HANDLE / 2}px`,
          width: `${HANDLE}px`,
          height: `${HANDLE}px`,
        }}
      />
      <ResizeHandleControl
        direction="southeast"
        activeDirection={props.activeDirection}
        onPointerDown={props.onPointerDown}
        onKeyDown={props.onKeyDown}
        style={{
          left: `${props.layout.viewportX + props.layout.viewportWidth - HANDLE / 2}px`,
          top: `${props.layout.viewportY + props.layout.viewportHeight - HANDLE / 2}px`,
          width: `${HANDLE}px`,
          height: `${HANDLE}px`,
        }}
      />
    </Show>
  )
}
