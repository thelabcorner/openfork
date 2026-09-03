export const AUTO_SCROLL_STICK_PX = 10
export const AUTO_SCROLL_ESCAPE_PX = 24

export type AutoScrollIntent = "prog" | "stick" | "escape" | "hold"

export function classifyAutoScroll(input: {
  distance: number
  delta: number
  stickThreshold: number
  escapeThreshold: number
  isProgrammatic: boolean
  programmaticCorrection?: boolean
}): AutoScrollIntent {
  if (input.isProgrammatic && (input.delta >= -1 || input.programmaticCorrection)) return "prog"

  // Balanced: small micro-jitter at the very bottom should not tear follow.
  // Require either a decisive flick (< -1.5) anywhere, or a modest uptick
  // (>0.5) once already beyond the stick band. This keeps middle-click
  // autoscroll (continuous -1..-4 per frame at 60Hz) escaping within 1-2
  // frames once dist > stick, while a 0.6px subpixel wobble at dist=2 does not.
  if (input.delta < -1.5) return "escape"
  if (input.delta < -0.5 && input.distance > input.stickThreshold) return "escape"

  if (input.distance < input.stickThreshold) {
    if (input.delta > input.escapeThreshold) return "hold"
    return "stick"
  }
  if (input.distance > input.escapeThreshold) return "escape"
  return "hold"
}

export function isProgrammaticScroll(input: {
  pendingTop: number | null
  scrollTop: number
  delta: number
  allowUpward?: boolean
}): boolean {
  if (input.pendingTop === null) return false
  if (!input.allowUpward && input.delta < -1) return false
  return Math.abs(input.scrollTop - input.pendingTop) < 3
}
