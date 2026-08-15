// Human-in-the-loop browser annotation overlay — runs inside the sandboxed
// browser guest preload (no Node, no framework). Ports T3Code's PickPreload
// concept: a closed-shadow-DOM overlay lets a person select elements, marquee
// a region, freehand-draw, live-edit CSS on selected targets, write a
// comment, and submit a structured annotation + screenshot crop request to
// the main process. See PickPreload.ts in the porting handoff for the
// reference architecture; this is a from-scratch vanilla-DOM port, not a
// transliteration.
//
// Trust boundary: this module NEVER claims to supply a screenshot — the
// picked-element payload always sends `screenshot: null`; only the main
// process captures pixels (see AnnotationController in
// packages/desktop/src/main/browser/annotation.ts).

import { ipcRenderer } from "electron"
import {
  ANNOTATION_CANCEL_CHANNEL,
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_CROP_PADDING_PX,
  ANNOTATION_MARQUEE_MAX_ELEMENTS,
  ANNOTATION_MIN_MARQUEE_SIZE_PX,
  ANNOTATION_PICKED_CHANNEL,
  ANNOTATION_START_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  type AnnotationElementContext,
  type AnnotationRect,
  type AnnotationRegion,
  type AnnotationSourceFrame,
  type AnnotationStroke,
  type AnnotationStyleChange,
  type AnnotationSubmission,
  type BrowserAnnotationPayload,
} from "../main/browser/contracts"

const OVERLAY_ATTRIBUTE = "data-opencode-annotation-ui"
const Z_INDEX_OVERLAY = 2147483646
/** Same-origin iframe recursion cap — generous for real layouts, bounded
 * against a pathological/adversarial page nesting iframes indefinitely. */
const MAX_FRAME_DEPTH = 4

type AnnotationTool = "select" | "marquee" | "draw" | "erase"
type FrameOffset = { x: number; y: number }

type SelectedTarget = {
  id: string
  el: Element
  offset: FrameOffset
  baseline: Map<string, string | null>
}

type HoverTarget = { el: Element; offset: FrameOffset }

type StyleProperty = "font-size" | "color" | "background-color" | "border-radius" | "width" | "height" | "padding" | "margin" | "gap"

let active = false
let theme: "light" | "dark" = "light"
let tool: AnnotationTool = "select"
let host: HTMLDivElement | undefined
let shadow: ShadowRoot | undefined
let outlineLayer: HTMLDivElement | undefined
let drawSvg: SVGSVGElement | undefined
let toolbarEl: HTMLDivElement | undefined
let commentEl: HTMLTextAreaElement | undefined
let stylePanelEl: HTMLDivElement | undefined
let rafHandle = 0

const selected = new Map<string, SelectedTarget>()
const regions: AnnotationRegion[] = []
const strokes: AnnotationStroke[] = []
const styleChanges: AnnotationStyleChange[] = []
let nextId = 0
const freshId = (prefix: string) => `${prefix}-${++nextId}`

let hover: HoverTarget | null = null
let marqueeStart: { x: number; y: number } | null = null
let marqueeRect: AnnotationRect | null = null
let drawing: { points: Array<{ x: number; y: number }> } | null = null

function isAnnotationNode(node: Element): boolean {
  return node.closest(`[${OVERLAY_ATTRIBUTE}]`) !== null || node.hasAttribute(OVERLAY_ATTRIBUTE)
}

/** A same-origin iframe is one whose `contentDocument` is actually reachable
 * — cross-origin access throws (older engines) or returns null (spec-current
 * behavior), either way we treat it as opaque and stop descending. */
function sameOriginIframeDocument(el: Element): Document | null {
  if (!(el instanceof HTMLIFrameElement)) return null
  try {
    return el.contentDocument
  } catch {
    return null
  }
}

/**
 * Hit-test recursively through same-origin iframes, translating the point
 * into each nested document's local coordinate space and returning the
 * final element together with the accumulated TOP-viewport offset needed to
 * translate its own (frame-local) getBoundingClientRect() back into top
 * space. Cross-origin iframes are treated as an opaque leaf — annotation can
 * target the iframe element itself but never its (inaccessible) content.
 */
function pickFromPoint(clientX: number, clientY: number): HoverTarget | null {
  return pickFromPointIn(document, clientX, clientY, { x: 0, y: 0 }, 0)
}

function pickFromPointIn(doc: Document, x: number, y: number, offset: FrameOffset, depth: number): HoverTarget | null {
  for (const candidate of doc.elementsFromPoint(x, y)) {
    if (!(candidate instanceof Element)) continue
    if (doc === document && isAnnotationNode(candidate)) continue
    if (candidate === doc.documentElement || candidate === doc.body) continue

    if (depth < MAX_FRAME_DEPTH) {
      const innerDoc = sameOriginIframeDocument(candidate)
      if (innerDoc) {
        const frameRect = candidate.getBoundingClientRect()
        const nested = pickFromPointIn(
          innerDoc,
          x - frameRect.left,
          y - frameRect.top,
          { x: offset.x + frameRect.left, y: offset.y + frameRect.top },
          depth + 1,
        )
        if (nested) return nested
        // Same-origin iframe with no deeper hit (e.g. transparent margin) —
        // fall through and target the iframe element itself.
      }
    }
    return { el: candidate, offset }
  }
  return null
}

type FrameCandidate = { el: Element; offset: FrameOffset }

/** Same-origin-recursive candidate collection for marquee hit testing —
 * the mirror of pickFromPointIn but gathering everything instead of the
 * topmost element at a single point. */
function collectFrameCandidates(doc: Document, offset: FrameOffset, depth: number, out: FrameCandidate[]): void {
  for (const el of doc.querySelectorAll("*")) {
    if (doc === document && isAnnotationNode(el)) continue
    if (el === doc.documentElement || el === doc.body) continue
    out.push({ el, offset })
    if (depth >= MAX_FRAME_DEPTH) continue
    const innerDoc = sameOriginIframeDocument(el)
    if (!innerDoc) continue
    const frameRect = el.getBoundingClientRect()
    collectFrameCandidates(innerDoc, { x: offset.x + frameRect.left, y: offset.y + frameRect.top }, depth + 1, out)
  }
}

/** Bounded, reasonably-stable CSS selector — id > data-testid > structural
 * nth-child path capped at 6 ancestors. No claim to global uniqueness; it's a
 * best-effort human-readable locator, not a targeting mechanism (agent tools
 * use their own ref/selector synthesis, unrelated to this). */
function computeSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`
  const testId = el.getAttribute("data-testid")
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`

  const parts: string[] = []
  let node: Element | null = el
  for (let depth = 0; node && depth < 6; depth++) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`)
      break
    }
    const current: Element = node
    const parent: Element | null = current.parentElement
    if (!parent) {
      parts.unshift(current.tagName.toLowerCase())
      break
    }
    const siblings: Element[] = Array.from(parent.children).filter((sibling) => sibling.tagName === current.tagName)
    const index = siblings.indexOf(current) + 1
    const segment = siblings.length > 1 ? `${current.tagName.toLowerCase()}:nth-of-type(${index})` : current.tagName.toLowerCase()
    parts.unshift(segment)
    node = parent
    depth++
  }
  return parts.join(" > ")
}

function boundedHtmlPreview(el: Element): string {
  const clone = el.cloneNode(false) as Element
  const open = clone.outerHTML.replace(/><\/[^>]+>$/, ">")
  const text = (el.textContent ?? "").trim().slice(0, 120)
  const preview = `${open}${text}</${el.tagName.toLowerCase()}>`
  return preview.length > 2000 ? `${preview.slice(0, 2000)}…` : preview
}

function boundedStyles(el: Element): string {
  const computed = getComputedStyle(el)
  const interesting = [
    "display",
    "position",
    "width",
    "height",
    "color",
    "background-color",
    "font-size",
    "font-family",
    "font-weight",
    "border-radius",
    "padding",
    "margin",
  ]
  return interesting.map((prop) => `${prop}: ${computed.getPropertyValue(prop)}`).join("; ")
}

function rectOf(el: Element, offset: FrameOffset = { x: 0, y: 0 }): AnnotationRect {
  const r = el.getBoundingClientRect()
  return { x: r.x + offset.x, y: r.y + offset.y, width: r.width, height: r.height }
}

// ── React fiber metadata (safe, isolated-world-compatible) ──────────────
//
// contextIsolation stays ENABLED for this guest (see WebviewPreferences) —
// unlike T3Code's react-grab/bippy, which needs contextIsolation=false to
// share globalThis with the page so it can reach the React DevTools global
// hook, this reads React's Fiber tree directly off DOM node expando
// properties instead. React attaches `__reactFiber$<key>` (or the legacy
// `__reactInternalInstance$<key>`) directly onto every DOM node it manages.
// contextIsolation isolates the JS prototype/global chain between the page
// and this preload's isolated world — it does NOT hide instance properties
// already set on a DOM node object, because both worlds observe the SAME
// underlying node. So this works with zero change to the security posture
// the handoff explicitly warned about ("do not cargo-cult
// contextIsolation=false... prefer a safer isolated bridge").
//
// `_debugSource`/`_debugOwner` only exist on fibers produced by a
// DEVELOPMENT build of React (stripped from production/minified bundles) —
// exactly the case for a coding agent's local dev server, and exactly where
// this tool is actually used. Production pages simply degrade to
// componentName: null / source: null, same as before this existed.

interface ReactFiberLike {
  type: unknown
  return: ReactFiberLike | null
  _debugSource?: { fileName: string; lineNumber: number; columnNumber: number }
}

function findFiber(el: Element): ReactFiberLike | null {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"))
  if (!key) return null
  const fiber = (el as unknown as Record<string, unknown>)[key]
  return isFiberLike(fiber) ? fiber : null
}

function isFiberLike(value: unknown): value is ReactFiberLike {
  return typeof value === "object" && value !== null && "type" in value
}

function componentNameOfType(type: unknown): string | null {
  if (typeof type === "string") return null // host element (div, span, ...), not a component
  if (typeof type === "function") {
    const fn = type as { displayName?: string; name?: string }
    return fn.displayName || fn.name || null
  }
  if (type && typeof type === "object") {
    const obj = type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string } }
    return obj.displayName || obj.name || obj.render?.displayName || obj.render?.name || null
  }
  return null
}

function reactComponentContext(el: Element): { componentName: string | null; source: AnnotationSourceFrame | null } {
  let fiber = findFiber(el)
  for (let depth = 0; fiber && depth < 40; depth++) {
    const componentName = componentNameOfType(fiber.type)
    const debugSource = fiber._debugSource
    if (componentName || debugSource) {
      return {
        componentName,
        source: debugSource
          ? { file: debugSource.fileName, line: debugSource.lineNumber, column: debugSource.columnNumber }
          : null,
      }
    }
    fiber = fiber.return
  }
  return { componentName: null, source: null }
}

function elementContext(target: SelectedTarget): AnnotationElementContext {
  const react = reactComponentContext(target.el)
  return {
    id: target.id,
    tagName: target.el.tagName.toLowerCase(),
    selector: computeSelector(target.el),
    htmlPreview: boundedHtmlPreview(target.el),
    componentName: react.componentName,
    source: react.source,
    styles: boundedStyles(target.el),
    rect: rectOf(target.el, target.offset),
  }
}

// ── ensure/mount ─────────────────────────────────────────────────────────

function ensureHost() {
  if (host) return
  host = document.createElement("div")
  host.setAttribute(OVERLAY_ATTRIBUTE, "")
  host.style.position = "fixed"
  host.style.inset = "0"
  host.style.zIndex = String(Z_INDEX_OVERLAY)
  host.style.pointerEvents = "none"
  document.documentElement.appendChild(host)
  shadow = host.attachShadow({ mode: "closed" })

  const style = document.createElement("style")
  style.textContent = STYLE_SHEET
  shadow.appendChild(style)

  outlineLayer = document.createElement("div")
  outlineLayer.className = "outline-layer"
  shadow.appendChild(outlineLayer)

  drawSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  drawSvg.setAttribute("class", "draw-layer")
  shadow.appendChild(drawSvg)

  buildToolbar()
}

function teardownHost() {
  if (rafHandle) cancelAnimationFrame(rafHandle)
  rafHandle = 0
  host?.remove()
  host = undefined
  shadow = undefined
  outlineLayer = undefined
  drawSvg = undefined
  toolbarEl = undefined
  commentEl = undefined
  stylePanelEl = undefined
}

// ── lifecycle ────────────────────────────────────────────────────────────

function startAnnotation() {
  if (active) cancelAnnotation()
  active = true
  tool = "select"
  ensureHost()
  applyThemeClass()
  window.addEventListener("pointerdown", onPointerDown, true)
  window.addEventListener("pointermove", onPointerMove, true)
  window.addEventListener("pointerup", onPointerUp, true)
  window.addEventListener("keydown", onKeyDown, true)
  window.addEventListener("scroll", scheduleRender, true)
  window.addEventListener("resize", scheduleRender, true)
  scheduleRender()
}

/** Restore every temporary CSS change and tear down the overlay. Must run on
 * every terminal path: cancel, successful capture ack, navigation, guest
 * teardown — never leave a preview-only style edit visible in the live page. */
function restoreAndTeardown() {
  for (const target of selected.values()) restoreBaseline(target)
  selected.clear()
  regions.length = 0
  strokes.length = 0
  styleChanges.length = 0
  marqueeStart = null
  marqueeRect = null
  drawing = null
  hover = null
  active = false
  window.removeEventListener("pointerdown", onPointerDown, true)
  window.removeEventListener("pointermove", onPointerMove, true)
  window.removeEventListener("pointerup", onPointerUp, true)
  window.removeEventListener("keydown", onKeyDown, true)
  window.removeEventListener("scroll", scheduleRender, true)
  window.removeEventListener("resize", scheduleRender, true)
  teardownHost()
}

function cancelAnnotation() {
  if (!active) return
  restoreAndTeardown()
}

function restoreBaseline(target: SelectedTarget) {
  const style = (target.el as HTMLElement).style
  for (const [property, previous] of target.baseline) {
    if (previous === null) style.removeProperty(property)
    else style.setProperty(property, previous)
  }
}

// ── pointer/keyboard handling ───────────────────────────────────────────

function onPointerDown(event: PointerEvent) {
  if (!active) return
  const picked = pickFromPoint(event.clientX, event.clientY)
  if (tool === "select") {
    if (!picked) return
    event.preventDefault()
    toggleSelect(picked, event.shiftKey)
    return
  }
  if (tool === "marquee") {
    marqueeStart = { x: event.clientX, y: event.clientY }
    marqueeRect = { x: event.clientX, y: event.clientY, width: 0, height: 0 }
    return
  }
  if (tool === "draw") {
    drawing = { points: [{ x: event.clientX, y: event.clientY }] }
    return
  }
  if (tool === "erase") {
    if (!picked) return
    event.preventDefault()
    eraseAt(event.clientX, event.clientY)
  }
}

function onPointerMove(event: PointerEvent) {
  if (!active) return
  if (tool === "select" || tool === "erase") {
    hover = pickFromPoint(event.clientX, event.clientY)
    scheduleRender()
    return
  }
  if (tool === "marquee" && marqueeStart) {
    marqueeRect = normalizeRect(marqueeStart, { x: event.clientX, y: event.clientY })
    scheduleRender()
    return
  }
  if (tool === "draw" && drawing) {
    drawing.points.push({ x: event.clientX, y: event.clientY })
    scheduleRender()
  }
}

function onPointerUp(event: PointerEvent) {
  if (!active) return
  if (tool === "marquee" && marqueeStart && marqueeRect) {
    finishMarquee(marqueeRect)
    marqueeStart = null
    marqueeRect = null
    scheduleRender()
    return
  }
  if (tool === "draw" && drawing) {
    finishDraw(drawing.points)
    drawing = null
    scheduleRender()
  }
  void event
}

/** Enter=attach, Cmd/Ctrl+Enter=send, Shift+Enter=newline (no submit), IME
 * composition never submits. stopImmediatePropagation so the inspected
 * page's own keybindings never consume the shortcut. */
function onKeyDown(event: KeyboardEvent) {
  if (!active) return
  const commentFocused = document.activeElement === host || shadow?.activeElement === commentEl

  if (event.key === "Escape") {
    event.preventDefault()
    event.stopImmediatePropagation()
    cancelAnnotation()
    return
  }

  if (commentFocused) {
    if (event.key !== "Enter" || event.isComposing) return
    event.stopImmediatePropagation()
    if (event.shiftKey) return // newline, no submit
    event.preventDefault()
    submit(event.metaKey || event.ctrlKey ? "send" : "attach")
    return
  }

  if (event.key === "v" || event.key === "V") setTool("select")
  else if (event.key === "r" || event.key === "R") setTool("marquee")
  else if (event.key === "d" || event.key === "D") setTool("draw")
  else if (event.key === "e" || event.key === "E") setTool("erase")
}

// ── select / marquee / draw / erase operations ──────────────────────────

function toggleSelect(picked: HoverTarget, additive: boolean) {
  const existing = [...selected.values()].find((t) => t.el === picked.el)
  if (existing) {
    restoreBaseline(existing)
    selected.delete(existing.id)
    scheduleRender()
    return
  }
  if (!additive) {
    for (const target of selected.values()) restoreBaseline(target)
    selected.clear()
  }
  const id = freshId("el")
  selected.set(id, { id, el: picked.el, offset: picked.offset, baseline: new Map() })
  scheduleRender()
}

function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): AnnotationRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
}

/** Marquee is a hybrid: collect elements (including inside same-origin
 * iframes) whose CENTER falls inside the drag rect, ordered
 * smallest-rendered-area-first, capped at 20. Only when ZERO candidates are
 * found does the rectangle itself become a region target — matches T3's
 * current-main semantics (not the open PR that keeps both). */
function finishMarquee(rect: AnnotationRect) {
  if (rect.width < ANNOTATION_MIN_MARQUEE_SIZE_PX && rect.height < ANNOTATION_MIN_MARQUEE_SIZE_PX) return

  const all: FrameCandidate[] = []
  collectFrameCandidates(document, { x: 0, y: 0 }, 0, all)

  const candidates: FrameCandidate[] = []
  const seen = new Set<Element>()
  for (const candidate of all) {
    if (seen.has(candidate.el)) continue
    const r = rectOf(candidate.el, candidate.offset)
    if (r.width === 0 || r.height === 0) continue
    const cx = r.x + r.width / 2
    const cy = r.y + r.height / 2
    if (cx < rect.x || cx > rect.x + rect.width || cy < rect.y || cy > rect.y + rect.height) continue
    seen.add(candidate.el)
    candidates.push(candidate)
  }

  candidates.sort((a, b) => {
    const ra = rectOf(a.el, a.offset)
    const rb = rectOf(b.el, b.offset)
    return ra.width * ra.height - rb.width * rb.height
  })

  const picked = candidates.slice(0, ANNOTATION_MARQUEE_MAX_ELEMENTS)
  if (picked.length === 0) {
    regions.push({ id: freshId("region"), rect })
    return
  }
  for (const candidate of picked) {
    const id = freshId("el")
    selected.set(id, { id, el: candidate.el, offset: candidate.offset, baseline: new Map() })
  }
}

/** Smooths the raw pointer trail with midpoint quadratic curves so strokes
 * don't look faceted at typical mouse sampling rates. */
function strokePathD(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ""
  if (points.length < 3) return `M ${points[0]!.x} ${points[0]!.y} L ${points.at(-1)!.x} ${points.at(-1)!.y}`
  let d = `M ${points[0]!.x} ${points[0]!.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const midX = (p1.x + p2.x) / 2
    const midY = (p1.y + p2.y) / 2
    d += ` Q ${p1.x} ${p1.y} ${midX} ${midY}`
  }
  const last = points.at(-1)!
  d += ` L ${last.x} ${last.y}`
  return d
}

function boundsOf(points: Array<{ x: number; y: number }>, strokeWidth: number): AnnotationRect {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const padding = strokeWidth + 3
  const minX = Math.min(...xs) - padding
  const minY = Math.min(...ys) - padding
  const maxX = Math.max(...xs) + padding
  const maxY = Math.max(...ys) + padding
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

const STROKE_COLOR = "#f97316"
const STROKE_WIDTH = 3

function finishDraw(points: Array<{ x: number; y: number }>) {
  if (points.length < 2) return
  strokes.push({ id: freshId("stroke"), color: STROKE_COLOR, width: STROKE_WIDTH, points, bounds: boundsOf(points, STROKE_WIDTH) })
}

function rectsIntersectPoint(rect: AnnotationRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

/** Erase checks selected elements, then regions, then stroke bounds — cheap
 * bounding-box hit testing rather than exact distance-to-polyline. Points are
 * always in TOP-viewport space (pointer events are captured on the top
 * window), so target rects must go through the same offset translation. */
function eraseAt(x: number, y: number) {
  for (const [id, target] of selected) {
    if (rectsIntersectPoint(rectOf(target.el, target.offset), x, y)) {
      restoreBaseline(target)
      selected.delete(id)
      return
    }
  }
  for (let i = regions.length - 1; i >= 0; i--) {
    if (rectsIntersectPoint(regions[i]!.rect, x, y)) {
      regions.splice(i, 1)
      return
    }
  }
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (rectsIntersectPoint(strokes[i]!.bounds, x, y)) {
      strokes.splice(i, 1)
      return
    }
  }
}

function setTool(next: AnnotationTool) {
  tool = next
  marqueeStart = null
  marqueeRect = null
  drawing = null
  renderToolbar()
}

// ── live CSS style adjustment (transactional) ───────────────────────────

/** Apply a proposed style value to every selected target, recording the
 * ORIGINAL value once per (target, property) so teardown can restore it
 * exactly. Uses !important so page stylesheets with higher specificity don't
 * silently swallow the preview edit. */
function applyStyleChange(property: StyleProperty, value: string) {
  for (const target of selected.values()) {
    const el = target.el as HTMLElement
    if (!target.baseline.has(property)) {
      target.baseline.set(property, el.style.getPropertyValue(property) || null)
    }
    el.style.setProperty(property, value, "important")
    styleChanges.push({
      targetId: target.id,
      selector: null, // filled in by main after element context capture
      property,
      previousValue: target.baseline.get(property) ?? null,
      value,
    })
  }
  scheduleRender()
}

// ── width/height aspect lock ────────────────────────────────────────────

let aspectLocked = true

function applySizeChange(axis: "width" | "height", raw: string) {
  const target = [...selected.values()][0]
  if (!target) return
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value <= 0) return
  const rect = rectOf(target.el, target.offset)
  const ratio = rect.width / Math.max(1, rect.height)

  applyStyleChange(axis, `${Math.max(1, Math.round(value))}px`)
  if (!aspectLocked) return
  if (axis === "width") applyStyleChange("height", `${Math.max(1, Math.round(value / ratio))}px`)
  else applyStyleChange("width", `${Math.max(1, Math.round(value * ratio))}px`)
}

// ── submit ───────────────────────────────────────────────────────────────

function unionCrop(): AnnotationRect | null {
  const rects: AnnotationRect[] = [
    ...[...selected.values()].map((t) => rectOf(t.el, t.offset)),
    ...regions.map((r) => r.rect),
    ...strokes.map((s) => s.bounds),
  ]
  if (rects.length === 0) return null

  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))

  const x = Math.max(0, left - ANNOTATION_CROP_PADDING_PX)
  const y = Math.max(0, top - ANNOTATION_CROP_PADDING_PX)
  const maxRight = Math.min(window.innerWidth, right + ANNOTATION_CROP_PADDING_PX)
  const maxBottom = Math.min(window.innerHeight, bottom + ANNOTATION_CROP_PADDING_PX)
  return { x, y, width: Math.max(1, maxRight - x), height: Math.max(1, maxBottom - y) }
}

function submit(submission: AnnotationSubmission) {
  const elements = [...selected.values()].map(elementContext)
  // Fill in the selector now that we have full element context, matching the
  // "selector: null until element context is captured" note in the handoff.
  const finalStyleChanges = styleChanges.map((change) => {
    const target = selected.get(change.targetId)
    return target ? { ...change, selector: computeSelector(target.el) } : change
  })

  const payload: BrowserAnnotationPayload = {
    id: freshId("annotation"),
    pageUrl: location.href,
    pageTitle: document.title || null,
    comment: commentEl?.value.trim() ?? "",
    elements,
    regions: [...regions],
    strokes: [...strokes],
    styleChanges: finalStyleChanges,
    screenshot: null,
    cropRect: unionCrop(),
    submission,
    createdAt: new Date().toISOString(),
  }

  // Hide chrome (toolbar/comment/style panel) but keep outlines/ink visible —
  // the capture should show the annotated marks, not the tool controls.
  setChromeVisible(false)
  ipcRenderer.send(ANNOTATION_PICKED_CHANNEL, payload)
}

// main acks once capture has settled (success or failure) — only then is it
// safe to restore baselines, since main may still be reading live styles.
ipcRenderer.on(ANNOTATION_CAPTURED_CHANNEL, () => {
  restoreAndTeardown()
})

ipcRenderer.on(ANNOTATION_START_CHANNEL, () => {
  startAnnotation()
})

ipcRenderer.on(ANNOTATION_CANCEL_CHANNEL, () => {
  cancelAnnotation()
})

ipcRenderer.on(ANNOTATION_THEME_CHANNEL, (_event, value: "light" | "dark") => {
  theme = value
  applyThemeClass()
})

// ── rendering ────────────────────────────────────────────────────────────

function scheduleRender() {
  if (rafHandle) return
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0
    render()
  })
}

function setChromeVisible(visible: boolean) {
  if (toolbarEl) toolbarEl.style.display = visible ? "flex" : "none"
  if (stylePanelEl) stylePanelEl.style.display = visible && selected.size > 0 ? "flex" : "none"
}

function applyThemeClass() {
  host?.classList.toggle("dark", theme === "dark")
}

function box(rect: AnnotationRect, kind: string): HTMLDivElement {
  const el = document.createElement("div")
  el.className = `box ${kind}`
  el.style.left = `${rect.x}px`
  el.style.top = `${rect.y}px`
  el.style.width = `${rect.width}px`
  el.style.height = `${rect.height}px`
  return el
}

function render() {
  if (!active || !outlineLayer || !drawSvg) return
  outlineLayer.replaceChildren()

  if (hover && tool !== "marquee" && ![...selected.values()].some((t) => t.el === hover!.el)) {
    outlineLayer.appendChild(box(rectOf(hover.el, hover.offset), "hover"))
  }
  for (const target of selected.values()) outlineLayer.appendChild(box(rectOf(target.el, target.offset), "selected"))
  for (const region of regions) outlineLayer.appendChild(box(region.rect, "region"))
  if (marqueeRect) outlineLayer.appendChild(box(marqueeRect, "marquee"))

  drawSvg.replaceChildren()
  const renderStroke = (points: Array<{ x: number; y: number }>) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", strokePathD(points))
    path.setAttribute("stroke", STROKE_COLOR)
    path.setAttribute("stroke-width", String(STROKE_WIDTH))
    path.setAttribute("fill", "none")
    path.setAttribute("stroke-linecap", "round")
    path.setAttribute("stroke-linejoin", "round")
    drawSvg!.appendChild(path)
  }
  for (const stroke of strokes) renderStroke(stroke.points)
  if (drawing) renderStroke(drawing.points)

  renderStylePanel()
}

function buildToolbar() {
  if (!shadow) return
  toolbarEl = document.createElement("div")
  toolbarEl.className = "toolbar"
  toolbarEl.setAttribute(OVERLAY_ATTRIBUTE, "")
  toolbarEl.style.pointerEvents = "auto"

  const tools: Array<{ tool: AnnotationTool; label: string; key: string }> = [
    { tool: "select", label: "Select", key: "V" },
    { tool: "marquee", label: "Region", key: "R" },
    { tool: "draw", label: "Draw", key: "D" },
    { tool: "erase", label: "Erase", key: "E" },
  ]
  const toolGroup = document.createElement("div")
  toolGroup.className = "tool-group"
  for (const entry of tools) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = `${entry.label} (${entry.key})`
    button.dataset.tool = entry.tool
    button.onclick = () => setTool(entry.tool)
    toolGroup.appendChild(button)
  }
  toolbarEl.appendChild(toolGroup)

  const cancelButton = document.createElement("button")
  cancelButton.type = "button"
  cancelButton.className = "cancel"
  cancelButton.textContent = "✕ Cancel"
  cancelButton.onclick = () => cancelAnnotation()
  toolbarEl.appendChild(cancelButton)

  shadow.appendChild(toolbarEl)

  const commentBar = document.createElement("div")
  commentBar.className = "comment-bar"
  commentBar.setAttribute(OVERLAY_ATTRIBUTE, "")
  commentBar.style.pointerEvents = "auto"

  commentEl = document.createElement("textarea")
  commentEl.placeholder = "Add a comment (Enter to attach, ⌘/Ctrl+Enter to send)…"
  commentEl.rows = 1
  commentBar.appendChild(commentEl)

  const attachButton = document.createElement("button")
  attachButton.type = "button"
  attachButton.textContent = "Attach"
  attachButton.onclick = () => submit("attach")
  commentBar.appendChild(attachButton)

  const sendButton = document.createElement("button")
  sendButton.type = "button"
  sendButton.className = "primary"
  sendButton.textContent = "Send"
  sendButton.onclick = () => submit("send")
  commentBar.appendChild(sendButton)

  shadow.appendChild(commentBar)

  stylePanelEl = document.createElement("div")
  stylePanelEl.className = "style-panel"
  stylePanelEl.setAttribute(OVERLAY_ATTRIBUTE, "")
  stylePanelEl.style.pointerEvents = "auto"
  stylePanelEl.style.display = "none"
  shadow.appendChild(stylePanelEl)

  renderToolbar()
}

function renderToolbar() {
  if (!toolbarEl) return
  for (const button of toolbarEl.querySelectorAll<HTMLButtonElement>("button[data-tool]")) {
    button.classList.toggle("active", button.dataset.tool === tool)
  }
}

const STYLE_FIELDS: Array<{ property: StyleProperty; label: string; kind: "text" | "color" }> = [
  { property: "font-size", label: "Font size", kind: "text" },
  { property: "color", label: "Text color", kind: "color" },
  { property: "background-color", label: "Background", kind: "color" },
  { property: "border-radius", label: "Radius", kind: "text" },
  { property: "padding", label: "Padding", kind: "text" },
  { property: "margin", label: "Margin", kind: "text" },
  { property: "gap", label: "Gap", kind: "text" },
]

function renderStylePanel() {
  if (!stylePanelEl) return
  const visible = selected.size > 0
  stylePanelEl.style.display = visible ? "flex" : "none"
  if (!visible) return
  if (stylePanelEl.childElementCount > 0) return // built once per selection; inputs are uncontrolled

  stylePanelEl.replaceChildren()

  const sizeRow = document.createElement("div")
  sizeRow.className = "row"
  const widthInput = document.createElement("input")
  widthInput.type = "text"
  widthInput.placeholder = "Width"
  widthInput.onchange = () => applySizeChange("width", widthInput.value)
  const heightInput = document.createElement("input")
  heightInput.type = "text"
  heightInput.placeholder = "Height"
  heightInput.onchange = () => applySizeChange("height", heightInput.value)
  const lockButton = document.createElement("button")
  lockButton.type = "button"
  lockButton.textContent = aspectLocked ? "🔒" : "🔓"
  lockButton.title = "Lock aspect ratio"
  // Prevent pointerdown from moving focus before the click handler runs, so
  // an in-flight comment-box blur doesn't fire before the toggle is applied.
  lockButton.onpointerdown = (event) => event.preventDefault()
  lockButton.onclick = () => {
    aspectLocked = !aspectLocked
    lockButton.textContent = aspectLocked ? "🔒" : "🔓"
  }
  sizeRow.append(widthInput, heightInput, lockButton)
  stylePanelEl.appendChild(sizeRow)

  for (const field of STYLE_FIELDS) {
    const row = document.createElement("div")
    row.className = "row"
    const label = document.createElement("label")
    label.textContent = field.label
    const input = document.createElement("input")
    input.type = field.kind === "color" ? "color" : "text"
    input.placeholder = field.label
    input.onchange = () => applyStyleChange(field.property, input.value)
    row.append(label, input)
    stylePanelEl.appendChild(row)
  }
}

const STYLE_SHEET = `
  :host { all: initial; }
  .outline-layer, .draw-layer { position: fixed; inset: 0; pointer-events: none; }
  .draw-layer { width: 100%; height: 100%; }
  .box { position: fixed; pointer-events: none; border-radius: 2px; box-sizing: border-box; }
  .box.hover { border: 1.5px dashed rgba(249, 115, 22, 0.6); }
  .box.selected { border: 2px solid #f97316; background: rgba(249, 115, 22, 0.08); }
  .box.region { border: 2px dashed #f97316; background: rgba(249, 115, 22, 0.05); }
  .box.marquee { border: 1.5px solid #3b82f6; background: rgba(59, 130, 246, 0.08); }

  .toolbar, .comment-bar, .style-panel {
    position: fixed;
    font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #18181b;
    color: #f4f4f5;
    border: 1px solid #3f3f46;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    z-index: 1;
  }
  :host(.dark) .toolbar, :host(.dark) .comment-bar, :host(.dark) .style-panel {
    background: #09090b;
    border-color: #27272a;
  }

  .toolbar { top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
  .tool-group { display: flex; gap: 4px; }
  .toolbar button, .comment-bar button, .style-panel button { font: inherit; color: inherit; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 5px 9px; cursor: pointer; }
  .toolbar button:hover, .comment-bar button:hover { background: rgba(255,255,255,0.08); }
  .toolbar button.active { background: #f97316; color: #18181b; }
  .toolbar button.cancel { margin-left: 8px; }
  .comment-bar button.primary { background: #f97316; color: #18181b; }

  .comment-bar { bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: flex-end; gap: 6px; padding: 6px; width: min(520px, 80vw); }
  .comment-bar textarea { flex: 1; resize: none; background: rgba(255,255,255,0.06); border: 1px solid #3f3f46; border-radius: 6px; color: inherit; font: inherit; padding: 6px 8px; max-height: 96px; }

  .style-panel { top: 12px; right: 12px; display: flex; flex-direction: column; gap: 6px; padding: 8px; width: 176px; }
  .style-panel .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .style-panel label { flex: 1; color: #a1a1aa; }
  .style-panel input[type="text"] { width: 72px; background: rgba(255,255,255,0.06); border: 1px solid #3f3f46; border-radius: 4px; color: inherit; font: inherit; padding: 3px 6px; }
  .style-panel input[type="color"] { width: 28px; height: 20px; border: none; background: none; padding: 0; }
`
