// Pure, dependency-free annotation geometry + keyboard + marquee math.
//
// NOTHING in this file imports Electron — that is what makes it unit-testable
// outside the main process. It imports ONLY types from ./contracts. Host and
// guest lanes import these helpers instead of reinventing crop-union,
// stroke-smoothing, or marquee harvesting.

import type {
  AnnotationRect,
  AnnotationStroke,
  BrowserAnnotationPayload,
} from "./contracts"
import {
  ANNOTATION_CROP_PADDING_PX,
  ANNOTATION_MARQUEE_MAX_ELEMENTS,
  ANNOTATION_MIN_MARQUEE_SIZE_PX,
  ANNOTATION_STROKE_DECIMATE_MIN_DIST_PX,
} from "./contracts"

// --- rect normalization ------------------------------------------------------

/** Normalize a drag from two arbitrary corners into a top-left rect.
 * x=min(x0,x1), y=min(y0,y1), w=|x1-x0|, h=|y1-y0|. Pure. */
export const normalizeRect = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): AnnotationRect => ({
  x: Math.min(x0, x1),
  y: Math.min(y0, y1),
  width: Math.abs(x1 - x0),
  height: Math.abs(y1 - y0),
})

/** An accidental click (a marquee smaller than this) produces no region. */
export const isAccidentalClick = (rect: AnnotationRect, minSizePx = ANNOTATION_MIN_MARQUEE_SIZE_PX): boolean =>
  rect.width < minSizePx || rect.height < minSizePx

// --- crop union --------------------------------------------------------------

export interface CropTarget {
  rect: AnnotationRect
}

/** Union of all target rects, padded by ANNOTATION_CROP_PADDING_PX on every
 * side, then clamped to the viewport. No targets => null (host captures the
 * full viewport).
 *
 * left = min(x); top = min(y); right = max(x+w); bottom = max(y+h);
 * x' = max(0, left - pad); y' = max(0, top - pad);
 * width/height clipped so the rect never exceeds the viewport. */
export const unionCropRect = (
  targets: readonly CropTarget[],
  viewport: { width: number; height: number },
  pad: number = ANNOTATION_CROP_PADDING_PX,
): AnnotationRect | null => {
  if (targets.length === 0) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const { rect } of targets) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  const x = Math.max(0, left - pad)
  const y = Math.max(0, top - pad)
  const clampedRight = Math.min(viewport.width, right + pad)
  const clampedBottom = Math.min(viewport.height, bottom + pad)
  return {
    x,
    y,
    width: Math.max(0, clampedRight - x),
    height: Math.max(0, clampedBottom - y),
  }
}

// --- stroke smoothing + bounds ----------------------------------------------

export interface StrokePoint {
  x: number
  y: number
}

/** Drop samples closer than `minDistPx` to the previous kept point. Pure. */
export const decimateStroke = (
  points: readonly StrokePoint[],
  minDistPx: number = ANNOTATION_STROKE_DECIMATE_MIN_DIST_PX,
): StrokePoint[] => {
  if (points.length <= 1) return points.slice()
  const out: StrokePoint[] = [points[0]]
  let last = points[0]
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const dx = p.x - last.x
    const dy = p.y - last.y
    if (dx * dx + dy * dy >= minDistPx * minDistPx) {
      out.push(p)
      last = p
    }
  }
  return out
}

/** Midpoint-quadratic smoothing: `M p0`, then `Q mid(p_i, p_i+1) p_i+1` for
 * interior points, terminating `L p_last`. Returns an SVG path string. */
export const smoothStrokePath = (points: readonly StrokePoint[]): string => {
  if (points.length === 0) return ""
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]
    const next = points[i + 1]
    const mx = (p.x + next.x) / 2
    const my = (p.y + next.y) / 2
    d += ` Q ${p.x} ${p.y} ${mx} ${my}`
  }
  const last = points[points.length - 1]
  d += ` L ${last.x} ${last.y}`
  return d
}

/** Bounds = min/max of points expanded by `half = strokeWidth/2 + 3` each
 * side. Pure; does not require the stroke's own stored `bounds`. */
export const strokeBounds = (points: readonly StrokePoint[], strokeWidth: number): AnnotationRect => {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const half = strokeWidth / 2 + 3
  return {
    x: minX - half,
    y: minY - half,
    width: maxX - minX + half * 2,
    height: maxY - minY + half * 2,
  }
}

// --- keyboard semantics -----------------------------------------------------

/** Pure Enter-key annotation semantics.
 * - Enter (no modifier, not composing)            => "attach"
 * - Cmd/Ctrl+Enter                                 => "send"
 * - Shift+Enter, or while IME composing, or other => null (no action)
 * The caller decides what to do with the verdict. */
export const annotationEnterKey = (event: {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  isComposing?: boolean
}): "attach" | "send" | null => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return null
  return event.metaKey || event.ctrlKey ? "send" : "attach"
}

// --- marquee harvest ---------------------------------------------------------

/** Region coexistence policy (deliberate, labelled divergence from T3 main).
 * When true: a drawn region AND any harvested elements are both retained.
 * When false: the region is retained ONLY when zero candidates were harvested
 * (T3-main behavior). Single module-level switch so host/guest stay consistent. */
export const REGION_COEXISTS_WITH_ELEMENTS = true

export interface MarqueeCandidate {
  id: string
  rect: AnnotationRect
  /** rendered area (width*height), used to sort ascending before capping. */
  area: number
}

const centerOf = (rect: AnnotationRect): StrokePoint => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
})

const pointInRect = (p: StrokePoint, rect: AnnotationRect): boolean =>
  p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height

/** Harvest candidates whose CENTERS fall inside the marquee rect, sorted by
 * rendered area ASCENDING and capped at ANNOTATION_MARQUEE_MAX_ELEMENTS.
 * Pure — does not touch the DOM; the guest supplies pre-computed rects. */
export const harvestMarquee = (
  marquee: AnnotationRect,
  candidates: readonly MarqueeCandidate[],
  max: number = ANNOTATION_MARQUEE_MAX_ELEMENTS,
): MarqueeCandidate[] => {
  const inside = candidates
    .filter((c) => pointInRect(centerOf(c.rect), marquee))
    .sort((a, b) => a.area - b.area)
  return inside.slice(0, max)
}

/** Apply the region-coexistence rule to assemble the retained set:
 * - elements: harvested marquee candidates.
 * - region: the drawn region (if any).
 * With REGION_COEXISTS_WITH_ELEMENTS = true: region AND elements both retained.
 * With it = false: region retained ONLY when zero elements were harvested.
 * Returns the (possibly null) region to keep and the harvested element ids. */
export const applyRegionRetention = (
  region: AnnotationRect | null,
  harvested: readonly MarqueeCandidate[],
): { region: AnnotationRect | null; elementIds: string[] } => {
  const keepRegion = region !== null && (REGION_COEXISTS_WITH_ELEMENTS || harvested.length === 0)
  return {
    region: keepRegion ? region : null,
    elementIds: harvested.map((c) => c.id),
  }
}

// --- re-export for convenience ----------------------------------------------

export type { AnnotationRect, AnnotationStroke, BrowserAnnotationPayload }
