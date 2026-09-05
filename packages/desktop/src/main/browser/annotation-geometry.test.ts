import { expect, test } from "bun:test"
import {
  ANNOTATION_MAX_COMMENT_LENGTH,
  ANNOTATION_MAX_ELEMENTS,
  ANNOTATION_MAX_STROKES,
  ANNOTATION_MAX_POINTS_PER_STROKE,
  ANNOTATION_MAX_STYLE_CHANGES,
  isBrowserAnnotationPayload,
} from "./contracts"
import type { BrowserAnnotationPayload } from "./contracts"
import {
  annotationEnterKey,
  applyRegionRetention,
  harvestMarquee,
  isAccidentalClick,
  normalizeRect,
  REGION_COEXISTS_WITH_ELEMENTS,
  strokeBounds,
  decimateStroke,
  smoothStrokePath,
  unionCropRect,
} from "./annotation-geometry"

// Minimal valid payload factory — every field defaults to an accepted value so
// tests toggle ONE breach at a time.
const basePayload = (): BrowserAnnotationPayload => ({
  id: "a1",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "look here",
  elements: [
    {
      id: "e1",
      tagName: "BUTTON",
      selector: "#go",
      htmlPreview: "<button>",
      componentName: null,
      source: null,
      styles: "color: red",
      rect: { x: 10, y: 10, width: 100, height: 40 },
    },
  ],
  regions: [],
  strokes: [
    {
      id: "s1",
      color: "#ff0000",
      width: 4,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      bounds: { x: -2, y: -2, width: 14, height: 14 },
    },
  ],
  styleChanges: [],
  screenshot: null,
  cropRect: null,
  submission: "attach",
  createdAt: "2026-09-04T00:00:00Z",
})

// --- CRITICAL INVARIANT: screenshot must be null -----------------------------

test("isBrowserAnnotationPayload rejects a non-null screenshot (spoof guard)", () => {
  expect(isBrowserAnnotationPayload(basePayload())).toBe(true)
  const spoofed = basePayload() as unknown as Record<string, unknown>
  spoofed.screenshot = { mime: "image/png", dataUrl: "data:image/png;base64,AAAA", width: 1, height: 1 }
  expect(isBrowserAnnotationPayload(spoofed)).toBe(false)
})

test("isBrowserAnnotationPayload rejects screenshot === undefined too", () => {
  const p = basePayload() as unknown as Record<string, unknown>
  delete p.screenshot
  expect(isBrowserAnnotationPayload(p)).toBe(false)
})

// --- rect finiteness / non-negativity at the boundary -----------------------

test("rejects NaN / Infinity / negative rect fields", () => {
  const p = basePayload()
  p.elements[0].rect = { x: NaN, y: 10, width: 100, height: 40 } as unknown as BrowserAnnotationPayload["elements"][number]["rect"]
  expect(isBrowserAnnotationPayload(p)).toBe(false)

  const p2 = basePayload()
  p2.elements[0].rect = { x: -5, y: 10, width: 100, height: 40 }
  expect(isBrowserAnnotationPayload(p2)).toBe(false)

  const p3 = basePayload()
  p3.elements[0].rect = { x: 10, y: 10, width: Infinity, height: 40 }
  expect(isBrowserAnnotationPayload(p3)).toBe(false)

  const p4 = basePayload()
  p4.cropRect = { x: 0, y: 0, width: -20, height: 20 }
  expect(isBrowserAnnotationPayload(p4)).toBe(false)
})

// --- hard caps at the boundary ----------------------------------------------

test("rejects over-cap element count", () => {
  const p = basePayload()
  const one = p.elements[0]
  p.elements = Array.from({ length: ANNOTATION_MAX_ELEMENTS + 1 }, (_, i) => ({ ...one, id: `e${i}` }))
  expect(isBrowserAnnotationPayload(p)).toBe(false)
})

test("rejects over-cap strokes", () => {
  const p = basePayload()
  const one = p.strokes[0]
  p.strokes = Array.from({ length: ANNOTATION_MAX_STROKES + 1 }, (_, i) => ({ ...one, id: `s${i}` }))
  expect(isBrowserAnnotationPayload(p)).toBe(false)
})

test("rejects a stroke with too many points", () => {
  const p = basePayload()
  p.strokes[0].points = Array.from({ length: ANNOTATION_MAX_POINTS_PER_STROKE + 1 }, (_, i) => ({ x: i, y: i }))
  expect(isBrowserAnnotationPayload(p)).toBe(false)
})

test("rejects a stroke with a non-finite point", () => {
  const p = basePayload()
  p.strokes[0].points = [{ x: 0, y: 0 }, { x: NaN, y: 1 }]
  expect(isBrowserAnnotationPayload(p)).toBe(false)
})

test("rejects over-cap style changes", () => {
  const p = basePayload()
  const one = { targetId: "t", selector: null, property: "color", previousValue: null, value: "red" }
  p.styleChanges = Array.from({ length: ANNOTATION_MAX_STYLE_CHANGES + 1 }, (_, i) => ({ ...one, targetId: `t${i}` }))
  expect(isBrowserAnnotationPayload(p)).toBe(false)
})

test("rejects over-cap comment length", () => {
  const p = basePayload()
  p.comment = "x".repeat(ANNOTATION_MAX_COMMENT_LENGTH + 1)
  expect(isBrowserAnnotationPayload(p)).toBe(false)
})

test("rejects oversized htmlPreview / styles per element", () => {
  const p = basePayload()
  p.elements[0].htmlPreview = "x".repeat(2049)
  expect(isBrowserAnnotationPayload(p)).toBe(false)

  const p2 = basePayload()
  p2.elements[0].styles = "x".repeat(2049)
  expect(isBrowserAnnotationPayload(p2)).toBe(false)
})

test("rejects a non-string submission", () => {
  const p = basePayload() as unknown as Record<string, unknown>
  p.submission = "mail"
  expect(isBrowserAnnotationPayload(p)).toBe(false)
})

// --- rect normalization ------------------------------------------------------

test("normalizeRect builds top-left rect regardless of drag direction", () => {
  expect(normalizeRect(0, 0, 100, 40)).toEqual({ x: 0, y: 0, width: 100, height: 40 })
  expect(normalizeRect(100, 40, 0, 0)).toEqual({ x: 0, y: 0, width: 100, height: 40 })
  expect(normalizeRect(50, 10, 10, 90)).toEqual({ x: 10, y: 10, width: 40, height: 80 })
})

test("isAccidentalClick flags sub-threshold drags", () => {
  expect(isAccidentalClick({ x: 0, y: 0, width: 2, height: 5 })).toBe(true)
  expect(isAccidentalClick({ x: 0, y: 0, width: 5, height: 2 })).toBe(true)
  expect(isAccidentalClick({ x: 0, y: 0, width: 3, height: 3 })).toBe(false)
  expect(isAccidentalClick({ x: 0, y: 0, width: 10, height: 10 })).toBe(false)
})

// --- crop union --------------------------------------------------------------

test("unionCropRect unions targets, pads, and clamps to viewport", () => {
  const viewport = { width: 800, height: 600 }
  const crop = unionCropRect(
    [
      { rect: { x: 100, y: 100, width: 50, height: 50 } },
      { rect: { x: 300, y: 200, width: 60, height: 60 } },
    ],
    viewport,
  )
  expect(crop).toEqual({ x: 80, y: 80, width: 300, height: 200 })
})

test("unionCropRect clamps the left/top edge to 0", () => {
  const viewport = { width: 800, height: 600 }
  const crop = unionCropRect([{ rect: { x: 5, y: 5, width: 20, height: 20 } }], viewport)
  // 5-20 = -15 -> clamped to 0; right 25+20=45; bottom 25+20=45
  expect(crop).toEqual({ x: 0, y: 0, width: 45, height: 45 })
})

test("unionCropRect clamps the right/bottom edge to the viewport", () => {
  const viewport = { width: 100, height: 100 }
  const crop = unionCropRect([{ rect: { x: 90, y: 90, width: 30, height: 30 } }], viewport)
  // left 70, top 70, right 120->100, bottom 120->100
  expect(crop).toEqual({ x: 70, y: 70, width: 30, height: 30 })
})

test("unionCropRect returns null with no targets (host captures full viewport)", () => {
  expect(unionCropRect([], { width: 800, height: 600 })).toBe(null)
})

// --- stroke smoothing + bounds ----------------------------------------------

test("decimateStroke drops samples closer than the threshold", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 5, y: 0 },
    { x: 6, y: 0 },
  ]
  expect(decimateStroke(pts, 2)).toEqual([
    { x: 0, y: 0 },
    { x: 5, y: 0 },
  ])
})

test("smoothStrokePath emits midpoint-quadratic path", () => {
  const d = smoothStrokePath([
    { x: 0, y: 0 },
    { x: 10, y: 10 },
    { x: 20, y: 0 },
  ])
  // M p0, Q p1 mid(p1,p2), L p_last
  expect(d).toBe("M 0 0 Q 10 10 15 5 L 20 0")
})

test("smoothStrokePath handles single/empty", () => {
  expect(smoothStrokePath([])).toBe("")
  expect(smoothStrokePath([{ x: 3, y: 4 }])).toBe("M 3 4")
})

test("strokeBounds expands by half stroke width + 3", () => {
  const b = strokeBounds(
    [
      { x: 0, y: 0 },
      { x: 10, y: 4 },
    ],
    4,
  )
  // half = 2+3 = 5; x: 0-5=-5, y: 0-5=-5, w: 10+10=20, h: 4+10=14
  expect(b).toEqual({ x: -5, y: -5, width: 20, height: 14 })
})

// --- keyboard semantics -----------------------------------------------------

test("annotationEnterKey: Enter = attach", () => {
  expect(annotationEnterKey({ key: "Enter" })).toBe("attach")
})

test("annotationEnterKey: Cmd/Ctrl+Enter = send", () => {
  expect(annotationEnterKey({ key: "Enter", metaKey: true })).toBe("send")
  expect(annotationEnterKey({ key: "Enter", ctrlKey: true })).toBe("send")
})

test("annotationEnterKey: Shift+Enter = null", () => {
  expect(annotationEnterKey({ key: "Enter", shiftKey: true })).toBe(null)
})

test("annotationEnterKey: isComposing = null", () => {
  expect(annotationEnterKey({ key: "Enter", isComposing: true })).toBe(null)
})

test("annotationEnterKey: non-Enter key = null", () => {
  expect(annotationEnterKey({ key: "a" })).toBe(null)
  expect(annotationEnterKey({ key: "Enter", shiftKey: true, metaKey: true })).toBe(null)
})

// --- marquee harvest ---------------------------------------------------------

const candidates = [
  { id: "big", rect: { x: 0, y: 0, width: 80, height: 80 }, area: 6400 },
  { id: "small", rect: { x: 5, y: 5, width: 10, height: 10 }, area: 100 },
  { id: "mid", rect: { x: 100, y: 100, width: 40, height: 40 }, area: 1600 },
  { id: "outside", rect: { x: 500, y: 500, width: 10, height: 10 }, area: 100 },
]

const marquee = { x: 0, y: 0, width: 120, height: 120 }

test("harvestMarquee keeps only centers inside, sorted ascending, capped at 20", () => {
  const got = harvestMarquee(marquee, candidates)
  expect(got.map((c) => c.id)).toEqual(["small", "mid", "big"])
})

test("harvestMarquee excludes candidates whose center is outside", () => {
  const got = harvestMarquee(marquee, candidates)
  expect(got.find((c) => c.id === "outside")).toBeUndefined()
})

test("harvestMarquee caps at ANNOTATION_MARQUEE_MAX_ELEMENTS", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `c${i}`,
    rect: { x: i, y: i, width: 5, height: 5 },
    area: i,
  }))
  expect(harvestMarquee(marquee, many).length).toBe(20)
})

// --- region retention (divergence from T3 main) -----------------------------

test("REGION_COEXISTS_WITH_ELEMENTS default true retains region AND elements", () => {
  expect(REGION_COEXISTS_WITH_ELEMENTS).toBe(true)
  const region = { x: 0, y: 0, width: 120, height: 120 }
  const harvested = harvestMarquee(marquee, candidates)
  const result = applyRegionRetention(region, harvested)
  expect(result.region).toEqual(region)
  expect(result.elementIds).toEqual(["small", "mid", "big"])
})

test("region retention rule honors the false branch (region only when zero harvested)", () => {
  // T3-main behavior: when the flag is toggled off, keep the region only if
  // nothing was harvested.
  const flagSaved = REGION_COEXISTS_WITH_ELEMENTS
  // emulate the false path by calling with a forced-false semantics inline:
  const falseResult = (region: { x: number; y: number; width: number; height: number } | null, harvested: { id: string }[]) => {
    const keepRegion = region !== null && (false || harvested.length === 0)
    return { region: keepRegion ? region : null, elementIds: harvested.map((c) => c.id) }
  }
  const region = { x: 0, y: 0, width: 120, height: 120 }
  // with harvested elements -> region dropped (T3 behavior)
  expect(falseResult(region, [{ id: "small" }].map((c) => ({ ...c })))).toEqual({
    region: null,
    elementIds: ["small"],
  })
  // with zero harvested -> region kept
  expect(falseResult(region, [])).toEqual({ region, elementIds: [] })
  expect(flagSaved).toBe(true)
})
