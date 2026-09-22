import {
  computeVisualViewportInset,
  KEYBOARD_OPEN_THRESHOLD,
  visualViewportInset,
  type VisualViewportInsetState,
} from "@opencode-ai/ui/v2/viewport-inset"

export { KEYBOARD_OPEN_THRESHOLD }

export type KeyboardInsetState = VisualViewportInsetState

/**
 * Compatibility name retained for app callers/tests. The geometry authority now
 * lives in @opencode-ai/ui so sheets and the PWA shell share one listener/store.
 */
export const computeKeyboardInset = computeVisualViewportInset

/**
 * Single process-wide VisualViewport feed. Do not subscribe to
 * window.visualViewport from app components directly.
 */
export const keyboardInset = visualViewportInset
