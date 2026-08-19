import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createStore } from "solid-js/store"

type Axis = "vertical" | "horizontal"

type AxisState = { show: boolean; dragging: boolean; scrolling: boolean; offset: number; size: number }

const TRACK_PADDING = 8
const MIN_THUMB_SIZE = 32

const emptyAxis: AxisState = { show: false, dragging: false, scrolling: false, offset: 0, size: 0 }

/** Overlay scrollbar thumbs for a scroll container, matching the session
 * pane's ScrollView custom-thumb style (thin pill, --border-weak-base, revealed
 * on hover/scroll, draggable). Renders both axes; the overlay never takes
 * layout space and is pointer-events-transparent except on the thumbs. */
export function ProjectExplorerScrollbar(props: {
  viewport: () => HTMLElement | undefined
  hoverTarget?: () => HTMLElement | undefined
  axes?: "both" | "vertical" | "horizontal"
  onScroll?: () => void
}): JSX.Element {
  const axes = () => props.axes ?? "both"
  const [hovered, setHovered] = createSignal(false)
  const [state, setState] = createStore<Record<Axis, AxisState>>({
    vertical: { ...emptyAxis },
    horizontal: { ...emptyAxis },
  })
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const visible = (axis: Axis) => hovered() || state[axis].dragging || state[axis].scrolling

  const update = (axis: Axis) => {
    const viewport = props.viewport()
    if (!viewport) return
    const vertical = axis === "vertical"
    const client = vertical ? viewport.clientHeight : viewport.clientWidth
    const size = vertical ? viewport.scrollHeight : viewport.scrollWidth
    const scroll = vertical ? viewport.scrollTop : viewport.scrollLeft
    if (size <= client) {
      setState(axis, "show", false)
      return
    }
    const trackSize = client - TRACK_PADDING * 2
    const thumbSize = Math.max(MIN_THUMB_SIZE, (client / size) * trackSize)
    const maxScroll = size - client
    const maxOffset = trackSize - thumbSize
    setState(axis, {
      show: true,
      size: thumbSize,
      offset: TRACK_PADDING + (maxScroll > 0 ? (scroll / maxScroll) * maxOffset : 0),
    })
  }

  const markScrolling = () => {
    setState("vertical", "scrolling", true)
    setState("horizontal", "scrolling", true)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      setState("vertical", "scrolling", false)
      setState("horizontal", "scrolling", false)
    }, 800)
  }

  createEffect(() => {
    const viewport = props.viewport()
    if (!viewport) return
    const onScroll = () => {
      update("vertical")
      update("horizontal")
      markScrolling()
      props.onScroll?.()
    }
    viewport.addEventListener("scroll", onScroll, { passive: true })
    createResizeObserver(
      () =>
        [viewport, viewport.firstElementChild].filter(
          (element): element is HTMLElement => element instanceof HTMLElement,
        ),
      onScroll,
    )
    onScroll()
    onCleanup(() => viewport.removeEventListener("scroll", onScroll))
  })

  createEffect(() => {
    const target = props.hoverTarget?.() ?? props.viewport()
    if (!target) return
    const enter = () => setHovered(true)
    const leave = () => setHovered(false)
    target.addEventListener("pointerenter", enter)
    target.addEventListener("pointerleave", leave)
    onCleanup(() => {
      target.removeEventListener("pointerenter", enter)
      target.removeEventListener("pointerleave", leave)
      setHovered(false)
    })
  })

  onCleanup(() => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
  })

  const onThumbPointerDown = (axis: Axis, event: PointerEvent) => {
    const viewport = props.viewport()
    if (!viewport) return
    const thumb = event.currentTarget as HTMLElement
    const vertical = axis === "vertical"
    event.preventDefault()
    event.stopPropagation()
    setState(axis, "dragging", true)
    const rect = thumb.getBoundingClientRect()
    const grabOffset = vertical ? event.clientY - rect.top : event.clientX - rect.left
    thumb.setPointerCapture?.(event.pointerId)

    const onMove = (move: PointerEvent) => {
      const viewportRect = viewport.getBoundingClientRect()
      const coordinate = vertical ? move.clientY - viewportRect.top : move.clientX - viewportRect.left
      const trackSize = (vertical ? viewport.clientHeight : viewport.clientWidth) - TRACK_PADDING * 2
      const maxOffset = trackSize - state[axis].size
      if (maxOffset <= 0) return
      const offset = Math.max(0, Math.min(coordinate - TRACK_PADDING - grabOffset, maxOffset))
      const maxScroll = (vertical ? viewport.scrollHeight : viewport.scrollWidth) - (vertical ? viewport.clientHeight : viewport.clientWidth)
      if (vertical) viewport.scrollTop = (offset / maxOffset) * maxScroll
      else viewport.scrollLeft = (offset / maxOffset) * maxScroll
    }
    const done = (doneEvent: PointerEvent) => {
      setState(axis, "dragging", false)
      thumb.releasePointerCapture?.(doneEvent.pointerId)
      thumb.removeEventListener("pointermove", onMove)
      thumb.removeEventListener("pointerup", done)
      thumb.removeEventListener("pointercancel", done)
    }
    thumb.addEventListener("pointermove", onMove)
    thumb.addEventListener("pointerup", done)
    thumb.addEventListener("pointercancel", done)
  }

  const renderThumb = (axis: Axis) => {
    const vertical = axis === "vertical"
    return (
      <Show when={state[axis].show && (axes() === "both" || axes() === axis)}>
        <div
          class={`scroll-view__thumb${vertical ? "" : " scroll-view__thumb--horizontal"}`}
          data-visible={visible(axis)}
          data-dragging={state[axis].dragging}
          style={{
            [vertical ? "height" : "width"]: `${state[axis].size}px`,
            transform: vertical ? `translateY(${state[axis].offset}px)` : `translateX(${state[axis].offset}px)`,
            "z-index": 100,
          }}
          onPointerDown={(event) => onThumbPointerDown(axis, event)}
        />
      </Show>
    )
  }

  return (
    <div data-slot="project-explorer-scrollbar">
      {renderThumb("vertical")}
      {renderThumb("horizontal")}
    </div>
  )
}
