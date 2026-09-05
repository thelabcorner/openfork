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
import {
  decimateStroke,
  harvestMarquee,
  REGION_COEXISTS_WITH_ELEMENTS,
  smoothStrokePath,
  unionCropRect,
} from "../main/browser/annotation-geometry"

const OVERLAY_ATTRIBUTE = "data-openfork-annotation-ui"
const Z_INDEX_OVERLAY = 2147483646
/** Top document only — never traverse into iframes (the isolated preload's
 * world is per-document; an iframe has its own guest world and its own
 * annotation session, so descending here would double-capture and corrupt
 * offsets). Selecting documentElement/body is always a bug (see skip guards). */
const PREFERS_REDUCED_MOTION =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

type AnnotationTool = "select" | "marquee" | "draw" | "erase"
type FrameOffset = { x: number; y: number }

type SelectedTarget = {
  id: string
  el: Element
  offset: FrameOffset
  baseline: Map<string, string | null>
}

type HoverTarget = { el: Element; offset: FrameOffset }

type StyleProperty =
  | "font-family"
  | "font-size"
  | "font-weight"
  | "line-height"
  | "color"
  | "background-color"
  | "opacity"
  | "border-radius"
  | "border-color"
  | "border-width"
  | "border-style"
  | "width"
  | "height"
  | "padding"
  | "margin"
  | "gap"

let active = false
let theme: "light" | "dark" = "light"
let tool: AnnotationTool = "select"
let host: HTMLDivElement | undefined
let shadow: ShadowRoot | undefined
let outlineLayer: HTMLDivElement | undefined
let drawSvg: SVGSVGElement | undefined
let toolbarEl: HTMLDivElement | undefined
let commentEl: HTMLTextAreaElement | undefined
let commentBarEl: HTMLDivElement | undefined
let stylePanelEl: HTMLDivElement | undefined
/** True while editor chrome (toolbar, comment box, hover outline) is hidden at
 * submit time so the capture shows only the requested marks + temporary CSS. */
let chromeHidden = false
let rafHandle = 0
let domObserver: MutationObserver | undefined
let pageHideHandler: (() => void) | undefined

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

/** Hit-test the TOP document only. The isolated preload world is per-document,
 * so an iframe carries its own guest world and owns its own annotation
 * session; descending here would double-capture and corrupt offsets.
 * documentElement/body are skipped — selecting the body is always a bug. */
function pickFromPoint(clientX: number, clientY: number): HoverTarget | null {
  for (const candidate of document.elementsFromPoint(clientX, clientY)) {
    if (!(candidate instanceof Element)) continue
    if (isAnnotationNode(candidate)) continue
    if (candidate === document.documentElement || candidate === document.body) continue
    return { el: candidate, offset: { x: 0, y: 0 } }
  }
  return null
}

type FrameCandidate = { el: Element; offset: FrameOffset }

/** Candidate collection for marquee hit testing — everything in the top
 * document whose center falls inside the drag rect, in the same coordinate
 * space the renderer will use (top-viewport). */
function collectFrameCandidates(doc: Document, offset: FrameOffset, out: FrameCandidate[]): void {
  for (const el of doc.querySelectorAll("*")) {
    if (isAnnotationNode(el)) continue
    if (el === doc.documentElement || el === doc.body) continue
    out.push({ el, offset })
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
  // The whole overlay is a modal annotation dialog: give it a dialog role and
  // accessible name so assistive tech announces it as a single interactive
  // surface (closed shadow root keeps focus internal).
  host.setAttribute("role", "dialog")
  host.setAttribute("aria-label", "Browser annotation")
  host.setAttribute("aria-modal", "false")
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

  // Resilience: if the inspected page wipes documentElement's children (some
  // SPAs replace <html> contents), the overlay host is detached. Re-append it
  // so the annotation session survives the DOM churn.
  if (typeof MutationObserver === "function") {
    domObserver = new MutationObserver(() => {
      if (host && !document.documentElement.contains(host)) {
        document.documentElement.appendChild(host)
      }
    })
    domObserver.observe(document.documentElement, { childList: true })
  }

  buildToolbar()
}

function teardownHost() {
  if (rafHandle) cancelAnimationFrame(rafHandle)
  rafHandle = 0
  domObserver?.disconnect()
  domObserver = undefined
  if (pageHideHandler) {
    window.removeEventListener("pagehide", pageHideHandler, true)
    window.removeEventListener("visibilitychange", pageHideHandler, true)
    pageHideHandler = undefined
  }
  host?.remove()
  host = undefined
  shadow = undefined
  outlineLayer = undefined
  drawSvg = undefined
  toolbarEl = undefined
  commentEl = undefined
  commentBarEl = undefined
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
  // Terminal path: a navigation/unload must restore temporary CSS before the
  // page goes away — otherwise a preview edit leaks into the next page.
  pageHideHandler = () => {
    if (active) cancelAnnotation()
  }
  window.addEventListener("pagehide", pageHideHandler, true)
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && active) cancelAnnotation()
  }, true)
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
    const last = drawing.points[drawing.points.length - 1]
    // Decimate: skip points closer than ~2px so strokes stay compact and the
    // midpoint-smoothed path doesn't carry redundant samples.
    if (!last || Math.hypot(event.clientX - last.x, event.clientY - last.y) >= 2) {
      drawing.points.push({ x: event.clientX, y: event.clientY })
    }
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

  // Focus trap: keep Tab cycling within the dialog's interactive controls so
  // keyboard users can't tab out into the inspected page. Documented order:
  // tool buttons -> comment field -> style panel -> attach/send -> cancel.
  if (event.key === "Tab" && shadow) {
    const focusables = Array.from(
      shadow.querySelectorAll<HTMLElement>(
        'button, textarea, input, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === commentEl)
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    const activeEl = shadow.activeElement as HTMLElement | null
    if (event.shiftKey && (activeEl === first || activeEl === null)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && activeEl === last) {
      event.preventDefault()
      first.focus()
    } else if (!event.shiftKey && activeEl === null) {
      event.preventDefault()
      first.focus()
    }
  }

  if (commentFocused) {
    if (event.key !== "Enter" || event.isComposing) return
    event.stopImmediatePropagation()
    if (event.shiftKey) return // newline, no submit
    event.preventDefault()
    submit(event.metaKey || event.ctrlKey ? "send" : "attach")
    return
  }

  // Tool shortcuts are suppressed while focus is in the comment field so typing
  // "r"/"d"/"e" in a comment doesn't switch tools (the Field/Enter block above
  // already handled Enter). V/R/D/E only act when the chrome, not the textarea,
  // has focus.
  if (!commentFocused) {
    if (event.key === "v" || event.key === "V") setTool("select")
    else if (event.key === "r" || event.key === "R") setTool("marquee")
    else if (event.key === "d" || event.key === "D") setTool("draw")
    else if (event.key === "e" || event.key === "E") setTool("erase")
  }
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
  collectFrameCandidates(document, { x: 0, y: 0 }, all)

  // De-dupe by element (an element can appear once per document tree).
  const byEl = new Map<Element, FrameCandidate>()
  for (const candidate of all) if (!byEl.has(candidate.el)) byEl.set(candidate.el, candidate)

  const rects = [...byEl.values()].map((c, i) => ({
    el: c.el,
    offset: c.offset,
    rect: rectOf(c.el, c.offset),
    key: `${c.el.tagName.toLowerCase()}-${i}`,
  }))

  // harvestMarquee (shared pure helper): centers-inside region, ascending area,
  // capped at ANNOTATION_MARQUEE_MAX_ELEMENTS. MarqueeCandidate needs id/rect/area.
  const candidates = rects.map((c) => ({ id: c.key, rect: c.rect, area: c.rect.width * c.rect.height }))
  const picked = harvestMarquee(rect, candidates, ANNOTATION_MARQUEE_MAX_ELEMENTS)

  for (const p of picked) {
    const match = rects.find((r) => r.key === p.id)
    if (!match) continue
    const id = freshId("el")
    selected.set(id, { id, el: match.el, offset: match.offset, baseline: new Map() })
  }

  // REGION_COEXISTS_WITH_ELEMENTS (default true): always record a region so a
  // blank-area drag is never a no-op. Legacy mode: only when zero candidates.
  if (REGION_COEXISTS_WITH_ELEMENTS || picked.length === 0) {
    regions.push({ id: freshId("region"), rect })
  }
}

/** Stroke bounding box (shared helper strokeBounds could also be used; kept
 * local because it runs on every move in the live draw path). */
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
  const decimated = decimateStroke(points, 2)
  if (decimated.length < 2) return
  strokes.push({
    id: freshId("stroke"),
    color: STROKE_COLOR,
    width: STROKE_WIDTH,
    points: decimated,
    bounds: boundsOf(decimated, STROKE_WIDTH),
  })
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
  // Shared pure helper: union + pad + clamp to viewport (host re-validates).
  // CropTarget = { rect }, so map each rect into that shape.
  return unionCropRect(
    rects.map((r) => ({ rect: r })),
    { width: window.innerWidth, height: window.innerHeight },
    ANNOTATION_CROP_PADDING_PX,
  )
}

/** Capture ONE selected element's structured record. DOM-derived fields are
 * built synchronously and always succeed; the enriched React/source metadata
 * read is wrapped so a throw on one hostile target omits ONLY that target's
 * enriched fields and keeps its DOM-derived fields — never rejects the whole
 * session. */
async function captureElement(target: SelectedTarget): Promise<AnnotationElementContext> {
  const base = {
    id: target.id,
    tagName: target.el.tagName.toLowerCase(),
    selector: computeSelector(target.el),
    htmlPreview: boundedHtmlPreview(target.el),
    styles: boundedStyles(target.el),
    rect: rectOf(target.el, target.offset),
  }
  try {
    const react = reactComponentContext(target.el)
    return { ...base, componentName: react.componentName, source: react.source }
  } catch {
    return { ...base, componentName: null, source: null }
  }
}

let submitting = false

async function submit(submission: AnnotationSubmission) {
  if (submitting) return
  submitting = true

  // CAPTURE ORDERING (per contracts/invariants #5 — DO NOT REORDER):
  // 1. capture element records at SUBMIT time (not at click time) so hover
  //    latency stays flat, via Promise.all(...) with per-target fault isolation;
  // 2. hide EDITOR CHROME ONLY (toolbar, comment box, hover outline) while
  //    LEAVING selection outlines, region boxes, ink VISIBLE and LEAVING
  //    temporary CSS APPLIED;
  // 3. send payload + crop;
  // 4. WAIT for the host's capture-complete ack (ANNOTATION_CAPTURED_CHANNEL);
  // 5. THEN (and only then) restore baselines and tear down.
  // Restoring CSS or removing marks BEFORE the ack produces a screenshot that
  // does not show what the user asked for.
  const elements = await Promise.all([...selected.values()].map(captureElement))

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

  // Hides ONLY the editor chrome (toolbar + comment box + hover outline) — the
  // marks and any temporary CSS stay in place for the capture.
  setChromeVisible(false)
  ipcRenderer.send(ANNOTATION_PICKED_CHANNEL, payload)
}

// main acks once capture has settled (success or failure) — only then is it
// safe to restore baselines, since main may still be reading live styles.
ipcRenderer.on(ANNOTATION_CAPTURED_CHANNEL, () => {
  if (!active) return
  submitting = false
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
  chromeHidden = !visible
  if (toolbarEl) toolbarEl.style.display = visible ? "flex" : "none"
  if (commentBarEl) commentBarEl.style.display = visible ? "flex" : "none"
  if (stylePanelEl) stylePanelEl.style.display = visible && selected.size > 0 ? "flex" : "none"
  // Hover outline is editor chrome too — keep it out of the crop shot, but the
  // persistent selection/region boxes and ink stay visible (they are the mark).
  hover = null
}

function applyThemeClass() {
  host?.classList.toggle("dark", theme === "dark")
}

function box(rect: AnnotationRect, kind: string, label?: string): HTMLDivElement {
  const el = document.createElement("div")
  el.className = `box ${kind}`
  el.style.left = `${rect.x}px`
  el.style.top = `${rect.y}px`
  el.style.width = `${rect.width}px`
  el.style.height = `${rect.height}px`
  if (label) {
    const chip = document.createElement("span")
    chip.className = "chip"
    chip.textContent = label
    el.appendChild(chip)
  }
  return el
}

/** Compact label for a hover/selection target: component name when React
 * metadata is available (dev builds), otherwise the tag name. The annotation is
 * fully useful with either — Phase-1 degradation (ADR-001) is acceptable. */
function labelFor(el: Element): string {
  const react = reactComponentContext(el)
  return react.componentName ?? el.tagName.toLowerCase()
}

function render() {
  if (!active || !outlineLayer || !drawSvg) return
  const layer = outlineLayer
  layer.replaceChildren()

  // Hover outline + compact label chip (editor chrome; hidden at submit).
  if (hover && tool !== "marquee" && !chromeHidden && ![...selected.values()].some((t) => t.el === hover!.el)) {
    layer.appendChild(box(rectOf(hover.el, hover.offset), "hover", labelFor(hover.el)))
  }
  // Persistent selection boxes carry a NUMBERED chip so selection state is
  // conveyed by outline PLUS number, never by color alone (a11y).
  const selectedEntries = [...selected.values()]
  selectedEntries.forEach((target, index) => {
    const b = box(rectOf(target.el, target.offset), "selected", String(index + 1))
    layer.appendChild(b)
  })
  for (const region of regions) layer.appendChild(box(region.rect, "region"))
  if (marqueeRect) layer.appendChild(box(marqueeRect, "marquee"))

  drawSvg.replaceChildren()
  const renderStroke = (points: Array<{ x: number; y: number }>) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", smoothStrokePath(points))
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
    button.setAttribute("aria-pressed", entry.tool === tool ? "true" : "false")
    button.setAttribute("aria-label", `${entry.label} tool`)
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

  commentBarEl = commentBar
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
    button.setAttribute("aria-pressed", button.dataset.tool === tool ? "true" : "false")
  }
}

const STYLE_FIELDS: Array<{ property: StyleProperty; label: string; kind: "text" | "color" | "number" }> = [
  { property: "font-family", label: "Font family", kind: "text" },
  { property: "font-size", label: "Font size", kind: "text" },
  { property: "font-weight", label: "Font weight", kind: "text" },
  { property: "line-height", label: "Line height", kind: "text" },
  { property: "color", label: "Text color", kind: "color" },
  { property: "background-color", label: "Background", kind: "color" },
  { property: "opacity", label: "Opacity", kind: "number" },
  { property: "border-radius", label: "Radius", kind: "text" },
  { property: "border-color", label: "Border color", kind: "color" },
  { property: "border-width", label: "Border width", kind: "text" },
  { property: "border-style", label: "Border style", kind: "text" },
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

  /* Compact label chip — component name when known, else tag name. Rendered on
  the top-left of each box so the marked target is identified even when the box
  border is hard to see against the page. */
  .box .chip {
    position: absolute;
    left: -1px;
    top: -18px;
    font: 600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.4;
    padding: 1px 6px;
    border-radius: 4px;
    background: #f97316;
    color: #18181b;
    white-space: nowrap;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .box.hover .chip { background: rgba(249, 115, 22, 0.85); }
  /* Selection uses a NUMBERED chip (outline PLUS number — never color alone). */
  .box.selected .chip { background: #18181b; color: #f4f4f5; border: 1px solid #f97316; }

  /* Visible focus rings that survive BOTH light and dark page backgrounds:
  a high-contrast double ring (light outer halo + dark inner) so the focused
  control is always distinguishable from the page regardless of its color. */
  .toolbar button:focus-visible, .comment-bar button:focus-visible, .style-panel button:focus-visible,
  .comment-bar textarea:focus-visible, .style-panel input:focus-visible {
    outline: 2px solid #0b0b0c;
    outline-offset: 2px;
    box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.9);
  }
  :host(.dark) .toolbar button:focus-visible, :host(.dark) .comment-bar button:focus-visible,
  :host(.dark) .style-panel button:focus-visible, :host(.dark) .comment-bar textarea:focus-visible,
  :host(.dark) .style-panel input:focus-visible {
    outline-color: #f4f4f5;
    box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.9);
  }

  /* Respect reduced-motion: drop transitions/animations inside the overlay. */
  @media (prefers-reduced-motion: reduce) {
    .box, .toolbar, .comment-bar, .style-panel, .toolbar button, .comment-bar button, .style-panel button {
      transition: none !important;
      animation: none !important;
    }
  }
`
