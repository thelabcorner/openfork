import { describe, expect, test } from "bun:test"
import {
  BROWSER_VIEWPORT_RESIZE_RAIL_SIZE,
  aspectRatioOf,
  clampFreeformArea,
  resizeAtAspectRatio,
  resizeBrowserViewportFromRail,
  resizeFreeformViewport,
  resizeFromEndRail,
  resizeFromStartRail,
  resolveBrowserDeviceViewportArea,
  resolveResponsiveBrowserViewportSize,
  resolveViewportLayout,
  resolveWebviewElementSize,
} from "./browserViewportLayout"
import { VIEWPORT_MAX_SIZE, VIEWPORT_MIN_SIZE } from "./types"

describe("resolveViewportLayout", () => {
  test("fill mode occupies the full surface with no rail reservation", () => {
    const layout = resolveViewportLayout({ x: 0, y: 0, width: 900, height: 700 }, { mode: "fill", width: null, height: null, presetId: null, orientation: "portrait" }, 1)
    expect(layout).toMatchObject({ viewportX: 0, viewportY: 0, viewportWidth: 900, viewportHeight: 700, viewportScale: 1, fillsPanel: true })
  })

  test("a smaller fixed viewport is centered inside the rail-reduced device area", () => {
    const panel = { x: 0, y: 0, width: 1200, height: 900 }
    const layout = resolveViewportLayout(panel, { mode: "freeform", width: 400, height: 400, presetId: null, orientation: "portrait" }, 1)
    const area = resolveBrowserDeviceViewportArea(panel)
    expect(layout.viewportScale).toBe(1)
    expect(layout.viewportWidth).toBe(400)
    expect(layout.viewportX).toBe(BROWSER_VIEWPORT_RESIZE_RAIL_SIZE + Math.round((area.width - 400) / 2))
    expect(layout.viewportY).toBe(Math.round((area.height - 400) / 2))
  })

  test("a larger fixed viewport is presentation-scaled down, never changing logical size", () => {
    const panel = { x: 0, y: 0, width: 600, height: 700 }
    const layout = resolveViewportLayout(panel, { mode: "freeform", width: 1440, height: 900, presetId: null, orientation: "portrait" }, 1)
    expect(layout.viewportScale).toBeLessThan(1)
    expect(layout.fillsPanel).toBe(false)
    // Logical size is recovered exactly by dividing the presented size by scale.
    const size = resolveWebviewElementSize(layout)
    expect(size.width).toBeCloseTo(1440, 5)
    expect(size.height).toBeCloseTo(900, 5)
  })

  test("device-area reservation (§7 concept, sans the T3 toolbar term)", () => {
    // T3's original 1200×900 example reserves rail on all 4 sides PLUS a
    // 32px toolbar strip, because its toolbar overlays the canvas. This port
    // moved the device toolbar into the chrome flow above the canvas (see
    // HostedBrowserWebview's layout), so `panel` here is already
    // toolbar-free — only the rail itself needs reserving: 2× west/east,
    // 1× south (no north handle to reserve for).
    const area = resolveBrowserDeviceViewportArea({ width: 1200, height: 900 })
    expect(area).toEqual({ width: 1200 - 2 * BROWSER_VIEWPORT_RESIZE_RAIL_SIZE, height: 900 - BROWSER_VIEWPORT_RESIZE_RAIL_SIZE })
  })

  test("browser zoom changes visible host footprint but not logical dimensions", () => {
    const panel = { x: 0, y: 0, width: 2000, height: 2000 }
    const at1x = resolveViewportLayout(panel, { mode: "freeform", width: 400, height: 300, presetId: null, orientation: "portrait" }, 1)
    const at2x = resolveViewportLayout(panel, { mode: "freeform", width: 400, height: 300, presetId: null, orientation: "portrait" }, 2)
    expect(at2x.viewportWidth).toBeCloseTo(at1x.viewportWidth * 2, 5)
    const logical1x = resolveWebviewElementSize(at1x)
    const logical2x = resolveWebviewElementSize(at2x)
    expect(logical1x.width / 1).toBeCloseTo(logical2x.width / 2, 5)
  })
})

describe("resolveResponsiveBrowserViewportSize", () => {
  test("captures the framed area at zoom 1", () => {
    const size = resolveResponsiveBrowserViewportSize({ width: 1200, height: 900 }, 1)
    const area = resolveBrowserDeviceViewportArea({ width: 1200, height: 900 })
    expect(size).toEqual(area)
  })

  test("captures a proportionally smaller area at zoom 2", () => {
    const size = resolveResponsiveBrowserViewportSize({ width: 1200, height: 900 }, 2)
    const area = resolveBrowserDeviceViewportArea({ width: 1200, height: 900 })
    expect(size.width).toBe(Math.round(area.width / 2))
    expect(size.height).toBe(Math.round(area.height / 2))
  })
})

describe("clampFreeformArea", () => {
  test("respects the minimum dimension", () => {
    expect(clampFreeformArea({ width: 10, height: 10 }, "width")).toEqual({ width: VIEWPORT_MIN_SIZE, height: VIEWPORT_MIN_SIZE })
  })

  test("respects the maximum dimension (independent of the area cap)", () => {
    // height 2000 keeps width*height under the area cap after clamping, so
    // this isolates the plain max-dimension clamp from the area-shrink path.
    expect(clampFreeformArea({ width: 9000, height: 2000 }, "width")).toEqual({ width: VIEWPORT_MAX_SIZE, height: 2000 })
  })

  test("shrinks the dominant axis when area exceeds the cap", () => {
    const result = clampFreeformArea({ width: 3840, height: 3840 }, "width")
    expect(result.height).toBe(3840)
    expect(result.width).toBeLessThan(3840)
    expect(result.width * result.height).toBeLessThanOrEqual(3840 * 2160)
  })

  test("preserves the non-dominant axis when shrinking for area", () => {
    const result = clampFreeformArea({ width: 3840, height: 3840 }, "height")
    expect(result.width).toBe(3840)
    expect(result.height).toBeLessThan(3840)
  })
})

describe("resizeFromEndRail / resizeFromStartRail — the centered-rail solver", () => {
  test("§41: a 100px east-edge drag on a centered 800px viewport grows it by 200px, not 100px", () => {
    // A=1200, S=800 (centered): naive `S+delta` would give 900. The rail
    // solver must give 1000, keeping the dragged edge exactly under the
    // pointer (a naive implementation drifts 50px behind it).
    expect(resizeFromEndRail(800, 100, 1200)).toBe(1000)
  })

  test("§42: crossing the centered boundary switches from 2:1 to 1:1", () => {
    // A=1200, S=800, drag by 250 → target edge 1250 (beyond A=1200).
    expect(resizeFromEndRail(800, 250, 1200)).toBe(1250)
  })

  test("west (start) rail is the mirror of east (end) rail", () => {
    // Dragging west by -100 (growing leftward) should grow the same amount
    // as dragging east by +100 grows it, for a symmetric centered viewport.
    const east = resizeFromEndRail(800, 100, 1200)
    const west = resizeFromStartRail(800, -100, 1200)
    expect(west).toBe(east)
  })

  test("an already-oversized viewport resizes 1:1 (no centering slack left)", () => {
    expect(resizeFromEndRail(1500, 50, 1200)).toBe(1550)
  })
})

describe("resizeBrowserViewportFromRail", () => {
  const available = resolveBrowserDeviceViewportArea({ width: 1200, height: 900 })

  test("east drag keeps the dragged edge under the pointer (matches resizeFromEndRail)", () => {
    const result = resizeBrowserViewportFromRail({ width: 800, height: 600 }, { x: 100, y: 0 }, available, 1, "east", null)
    expect(result.width).toBe(resizeFromEndRail(800, 100, available.width))
    expect(result.height).toBe(600)
  })

  test("west drag grows width without moving height", () => {
    const result = resizeBrowserViewportFromRail({ width: 800, height: 600 }, { x: -50, y: 0 }, available, 1, "west", null)
    expect(result.width).toBeGreaterThan(800)
    expect(result.height).toBe(600)
  })

  test("south drag only changes height", () => {
    const result = resizeBrowserViewportFromRail({ width: 800, height: 600 }, { x: 0, y: 50 }, available, 1, "south", null)
    expect(result.width).toBe(800)
    expect(result.height).toBeGreaterThan(600)
  })

  test("dragZoomFactor scales the pointer-delta-to-logical conversion", () => {
    // At dragZoomFactor 2 (browser zoom × fit scale), the same host-pixel
    // delta must produce a SMALLER logical size change than at factor 1.
    const at1x = resizeBrowserViewportFromRail({ width: 800, height: 600 }, { x: 100, y: 0 }, available, 1, "east", null)
    const at2x = resizeBrowserViewportFromRail({ width: 800, height: 600 }, { x: 100, y: 0 }, available, 2, "east", null)
    expect(at2x.width - 800).toBeLessThan(at1x.width - 800)
  })

  test("aspect lock recomputes the dependent axis through the constraint-aware solver", () => {
    const ratio = aspectRatioOf(800, 600)!
    const result = resizeBrowserViewportFromRail({ width: 800, height: 600 }, { x: 100, y: 0 }, available, 1, "east", ratio)
    expect(result.width / result.height).toBeCloseTo(ratio, 1)
  })
})

describe("resizeFreeformViewport (keyboard path)", () => {
  test("does not apply centered-rail compensation — a step is exactly the requested logical delta", () => {
    const result = resizeFreeformViewport({ width: 800, height: 600 }, { x: 10, y: 0 }, 1, "east", null)
    expect(result.width).toBe(810)
    expect(result.height).toBe(600)
  })

  test("west direction: negative deltaX grows width (§14 sign convention)", () => {
    const result = resizeFreeformViewport({ width: 800, height: 600 }, { x: -10, y: 0 }, 1, "west", null)
    expect(result.width).toBe(810)
  })

  test("zoom normalizes the logical step", () => {
    const result = resizeFreeformViewport({ width: 800, height: 600 }, { x: 20, y: 0 }, 2, "east", null)
    expect(result.width).toBe(810)
  })
})

describe("resizeAtAspectRatio", () => {
  test("width-driven: recomputes height from the locked ratio", () => {
    const result = resizeAtAspectRatio({ width: 800, height: 999 }, "width", 800 / 600)
    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
  })

  test("height-driven: recomputes width from the locked ratio", () => {
    const result = resizeAtAspectRatio({ width: 999, height: 600 }, "height", 800 / 600)
    expect(result.height).toBe(600)
    expect(result.width).toBe(800)
  })

  test("never exceeds the area cap even under a locked ratio", () => {
    const result = resizeAtAspectRatio({ width: 3840, height: 3840 }, "width", 1)
    expect(result.width * result.height).toBeLessThanOrEqual(3840 * 2160)
  })

  test("respects the minimum dimension for extreme ratios", () => {
    const result = resizeAtAspectRatio({ width: 100, height: 100 }, "width", 10)
    expect(result.width).toBeGreaterThanOrEqual(VIEWPORT_MIN_SIZE)
    expect(result.height).toBeGreaterThanOrEqual(VIEWPORT_MIN_SIZE)
  })
})
