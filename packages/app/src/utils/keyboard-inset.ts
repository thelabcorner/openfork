import { createStore } from "solid-js/store"

export const KEYBOARD_OPEN_THRESHOLD = 60

export interface KeyboardInsetState {
  /** px of the layout viewport covered by the software keyboard, >= 0. */
  keyboardHeight: number
  /** px from layout-viewport top to the bottom of the visible (visual) viewport. */
  viewportBottom: number
  keyboardOpen: boolean
}

/**
 * docs/pwa-mobile/06-pwa-platform.md §2.4: keyboardHeight is the focus-time
 * layout height minus the visual viewport height, clamped at 0; the iOS layout
 * viewport is stable while the keyboard is open, so the captured innerHeight is
 * the baseline. The ~60px threshold filters URL-bar/toolbar flicker.
 */
export function computeKeyboardInset(
  baselineLayoutHeight: number,
  offsetTop: number,
  viewportHeight: number,
): KeyboardInsetState {
  const keyboardHeight = Math.max(0, baselineLayoutHeight - viewportHeight)
  return {
    keyboardHeight,
    viewportBottom: offsetTop + viewportHeight,
    keyboardOpen: keyboardHeight > KEYBOARD_OPEN_THRESHOLD,
  }
}

function initialState(): KeyboardInsetState {
  if (typeof window === "undefined") return { keyboardHeight: 0, viewportBottom: 0, keyboardOpen: false }
  const viewport = window.visualViewport
  if (!viewport) return { keyboardHeight: 0, viewportBottom: window.innerHeight, keyboardOpen: false }
  return computeKeyboardInset(window.innerHeight, viewport.offsetTop, viewport.height)
}

const [inset, setInset] = createStore<KeyboardInsetState>(initialState())

let detach: (() => void) | undefined

function attachFeed() {
  if (detach || typeof window === "undefined") return
  const viewport = window.visualViewport
  if (!viewport) return

  let baseline = window.innerHeight
  let frame: number | undefined

  const read = () => {
    frame = undefined
    setInset(computeKeyboardInset(baseline, viewport.offsetTop, viewport.height))
  }

  // resize + scroll coalesce per frame; iOS fires both on every keystroke.
  const schedule = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(read)
  }

  const recaptureBaseline = () => {
    baseline = window.innerHeight
    schedule()
  }

  viewport.addEventListener("resize", schedule)
  viewport.addEventListener("scroll", schedule)
  // Capture phase: focus events from inputs do not bubble.
  window.addEventListener("focusin", recaptureBaseline, true)

  detach = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    viewport.removeEventListener("resize", schedule)
    viewport.removeEventListener("scroll", schedule)
    window.removeEventListener("focusin", recaptureBaseline, true)
  }
}

/**
 * Single reader of window.visualViewport (docs/pwa-mobile/06-pwa-platform.md
 * §2.4). Read the returned store reactively; no other component may subscribe
 * to visualViewport events directly.
 */
export function keyboardInset(): KeyboardInsetState {
  attachFeed()
  return inset
}
