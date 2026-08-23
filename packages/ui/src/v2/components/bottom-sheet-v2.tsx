import DrawerPrimitive from "@corvu/drawer"
import type { RootProps } from "@corvu/drawer"
import { type ComponentProps, createSignal, type JSX, onCleanup, onMount, type ParentProps, splitProps } from "solid-js"
import "./bottom-sheet-v2.css"

export interface BottomSheetProps extends Omit<RootProps, "side" | "children"> {
  /**
   * Clamp the sheet to the visual viewport so it never extends under the
   * software keyboard (docs/pwa-mobile/06-pwa-platform.md §2.4). On by default.
   */
  clampToVisualViewport?: boolean
  class?: ComponentProps<"div">["class"]
  overlayClass?: ComponentProps<"div">["class"]
  children?: JSX.Element
}

export interface SheetClamp {
  maxHeight: number
  keyboardInset: number
}

/**
 * Geometry for the visual-viewport max-height clamp. The sheet is anchored to
 * the layout-viewport bottom, so its visible box must end at the visual
 * viewport bottom (maxHeight minus keyboardInset) and stay below the visual
 * viewport top (maxHeight).
 */
export function sheetClamp(layoutHeight: number, offsetTop: number, viewportHeight: number): SheetClamp {
  return {
    maxHeight: Math.max(0, layoutHeight - offsetTop),
    keyboardInset: Math.max(0, layoutHeight - offsetTop - viewportHeight),
  }
}

interface SheetMetrics {
  layoutHeight: number
  offsetTop: number
  viewportHeight: number
}

function createSheetClampStyle(enabled: boolean) {
  const [metrics, setMetrics] = createSignal<SheetMetrics>()
  let frame: number | undefined

  const read = () => {
    frame = undefined
    const viewport = window.visualViewport
    if (!viewport) return
    setMetrics({ layoutHeight: window.innerHeight, offsetTop: viewport.offsetTop, viewportHeight: viewport.height })
  }

  const schedule = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(read)
  }

  onMount(() => {
    const viewport = window.visualViewport
    if (!enabled || !viewport) return
    read()
    viewport.addEventListener("resize", schedule)
    viewport.addEventListener("scroll", schedule)
    onCleanup(() => {
      viewport.removeEventListener("resize", schedule)
      viewport.removeEventListener("scroll", schedule)
    })
  })

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  return (): ComponentProps<"div">["style"] => {
    const m = metrics()
    if (!m) return undefined
    const clamp = sheetClamp(m.layoutHeight, m.offsetTop, m.viewportHeight)
    return {
      "max-height": `${clamp.maxHeight}px`,
      "padding-bottom": `${clamp.keyboardInset}px`,
    }
  }
}

function BottomSheetOverlay(props: { class?: ComponentProps<"div">["class"] }) {
  const drawer = DrawerPrimitive.useContext()
  const overlayStyle = () => {
    const state = drawer.transitionState()
    if (state === "opening" || state === "closing") return undefined
    return { opacity: `${drawer.openPercentage()}` }
  }

  return (
    <DrawerPrimitive.Overlay
      data-component="bottom-sheet-overlay-v2"
      class={props.class}
      style={overlayStyle()}
    />
  )
}

export function BottomSheet(props: BottomSheetProps) {
  const [local, rest] = splitProps(props, ["clampToVisualViewport", "class", "overlayClass", "children"])
  const clampStyle = createSheetClampStyle(local.clampToVisualViewport !== false)

  return (
    <DrawerPrimitive {...rest}>
      <DrawerPrimitive.Portal>
        <BottomSheetOverlay class={local.overlayClass} />
        <DrawerPrimitive.Content data-component="bottom-sheet-v2" class={local.class} style={clampStyle()}>
          <div data-slot="bottom-sheet-panel">
            <div data-slot="bottom-sheet-grabber" aria-hidden="true" />
            {local.children}
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive>
  )
}

export function BottomSheetHeader(props: ParentProps & { class?: ComponentProps<"div">["class"] }) {
  const [local] = splitProps(props, ["class", "children"])
  return (
    <div data-slot="bottom-sheet-header" class={local.class}>
      {local.children}
    </div>
  )
}

export function BottomSheetTitle(props: ParentProps) {
  return <DrawerPrimitive.Label data-slot="bottom-sheet-title">{props.children}</DrawerPrimitive.Label>
}

export function BottomSheetDescription(props: ParentProps) {
  return <DrawerPrimitive.Description data-slot="bottom-sheet-description">{props.children}</DrawerPrimitive.Description>
}

export function BottomSheetBody(props: ParentProps & { class?: ComponentProps<"div">["class"] }) {
  const [local] = splitProps(props, ["class", "children"])
  return (
    <div data-slot="bottom-sheet-body" class={local.class}>
      {local.children}
    </div>
  )
}

export function BottomSheetFooter(props: ParentProps & { class?: ComponentProps<"div">["class"] }) {
  const [local] = splitProps(props, ["class", "children"])
  return (
    <div data-slot="bottom-sheet-footer" class={local.class}>
      {local.children}
    </div>
  )
}
