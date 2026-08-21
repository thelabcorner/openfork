import { onCleanup, splitProps, type JSX } from "solid-js"

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  /** Called while dragging when size crosses `collapseThreshold`. */
  onCollapseChange?: (collapsed: boolean) => void
  collapseThreshold?: number
  /** Step size (px) used for keyboard resizing. Defaults to 16. */
  keyboardStep?: number
}

// Arrow-key step for accessible resizing without a pointer.
const DEFAULT_KEYBOARD_STEP = 16

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "size",
    "min",
    "max",
    "onResize",
    "onCollapse",
    "onCollapseChange",
    "collapseThreshold",
    "keyboardStep",
    "class",
    "classList",
  ])

  // Tracks the live drag session so pointercancel/unmount can always find
  // and tear down whatever listeners are currently attached.
  let activePointerId: number | null = null
  let cleanupDrag: (() => void) | null = null

  const resolveEdge = () => local.edge ?? (local.direction === "vertical" ? "start" : "end")

  const clamp = (value: number) => Math.min(local.max, Math.max(local.min, value))

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== undefined && e.button !== 0) return
    if (e.detail > 1) return
    e.preventDefault()

    const target = e.currentTarget as HTMLElement
    const edge = resolveEdge()
    const start = local.direction === "horizontal" ? e.clientX : e.clientY
    const rtl = local.direction === "horizontal" && getComputedStyle(target).direction === "rtl"
    const startSize = local.size
    const min = local.min
    const max = local.max
    const threshold = local.collapseThreshold ?? 0
    const onResize = local.onResize
    const onCollapse = local.onCollapse
    const onCollapseChange = local.onCollapseChange
    let current = startSize
    let collapsed = false

    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"

    target.setPointerCapture?.(e.pointerId)
    activePointerId = e.pointerId

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== activePointerId) return
      const pos = local.direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
      const delta =
        local.direction === "vertical"
          ? edge === "end"
            ? pos - start
            : start - pos
          : (edge === "start") !== rtl
            ? start - pos
            : pos - start
      current = startSize + delta
      const nextCollapsed = threshold > 0 && current < threshold
      if (nextCollapsed !== collapsed) {
        collapsed = nextCollapsed
        onCollapseChange?.(collapsed)
      }
      onResize(clamp(current))
    }

    const end = () => {
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      target.releasePointerCapture?.(e.pointerId)
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointercancel", onPointerCancel)
      activePointerId = null
      cleanupDrag = null
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== activePointerId) return
      end()
      if (collapsed) {
        onCollapse?.()
        return
      }
      onCollapseChange?.(false)
    }

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== activePointerId) return
      end()
      onCollapseChange?.(false)
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerCancel)
    cleanupDrag = end
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const step = local.keyboardStep ?? DEFAULT_KEYBOARD_STEP
    const edge = resolveEdge()
    const rtl =
      local.direction === "horizontal" && getComputedStyle(e.currentTarget as HTMLElement).direction === "rtl"

    const growKey =
      local.direction === "vertical" ? (edge === "end" ? "ArrowDown" : "ArrowUp") : rtl ? "ArrowLeft" : "ArrowRight"
    const shrinkKey =
      local.direction === "vertical" ? (edge === "end" ? "ArrowUp" : "ArrowDown") : rtl ? "ArrowRight" : "ArrowLeft"

    let delta = 0
    if (e.key === growKey) delta = step
    else if (e.key === shrinkKey) delta = -step
    else if (e.key === "Home") delta = local.min - local.size
    else if (e.key === "End") delta = local.max - local.size
    else return

    e.preventDefault()
    local.onResize(clamp(local.size + delta))
  }

  // If the handle unmounts mid-drag (panel collapses, route changes), make
  // sure the window-level pointer listeners and body style overrides don't
  // outlive the element.
  onCleanup(() => {
    cleanupDrag?.()
  })

  return (
    <div
      {...rest}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={local.edge ?? (local.direction === "vertical" ? "start" : "end")}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      role="separator"
      aria-orientation={local.direction === "horizontal" ? "vertical" : "horizontal"}
      aria-valuemin={local.min}
      aria-valuemax={local.max}
      aria-valuenow={local.size}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  )
}
