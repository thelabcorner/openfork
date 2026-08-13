// Pure viewport layout math for the hosted browser.
//
// MODEL: the guest page always renders at its LOGICAL CSS viewport
// (`data-preview-css-width/height`, never changed by the presentation layer).
// The webview DOM element is sized to `logical * zoomFactor / scale` and
// scaled down by `scale` when the logical size does not fit the panel — so
// scaling is a pure visual fit and never changes the page's CSS breakpoint.
//
// All functions are pure and unit-tested (browserViewportLayout.test.ts).

import {
  VIEWPORT_MIN_SIZE,
  type PanelRect,
  type ViewportSetting,
} from "./types"

export interface ViewportLayout {
  /** Screen-px position of the viewport inside the canvas. */
  viewportX: number
  viewportY: number
  /** Screen-px size of the PRESENTED (scaled) viewport. */
  viewportWidth: number
  viewportHeight: number
  /** Visual fit factor (<= 1). Never part of the guest CSS viewport. */
  viewportScale: number
  /** Size of the scrollable canvas backing the wrapper. */
  canvasWidth: number
  canvasHeight: number
  fillsPanel: boolean
}

export interface ViewportFit {
  width: number
  height: number
}

export interface ResizeDelta {
  direction: "west" | "east" | "south" | "southwest" | "southeast"
  dx: number
  dy: number
}

export interface ResizeStart {
  width: number
  height: number
}

export interface ResizeConstraints {
  minSize?: number
  /** Locked aspect ratio (width / height); 0/null disables the lock. */
  aspectRatio?: number | null
}

const clampMin = (value: number, min: number) => Math.max(value, min)

function fitScale(panel: PanelRect, logicalWidth: number, logicalHeight: number, zoomFactor: number): number {
  const naturalWidth = Math.max(1, logicalWidth * zoomFactor)
  const naturalHeight = Math.max(1, logicalHeight * zoomFactor)
  if (naturalWidth <= panel.width && naturalHeight <= panel.height) return 1
  return Math.min(panel.width / naturalWidth, panel.height / naturalHeight, 1)
}

/** Center a viewport rect within a panel. */
function centeredIn(panel: PanelRect, width: number, height: number) {
  return {
    x: panel.x + Math.max(0, (panel.width - width) / 2),
    y: panel.y + Math.max(0, (panel.height - height) / 2),
  }
}

/**
 * Resolve the presentation layout for a viewport setting inside a panel.
 * - fill: the viewport IS the panel (scale 1, guest CSS size = panel/zoom).
 * - freeform/preset: fixed logical size, fit-scaled, centered when it fits.
 */
export function resolveViewportLayout(
  panel: PanelRect,
  viewport: ViewportSetting,
  zoomFactor: number,
): ViewportLayout {
  if (viewport.mode === "fill") {
    return {
      viewportX: panel.x,
      viewportY: panel.y,
      viewportWidth: panel.width,
      viewportHeight: panel.height,
      viewportScale: 1,
      canvasWidth: panel.width,
      canvasHeight: panel.height,
      fillsPanel: true,
    }
  }

  const logicalWidth = Math.max(1, viewport.width ?? VIEWPORT_MIN_SIZE)
  const logicalHeight = Math.max(1, viewport.height ?? VIEWPORT_MIN_SIZE)
  const scale = fitScale(panel, logicalWidth, logicalHeight, zoomFactor)
  const presentedWidth = Math.max(1, logicalWidth * zoomFactor * scale)
  const presentedHeight = Math.max(1, logicalHeight * zoomFactor * scale)
  const origin = centeredIn(panel, presentedWidth, presentedHeight)

  return {
    viewportX: origin.x,
    viewportY: origin.y,
    viewportWidth: presentedWidth,
    viewportHeight: presentedHeight,
    viewportScale: scale,
    canvasWidth: Math.max(panel.width, presentedWidth),
    canvasHeight: Math.max(panel.height, presentedHeight),
    fillsPanel: false,
  }
}

/**
 * Sizes the webview DOM element: logical CSS px (× guest zoom) divided by the
 * fit scale, with `scale()` applied in CSS. Inverse of the presented rect.
 */
export function resolveWebviewElementSize(layout: ViewportLayout): { width: number; height: number } {
  return {
    width: layout.viewportWidth / layout.viewportScale,
    height: layout.viewportHeight / layout.viewportScale,
  }
}

/** Fit-to-source: guest CSS dims for fill mode derived from the panel rect. */
export function resolveFittedSourceContent(
  rect: PanelRect,
  zoomFactor: number,
): ViewportFit {
  return {
    width: Math.max(1, Math.round(rect.width / zoomFactor)),
    height: Math.max(1, Math.round(rect.height / zoomFactor)),
  }
}

/**
 * Pure resize math for the drag handles. `start` is the logical size at drag
 * start, `delta` the pointer travel since drag start. When `aspectRatio` is
 * locked, east/west drives height from width and south drives width from
 * height; corners drive the smaller side and derive the other.
 */
export function applyViewportResize(
  start: ResizeStart,
  delta: ResizeDelta,
  constraints: ResizeConstraints = {},
): { width: number; height: number } {
  const minSize = constraints.minSize ?? VIEWPORT_MIN_SIZE
  const aspect = constraints.aspectRatio && constraints.aspectRatio > 0 ? constraints.aspectRatio : null

  const horizontal = delta.direction === "west" || delta.direction === "east" || delta.direction === "southwest" || delta.direction === "southeast"
  const vertical = delta.direction === "south" || delta.direction === "southwest" || delta.direction === "southeast"

  const rawWidth = horizontal ? start.width + (delta.direction === "west" ? -delta.dx : delta.dx) : start.width
  const rawHeight = vertical ? start.height + delta.dy : start.height

  if (aspect) {
    if (horizontal && !vertical) {
      const width = clampMin(rawWidth, minSize)
      return { width, height: Math.max(1, Math.round(width / aspect)) }
    }
    if (vertical && !horizontal) {
      const height = clampMin(rawHeight, minSize)
      return { width: Math.max(1, Math.round(height * aspect)), height }
    }
    // Corner: the smaller raw side leads, the other follows the aspect.
    const scaleByWidth = rawWidth / Math.max(1, start.width)
    const scaleByHeight = rawHeight / Math.max(1, start.height)
    const scale = Math.min(scaleByWidth, scaleByHeight)
    const width = clampMin(start.width * scale, minSize)
    return { width, height: Math.max(1, Math.round(width / aspect)) }
  }

  return {
    width: clampMin(rawWidth, minSize),
    height: clampMin(rawHeight, minSize),
  }
}

/** Aspect ratio of a size; null when degenerate. */
export function aspectRatioOf(width: number, height: number): number | null {
  if (width <= 0 || height <= 0) return null
  return width / height
}
