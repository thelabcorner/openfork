import { createStore } from "solid-js/store"

export const KEYBOARD_OPEN_THRESHOLD = 60

export interface VisualViewportInsetState {
  /** Layout viewport height captured before the software keyboard covers it. */
  layoutHeight: number
  /** Visual viewport offset from the layout viewport top. */
  offsetTop: number
  /** Current visual viewport height. */
  viewportHeight: number
  /** Visual viewport bottom in layout-viewport coordinates. */
  viewportBottom: number
  /**
   * Historical app contract: layout height minus visual viewport height.
   * This includes any visual-viewport top offset and is retained for callers
   * that use it as a coarse "keyboard changed the viewport" signal.
   */
  keyboardHeight: number
  /** Actual layout-viewport pixels covered below the visible viewport. */
  bottomInset: number
  /** True only when bottom coverage exceeds toolbar/chrome jitter. */
  keyboardOpen: boolean
  /** Whether this browser exposes VisualViewport geometry. */
  supported: boolean
}

export function computeVisualViewportInset(
  baselineLayoutHeight: number,
  offsetTop: number,
  viewportHeight: number,
): VisualViewportInsetState {
  const viewportBottom = Math.max(0, offsetTop + viewportHeight)
  const keyboardHeight = Math.max(0, baselineLayoutHeight - viewportHeight)
  const bottomInset = Math.max(0, baselineLayoutHeight - viewportBottom)
  return {
    layoutHeight: Math.max(0, baselineLayoutHeight),
    offsetTop: Math.max(0, offsetTop),
    viewportHeight: Math.max(0, viewportHeight),
    viewportBottom,
    keyboardHeight,
    bottomInset,
    keyboardOpen: bottomInset > KEYBOARD_OPEN_THRESHOLD,
    supported: true,
  }
}

function initialState(): VisualViewportInsetState {
  if (typeof window === "undefined") {
    return {
      layoutHeight: 0,
      offsetTop: 0,
      viewportHeight: 0,
      viewportBottom: 0,
      keyboardHeight: 0,
      bottomInset: 0,
      keyboardOpen: false,
      supported: false,
    }
  }

  const viewport = window.visualViewport
  if (!viewport) {
    return {
      layoutHeight: window.innerHeight,
      offsetTop: 0,
      viewportHeight: window.innerHeight,
      viewportBottom: window.innerHeight,
      keyboardHeight: 0,
      bottomInset: 0,
      keyboardOpen: false,
      supported: false,
    }
  }

  return computeVisualViewportInset(window.innerHeight, viewport.offsetTop, viewport.height)
}

const [viewportInset, setViewportInset] = createStore<VisualViewportInsetState>(initialState())

let detach: (() => void) | undefined

function attachFeed() {
  if (detach || typeof window === "undefined") return
  const viewport = window.visualViewport
  if (!viewport) return

  let baseline = window.innerHeight
  let frame: number | undefined

  const read = () => {
    frame = undefined
    setViewportInset(computeVisualViewportInset(baseline, viewport.offsetTop, viewport.height))
  }

  // VisualViewport commonly emits resize + scroll for the same animation
  // frame on iOS. Collapse both into one geometry read.
  const schedule = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(read)
  }

  const recaptureBaseline = () => {
    // In an installed iOS PWA the layout viewport stays stable while the
    // software keyboard opens. Capture it before focus-driven visual viewport
    // contraction so all consumers agree on the same baseline.
    baseline = window.innerHeight
    schedule()
  }

  const recaptureStableResize = () => {
    // Orientation/window changes while the keyboard is closed establish a new
    // layout baseline. Never adopt a shrunken keyboard-open viewport as the
    // future baseline.
    if (!viewportInset.keyboardOpen) baseline = window.innerHeight
    schedule()
  }

  viewport.addEventListener("resize", schedule)
  viewport.addEventListener("scroll", schedule)
  window.addEventListener("focusin", recaptureBaseline, true)
  window.addEventListener("resize", recaptureStableResize)

  detach = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    viewport.removeEventListener("resize", schedule)
    viewport.removeEventListener("scroll", schedule)
    window.removeEventListener("focusin", recaptureBaseline, true)
    window.removeEventListener("resize", recaptureStableResize)
  }
}

/**
 * Process-wide VisualViewport authority. Consumers must read this reactive store
 * instead of attaching their own VisualViewport listeners.
 */
export function visualViewportInset(): VisualViewportInsetState {
  attachFeed()
  return viewportInset
}
