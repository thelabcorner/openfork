/**
 * Shared text-layout typography contract (PRETEXT PREDICTS, THE DOM DECIDES).
 *
 * `TextTypography` carries the resolved text style for a measured surface.
 * Values come from design tokens / CSS custom properties, never guessed:
 *   - family: the font stack WITHOUT size/weight (canvas font shorthand family),
 *     e.g. '"Segoe UI", system-ui, sans-serif'
 *   - fontSizePx / lineHeightPx: resolved pixel values (px only, no units)
 *   - fontWeight / fontStyle / letterSpacingPx: remaining canvas font axes
 *
 * The lib derives the canvas `font` shorthand string from these fields; callers
 * must keep them synced with the CSS that actually renders the text.
 */

export type TextTypography = {
  family: string
  fontSizePx: number
  lineHeightPx: number
  fontWeight: number
  fontStyle: string
  letterSpacingPx: number
}

export type WhiteSpaceMode = "normal" | "pre-wrap"

/** Same format as `canvasContext.font = ...`, e.g. `normal 400 14px "Inter"`. */
export function canvasFont(typography: TextTypography) {
  return `${typography.fontStyle} ${typography.fontWeight} ${typography.fontSizePx}px ${typography.family}`
}

/** Signature that distinguishes measurements: two typographies with the same
 * signature are interchangeable for cache/prepare purposes. */
export function typographySignature(typography: TextTypography) {
  return `${canvasFont(typography)}\0${typography.letterSpacingPx}`
}
