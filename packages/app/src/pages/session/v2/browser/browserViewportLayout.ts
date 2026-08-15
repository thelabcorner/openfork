// Pure viewport layout math for the hosted browser.
//
// MODEL: the guest page always renders at its LOGICAL CSS viewport
// (`data-preview-css-width/height`, never changed by the presentation layer).
// The webview DOM element is sized to `logical * zoomFactor / scale` and
// scaled down by `scale` when the logical size does not fit the panel — so
// scaling is a pure visual fit and never changes the page's CSS breakpoint.
//
// The centered-viewport resize math below (resizeFromEndRail/StartRail,
// resizeBrowserViewportFromRail) ports T3Code's `browserViewportLayout.ts`
// solver (see T3Code_Browser_Viewport_Resize_OpenCode_Porting_Handoff.md).
// The short version of why it exists: while a fixed viewport is CENTERED in
// the available area, growing it by 1 host px on one edge moves the OPPOSITE
// edge by 1px too (to keep it centered) — so a naive `size = start + delta`
// makes the dragged edge drift away from the pointer at 2x the rate the
// pointer actually moved. The piecewise equations here keep the grabbed rail
// exactly under the pointer, including the transition once the viewport grows
// past the available area (where the mapping switches from a 2:1 to a 1:1
// regime).
//
// All functions are pure and unit-tested (browserViewportLayout.test.ts).

import {
  VIEWPORT_MAX_AREA,
  VIEWPORT_MAX_SIZE,
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

/** The five rail handles the device frame currently renders (no north — the
 * device toolbar occupies the top of the frame and there is no handle there). */
export type ResizeDirection = "west" | "east" | "south" | "southwest" | "southeast"

/** Dedicated hit-target space reserved around a fixed viewport for the resize
 * rails, so the handles never overlap the live guest content. Sized for a
 * comfortable pointer hit target, not just the visible grip glyph (interaction
 * target > visual affordance). */
export const BROWSER_VIEWPORT_RESIZE_RAIL_SIZE = 14

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function fitScale(area: { width: number; height: number }, logicalWidth: number, logicalHeight: number, zoomFactor: number): number {
  const naturalWidth = Math.max(1, logicalWidth * zoomFactor)
  const naturalHeight = Math.max(1, logicalHeight * zoomFactor)
  if (naturalWidth <= area.width && naturalHeight <= area.height) return 1
  return Math.min(area.width / naturalWidth, area.height / naturalHeight, 1)
}

/** Center a `width×height` box within an `area.width×area.height` box. */
function centeredIn(area: { width: number; height: number }, width: number, height: number) {
  return {
    x: Math.max(0, Math.round((area.width - width) / 2)),
    y: Math.max(0, Math.round((area.height - height) / 2)),
  }
}

/**
 * The host-pixel area actually available to a fixed viewport, after
 * reserving room for the resize rails. West/east reserve on both sides;
 * south reserves only at the bottom (there's no north handle to reserve for).
 */
export function resolveBrowserDeviceViewportArea(panel: { width: number; height: number }): { width: number; height: number } {
  const r = BROWSER_VIEWPORT_RESIZE_RAIL_SIZE
  return {
    width: Math.max(1, panel.width - 2 * r),
    height: Math.max(1, panel.height - r),
  }
}

/**
 * Resolve the presentation layout for a viewport setting inside a panel.
 * - fill: the viewport IS the panel (scale 1, guest CSS size = panel/zoom).
 * - freeform/preset: fixed logical size, fit-scaled, centered in the
 *   rail-reduced device area, then shifted back into full panel coordinates.
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

  const area = resolveBrowserDeviceViewportArea(panel)
  const logicalWidth = Math.max(1, viewport.width ?? VIEWPORT_MIN_SIZE)
  const logicalHeight = Math.max(1, viewport.height ?? VIEWPORT_MIN_SIZE)
  const scale = fitScale(area, logicalWidth, logicalHeight, zoomFactor)
  const presentedWidth = Math.max(1, logicalWidth * zoomFactor * scale)
  const presentedHeight = Math.max(1, logicalHeight * zoomFactor * scale)
  const origin = centeredIn(area, presentedWidth, presentedHeight)
  const rail = BROWSER_VIEWPORT_RESIZE_RAIL_SIZE

  return {
    viewportX: panel.x + rail + origin.x,
    viewportY: panel.y + origin.y,
    viewportWidth: presentedWidth,
    viewportHeight: presentedHeight,
    viewportScale: scale,
    canvasWidth: Math.max(panel.width, presentedWidth + 2 * rail),
    canvasHeight: Math.max(panel.height, presentedHeight + rail),
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
 * Capture the currently available FRAMED device area (panel minus rail
 * reservation) as a logical CSS size, zoom-normalized and clamped to the
 * ordinary freeform bounds. Used when the device toolbar is enabled from
 * `fill` mode, so the page doesn't jump to an arbitrary breakpoint merely
 * because the toolbar became visible — it captures whatever it was already
 * rendering at.
 */
export function resolveResponsiveBrowserViewportSize(
  panel: { width: number; height: number },
  zoomFactor: number,
): ViewportFit {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const area = resolveBrowserDeviceViewportArea(panel)
  return clampFreeformArea({ width: area.width / zoom, height: area.height / zoom }, "width")
}

function clampDimension(value: number): number {
  return clamp(Math.round(value), VIEWPORT_MIN_SIZE, VIEWPORT_MAX_SIZE)
}

/**
 * Independently clamp width/height to [MIN, MAX], then — if the resulting
 * area still exceeds the cap — shrink whichever axis the pointer was moving
 * along more dominantly. Preserves the less-dominant axis, which is what
 * makes corner drags feel predictable when they hit the area ceiling.
 */
export function clampFreeformArea(
  size: { width: number; height: number },
  dominant: "width" | "height",
): { width: number; height: number } {
  const width = clampDimension(size.width)
  const height = clampDimension(size.height)
  if (width * height <= VIEWPORT_MAX_AREA) return { width, height }
  if (dominant === "width") {
    return { width: clampDimension(Math.floor(VIEWPORT_MAX_AREA / height)), height }
  }
  return { width, height: clampDimension(Math.floor(VIEWPORT_MAX_AREA / width)) }
}

/**
 * Resolve a proposed size against a locked aspect ratio: recompute the
 * dependent dimension from the primary one, honoring the same [MIN,MAX] and
 * area-cap bounds the primary axis would need to satisfy on its own so the
 * result never silently violates a constraint the un-locked path would have
 * caught. If rounding still pushes the area over the cap, decrement the
 * primary dimension until it doesn't.
 */
export function resizeAtAspectRatio(
  proposed: { width: number; height: number },
  primary: "width" | "height",
  ratio: number,
): { width: number; height: number } {
  if (!(ratio > 0)) return clampFreeformArea(proposed, primary)

  if (primary === "width") {
    const min = Math.ceil(Math.max(VIEWPORT_MIN_SIZE, VIEWPORT_MIN_SIZE * ratio))
    const max = Math.floor(Math.min(VIEWPORT_MAX_SIZE, VIEWPORT_MAX_SIZE * ratio, Math.sqrt(VIEWPORT_MAX_AREA * ratio)))
    let width = clamp(Math.round(proposed.width), min, Math.max(min, max))
    let height = Math.max(1, Math.round(width / ratio))
    while (width * height > VIEWPORT_MAX_AREA && width > min) {
      width -= 1
      height = Math.max(1, Math.round(width / ratio))
    }
    return { width, height }
  }

  const min = Math.ceil(Math.max(VIEWPORT_MIN_SIZE, VIEWPORT_MIN_SIZE / ratio))
  const max = Math.floor(Math.min(VIEWPORT_MAX_SIZE, VIEWPORT_MAX_SIZE / ratio, Math.sqrt(VIEWPORT_MAX_AREA / ratio)))
  let height = clamp(Math.round(proposed.height), min, Math.max(min, max))
  let width = Math.max(1, Math.round(height * ratio))
  while (width * height > VIEWPORT_MAX_AREA && height > min) {
    height -= 1
    width = Math.max(1, Math.round(height * ratio))
  }
  return { width, height }
}

/**
 * Centered "end" rail (east/south edges). While the viewport fits inside
 * `available`, its far edge sits at `(available + size) / 2`; once it's
 * oversized, the edge IS the size (there's no more centering slack). Moving
 * that edge by `delta` and solving back for the new size keeps the dragged
 * edge exactly under the pointer, including the moment it crosses the
 * available boundary (where the mapping switches from 2:1 to 1:1).
 */
export function resizeFromEndRail(size: number, delta: number, available: number): number {
  const edge = size < available ? (available + size) / 2 : size
  const target = edge + delta
  return target <= available ? 2 * target - available : target
}

/** Centered "start" rail (west edge) — the mirror of resizeFromEndRail. */
export function resizeFromStartRail(size: number, delta: number, available: number): number {
  const start = size <= available ? (available - size) / 2 : 0
  const target = start + delta
  return target >= 0 ? available - 2 * target : available - target
}

/**
 * The pointer-drag entry point: converts a host-pixel pointer delta into a
 * new logical viewport size via the centered-rail equations, using
 * `dragZoomFactor` (browser zoom × the fit scale captured at drag START, not
 * recomputed per move — recomputing mid-gesture would change the mapping
 * itself and make the handle accelerate/drift) to move between the pointer's
 * host-pixel space and logical CSS pixels. `available` is the rail-reduced
 * device area (resolveBrowserDeviceViewportArea), also in host pixels.
 */
export function resizeBrowserViewportFromRail(
  start: { width: number; height: number },
  pointerDelta: { x: number; y: number },
  available: { width: number; height: number },
  dragZoomFactor: number,
  direction: ResizeDirection,
  aspectRatio: number | null,
): { width: number; height: number } {
  const zoom = dragZoomFactor > 0 && Number.isFinite(dragZoomFactor) ? dragZoomFactor : 1
  const horizontal = direction === "west" || direction === "east" || direction === "southwest" || direction === "southeast"
  const vertical = direction === "south" || direction === "southwest" || direction === "southeast"

  let width = start.width
  let height = start.height

  if (horizontal) {
    const startHost = start.width * zoom
    const resolvedHost =
      direction === "west" || direction === "southwest"
        ? resizeFromStartRail(startHost, pointerDelta.x, available.width)
        : resizeFromEndRail(startHost, pointerDelta.x, available.width)
    width = resolvedHost / zoom
  }
  if (vertical) {
    const startHost = start.height * zoom
    const resolvedHost = resizeFromEndRail(startHost, pointerDelta.y, available.height)
    height = resolvedHost / zoom
  }

  if (aspectRatio && aspectRatio > 0) {
    const primary: "width" | "height" =
      !vertical
        ? "width"
        : !horizontal
          ? "height"
          : Math.abs(width - start.width) / Math.max(1, start.width) >= Math.abs(height - start.height) / Math.max(1, start.height)
            ? "width"
            : "height"
    return resizeAtAspectRatio({ width, height }, primary, aspectRatio)
  }

  const dominant = Math.abs(pointerDelta.x) >= Math.abs(pointerDelta.y) ? "width" : "height"
  return clampFreeformArea({ width, height }, dominant)
}

/**
 * Direction-only freeform resize (no centered-rail compensation) for the
 * keyboard path: keyboard steps are semantic logical-CSS-pixel sizing, not a
 * physical mouse-distance mapping, so they only need zoom normalization.
 */
export function resizeFreeformViewport(
  start: { width: number; height: number },
  delta: { x: number; y: number },
  zoomFactor: number,
  direction: ResizeDirection,
  aspectRatio: number | null,
): { width: number; height: number } {
  const zoom = zoomFactor > 0 && Number.isFinite(zoomFactor) ? zoomFactor : 1
  const horizontal = direction === "west" || direction === "east" || direction === "southwest" || direction === "southeast"
  const vertical = direction === "south" || direction === "southwest" || direction === "southeast"

  const dx = direction === "west" ? -delta.x : direction === "east" || direction === "southwest" || direction === "southeast" ? delta.x : 0
  const dy = vertical ? delta.y : 0

  const width = horizontal ? start.width + dx / zoom : start.width
  const height = vertical ? start.height + dy / zoom : start.height

  if (aspectRatio && aspectRatio > 0) {
    const primary: "width" | "height" =
      !vertical
        ? "width"
        : !horizontal
          ? "height"
          : Math.abs(width - start.width) / Math.max(1, start.width) >= Math.abs(height - start.height) / Math.max(1, start.height)
            ? "width"
            : "height"
    return resizeAtAspectRatio({ width, height }, primary, aspectRatio)
  }

  const dominant = Math.abs(dx) >= Math.abs(dy) ? "width" : "height"
  return clampFreeformArea({ width, height }, dominant)
}

/** Aspect ratio of a size; null when degenerate. */
export function aspectRatioOf(width: number, height: number): number | null {
  if (width <= 0 || height <= 0) return null
  return width / height
}
