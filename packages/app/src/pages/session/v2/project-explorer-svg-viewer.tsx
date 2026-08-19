import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import type { LanguageSupport } from "@codemirror/language"
import type { Decoration, DecorationSet, EditorView, ViewUpdate } from "@codemirror/view"
import type { AttrSpec, ElementSpec } from "@codemirror/lang-xml"
import "./project-explorer-media-viewer.css"

const MAX_SCALE = 8

export type MediaZoom = {
  percent: () => number
  zoomBy: (factor: number) => void
  reset: () => void
  onWheel: (event: WheelEvent) => void
  onPointerDown: (event: PointerEvent) => void
  onPointerMove: (event: PointerEvent) => void
  onPointerUp: (event: PointerEvent) => void
  onPointerCancel: (event: PointerEvent) => void
}

const PAN_TARGET_SELECTOR = '[data-slot="project-explorer-media-zoom-toolbar"]'
const FLING_VELOCITY_THRESHOLD = 0.3
const FLING_STOP_THRESHOLD = 0.05

/** Scroll-based inertial zoom for a transform-only stage. `viewport` owns the
 * wheel and pointer events; `stage` carries the `translate() scale()` transform;
 * the image fills the stage at 100% with object-fit contain, so min scale is 1
 * (fit). Pan (click-drag with fling inertia) only applies while zoomed in, and
 * translate is clamped so the stage always covers the viewport — which also
 * re-centers the image whenever scale returns to 1. */
export function createMediaZoom(props: {
  viewport: () => HTMLDivElement | undefined
  stage: () => HTMLDivElement | undefined
}): MediaZoom {
  const [percent, setPercent] = createSignal(100)
  let raf = 0
  let panRaf = 0
  let scale = 1
  let targetScale = 1
  let tx = 0
  let ty = 0
  let anchorX = 0
  let anchorY = 0
  let velocity = 0
  let dragging = false
  let lastPointerX = 0
  let lastPointerY = 0
  let velX = 0
  let velY = 0
  let lastGlideAt = 0
  let samples: { x: number; y: number; t: number }[] = []
  let cursor = "default"

  const clampTarget = (value: number) => Math.min(Math.max(value, 1), MAX_SCALE)

  const clampPan = () => {
    const viewport = props.viewport()
    if (!viewport) return { x: false, y: false }
    const maxX = (scale - 1) * viewport.clientWidth
    const maxY = (scale - 1) * viewport.clientHeight
    const nextX = Math.min(0, Math.max(-maxX, tx))
    const nextY = Math.min(0, Math.max(-maxY, ty))
    const clampedX = nextX !== tx
    const clampedY = nextY !== ty
    tx = nextX
    ty = nextY
    return { x: clampedX, y: clampedY }
  }

  const syncCursor = () => {
    const next = dragging ? "grabbing" : scale > 1.0001 ? "grab" : "default"
    if (next === cursor) return
    cursor = next
    const viewport = props.viewport()
    if (viewport) viewport.style.cursor = next
  }

  const apply = () => {
    const stage = props.stage()
    if (stage) stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    syncCursor()
  }

  const syncPercent = () => {
    const pct = Math.round(scale * 100)
    if (pct !== percent()) setPercent(pct)
  }

  const step = (prev: number) => {
    const ratio = scale / prev
    tx = anchorX - (anchorX - tx) * ratio
    ty = anchorY - (anchorY - ty) * ratio
    clampPan()
    syncPercent()
    apply()
  }

  const tick = () => {
    raf = 0
    const prev = scale
    const diff = targetScale - scale
    if (Math.abs(diff) < 0.0004) scale = targetScale
    else scale += diff * (0.32 - 0.08 * Math.min(velocity / 300, 1))
    step(prev)
    if (scale !== targetScale) raf = requestAnimationFrame(tick)
  }

  const startLoop = () => {
    if (!raf) raf = requestAnimationFrame(tick)
  }

  const nudge = (amount: number) => {
    if (scale === targetScale) return
    const prev = scale
    scale += (targetScale - scale) * amount
    step(prev)
  }

  const stopGlide = () => {
    if (panRaf) {
      cancelAnimationFrame(panRaf)
      panRaf = 0
    }
    velX = 0
    velY = 0
  }

  const glide = (now: number) => {
    panRaf = 0
    const dt = Math.min(now - lastGlideAt, 32)
    lastGlideAt = now
    const decay = Math.pow(0.93, dt / 16.7)
    tx += velX * dt
    ty += velY * dt
    const { x: clampedX, y: clampedY } = clampPan()
    if (clampedX) velX = 0
    if (clampedY) velY = 0
    velX *= decay
    velY *= decay
    apply()
    if (Math.hypot(velX, velY) > FLING_STOP_THRESHOLD) panRaf = requestAnimationFrame(glide)
  }

  const startGlide = () => {
    lastGlideAt = performance.now()
    panRaf = requestAnimationFrame(glide)
  }

  const onWheel = (event: WheelEvent) => {
    const viewport = props.viewport()
    if (!viewport || dragging) return
    event.preventDefault()
    if (event.deltaY === 0) return
    stopGlide()
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
    const rect = viewport.getBoundingClientRect()
    anchorX = event.clientX - rect.left
    anchorY = event.clientY - rect.top
    velocity = velocity * 0.7 + Math.abs(delta) * 0.3
    const factor = Math.exp(-delta * 0.001)
    targetScale = clampTarget(targetScale * Math.min(Math.max(factor, 0.5), 2))
    nudge(0.35)
    startLoop()
  }

  const zoomBy = (factor: number) => {
    const viewport = props.viewport()
    if (!viewport) return
    stopGlide()
    anchorX = viewport.clientWidth / 2
    anchorY = viewport.clientHeight / 2
    targetScale = clampTarget(scale * factor)
    nudge(0.5)
    startLoop()
  }

  const reset = () => {
    const viewport = props.viewport()
    if (!viewport) return
    stopGlide()
    anchorX = viewport.clientWidth / 2
    anchorY = viewport.clientHeight / 2
    targetScale = 1
    nudge(0.5)
    startLoop()
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || scale <= 1.0001) return
    const target = event.target as Element | null
    if (target?.closest(PAN_TARGET_SELECTOR)) return
    const viewport = props.viewport()
    if (!viewport) return
    event.preventDefault()
    dragging = true
    velX = 0
    velY = 0
    samples = []
    lastPointerX = event.clientX
    lastPointerY = event.clientY
    targetScale = scale
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    stopGlide()
    viewport.setPointerCapture?.(event.pointerId)
    syncCursor()
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return
    tx += event.clientX - lastPointerX
    ty += event.clientY - lastPointerY
    lastPointerX = event.clientX
    lastPointerY = event.clientY
    clampPan()
    apply()
    const now = performance.now()
    samples.push({ x: event.clientX, y: event.clientY, t: now })
    if (samples.length > 4) samples.shift()
    while (samples.length > 1 && now - samples[0].t > 120) samples.shift()
  }

  const endDrag = (event: PointerEvent, fling: boolean) => {
    if (!dragging) return
    dragging = false
    const viewport = props.viewport()
    viewport?.releasePointerCapture?.(event.pointerId)
    if (fling && scale > 1.0001 && samples.length >= 2) {
      const a = samples[samples.length - 2]
      const b = samples[samples.length - 1]
      const dt = b.t - a.t
      if (dt > 0) {
        velX = (b.x - a.x) / dt
        velY = (b.y - a.y) / dt
        if (Math.hypot(velX, velY) > FLING_VELOCITY_THRESHOLD) startGlide()
        else {
          velX = 0
          velY = 0
        }
      }
    }
    syncCursor()
  }

  const onPointerUp = (event: PointerEvent) => endDrag(event, true)

  const onPointerCancel = (event: PointerEvent) => endDrag(event, false)

  onMount(() => {
    const viewport = props.viewport()
    if (!viewport) return
    viewport.addEventListener("wheel", onWheel, { passive: false })
    viewport.addEventListener("pointerdown", onPointerDown)
    viewport.addEventListener("pointermove", onPointerMove)
    viewport.addEventListener("pointerup", onPointerUp)
    viewport.addEventListener("pointercancel", onPointerCancel)
    onCleanup(() => {
      viewport.removeEventListener("wheel", onWheel)
      viewport.removeEventListener("pointerdown", onPointerDown)
      viewport.removeEventListener("pointermove", onPointerMove)
      viewport.removeEventListener("pointerup", onPointerUp)
      viewport.removeEventListener("pointercancel", onPointerCancel)
      if (raf) cancelAnimationFrame(raf)
      if (panRaf) cancelAnimationFrame(panRaf)
    })
  })

  return { percent, zoomBy, reset, onWheel, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}

function ZoomInIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3V13M3 8H13" stroke="currentColor" stroke-linejoin="round" />
    </svg>
  )
}

function ZoomOutIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8H13" stroke="currentColor" stroke-linejoin="round" />
    </svg>
  )
}

function ZoomResetIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5.83333 4.16406L2.5 7.4974L5.83333 10.8307M3.33333 7.4974H17.9167V15.4141H10"
        stroke="currentColor"
        stroke-linecap="square"
      />
    </svg>
  )
}

export function MediaZoomToolbar(props: { zoom: MediaZoom }): JSX.Element {
  const language = useLanguage()
  return (
    <div data-slot="project-explorer-media-zoom-toolbar">
      <TooltipV2 value={language.t("projectExplorer.editor.zoomIn")}>
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="small"
          aria-label={language.t("projectExplorer.editor.zoomIn")}
          onClick={() => props.zoom.zoomBy(1.25)}
          icon={<ZoomInIcon />}
        />
      </TooltipV2>
      <TooltipV2 value={language.t("projectExplorer.editor.zoomOut")}>
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="small"
          aria-label={language.t("projectExplorer.editor.zoomOut")}
          onClick={() => props.zoom.zoomBy(0.8)}
          icon={<ZoomOutIcon />}
        />
      </TooltipV2>
      <TooltipV2 value={language.t("projectExplorer.editor.zoomReset")}>
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="small"
          aria-label={language.t("projectExplorer.editor.zoomReset")}
          onClick={() => props.zoom.reset()}
          icon={<ZoomResetIcon />}
        />
      </TooltipV2>
      <span data-slot="project-explorer-media-zoom-percent">
        {language.t("projectExplorer.editor.zoomPercent", { percent: props.zoom.percent() })}
      </span>
    </div>
  )
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const SVG_DEFAULT_VIEWBOX = "0 0 300 150"
const DANGEROUS_URL = /^(javascript|vbscript):/i

function numericAttr(element: Element, name: string): number | undefined {
  const value = element.getAttribute(name)
  if (value === null || !/^[\d.]+(?:px)?$/.test(value)) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function fallbackPre(content: string): HTMLPreElement {
  const pre = document.createElement("pre")
  pre.textContent = content
  return pre
}

const fillContainer = (element: SVGElement) => {
  const style = element.getAttribute("style")
  element.setAttribute("style", style ? `${style};width:100%;height:100%` : "width:100%;height:100%")
}

/** Removes script-execution vectors from an SVG element tree: <script> and
 * <foreignObject> elements, on* event handlers, and javascript:/vbscript:
 * URLs. data: URLs are only stripped on <a> (navigation vector); image and
 * resource data URLs plus embedded <style> are kept — both are inert. */
function sanitizeSvgTree(root: Element): void {
  const strip = (element: Element) => {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name
      if (name.startsWith("on")) {
        element.removeAttribute(name)
        continue
      }
      if (name === "href" || name === "xlink:href" || name === "src") {
        const value = attr.value.trim()
        if (DANGEROUS_URL.test(value) || (element.tagName === "a" && /^data:/i.test(value)))
          element.removeAttribute(name)
      }
    }
  }
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (element.tagName === "script" || element.tagName === "foreignObject") {
      element.remove()
      continue
    }
    strip(element)
  }
  strip(root)
}

/** Builds a live <svg> element from untrusted SVG source. The source is parsed
 * as strict XML (so malformed input can't smuggle markup), script-execution
 * vectors are stripped, and the root is normalized (viewBox guaranteed, fills
 * its container) so the vector rendering stays crisp at any zoom. Unusable
 * input falls back to an escaped <pre>. */
export function projectExplorerSvgElement(content: string): Element {
  const doc = new DOMParser().parseFromString(content, "image/svg+xml")
  const root = doc.documentElement
  if (!root || root.tagName === "parsererror" || (root.tagName !== "svg" && root.namespaceURI !== SVG_NAMESPACE))
    return fallbackPre(content)
  if (root.tagName !== "svg") {
    const wrapper = document.createElementNS(SVG_NAMESPACE, "svg")
    wrapper.setAttribute("viewBox", SVG_DEFAULT_VIEWBOX)
    fillContainer(wrapper)
    wrapper.appendChild(root)
    sanitizeSvgTree(wrapper)
    return wrapper
  }
  const svg = root as unknown as SVGSVGElement
  if (!svg.getAttribute("viewBox")) {
    const w = numericAttr(svg, "width")
    const h = numericAttr(svg, "height")
    if (w !== undefined && h !== undefined) svg.setAttribute("viewBox", `0 0 ${w} ${h}`)
    else if (w === undefined && h === undefined) svg.setAttribute("viewBox", SVG_DEFAULT_VIEWBOX)
  }
  fillContainer(svg)
  sanitizeSvgTree(svg)
  return svg
}

/** SVG render view: the sanitized source becomes a real inline <svg> element so
 * the vector content re-renders crisply at every zoom level (an <img> data URL
 * rasterizes and goes pixelated when scaled). */
export function ProjectExplorerSvgViewer(props: { path: string; content: string }): JSX.Element {
  let viewport: HTMLDivElement | undefined
  let stage: HTMLDivElement | undefined
  let svgHost: HTMLDivElement | undefined
  const zoom = createMediaZoom({ viewport: () => viewport, stage: () => stage })

  createEffect(() => {
    props.content
    zoom.reset()
  })

  createEffect(() => {
    if (!svgHost) return
    svgHost.replaceChildren(projectExplorerSvgElement(props.content))
  })

  return (
    <div
      ref={(element) => {
        viewport = element
      }}
      data-component="project-explorer-svg-viewer"
      data-path={props.path}
    >
      <div
        ref={(element) => {
          stage = element
        }}
        data-slot="project-explorer-media-stage"
      >
        <div
          ref={(element) => {
            svgHost = element
          }}
          data-slot="project-explorer-svg-host"
        />
      </div>
      <MediaZoomToolbar zoom={zoom} />
    </div>
  )
}

const svgTagNames = [
  "svg", "g", "defs", "symbol", "use", "marker", "clipPath", "mask", "pattern",
  "linearGradient", "radialGradient", "stop", "filter", "switch", "a", "title",
  "desc", "metadata", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "path", "text", "tspan", "textPath", "glyph", "font", "font-face",
  "missing-glyph", "image", "foreignObject", "animate", "animateMotion",
  "animateTransform", "set", "mpath", "feBlend", "feColorMatrix",
  "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
  "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA",
  "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge",
  "feMergeNode", "feMorphology", "feOffset", "fePointLight",
  "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "view",
  "cursor", "script", "style",
]

const svgAttributeNames = [
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width",
  "height", "d", "points", "pathLength", "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "opacity",
  "visibility", "display", "transform", "transform-origin", "vector-effect",
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "text-anchor", "dominant-baseline", "alignment-baseline", "baseline-shift",
  "letter-spacing", "word-spacing", "direction", "text-decoration",
  "text-rendering", "textLength", "lengthAdjust", "clip-path", "clip-rule",
  "mask", "filter", "color", "color-interpolation", "color-interpolation-filters",
  "color-rendering", "shape-rendering", "image-rendering", "pointer-events",
  "cursor", "mix-blend-mode", "isolation", "paint-order", "marker-start",
  "marker-mid", "marker-end", "markerWidth", "markerHeight", "markerUnits",
  "orient", "refX", "refY", "gradientUnits", "gradientTransform", "spreadMethod",
  "offset", "stop-color", "stop-opacity", "patternUnits", "patternContentUnits",
  "patternTransform", "viewBox", "preserveAspectRatio", "version", "baseProfile",
  "xmlns", "id", "class", "style", "role", "tabindex", "lang", "href",
  "target", "rel", "attributeName", "attributeType", "from", "to", "by",
  "values", "dur", "repeatCount", "repeatDur", "begin", "end", "keyTimes",
  "keySplines", "calcMode", "additive", "accumulate", "restart", "max", "min",
  "type", "path", "keyPoints", "rotate", "zoomAndPan",
]

const svgSchema: { elements: ElementSpec[]; attributes: AttrSpec[] } = {
  attributes: [
    { name: "id", global: true },
    { name: "class", global: true },
    { name: "style", global: true },
    { name: "transform", global: true },
    { name: "fill", global: true, values: ["none", "currentColor", "inherit", "url(#)"] },
    { name: "fill-opacity", global: true, values: ["0", "0.5", "1"] },
    { name: "fill-rule", global: true, values: ["nonzero", "evenodd"] },
    { name: "stroke", global: true, values: ["none", "currentColor", "inherit", "url(#)"] },
    { name: "stroke-width", global: true },
    { name: "stroke-opacity", global: true, values: ["0", "0.5", "1"] },
    { name: "stroke-linecap", global: true, values: ["butt", "round", "square"] },
    { name: "stroke-linejoin", global: true, values: ["miter", "round", "bevel"] },
    { name: "stroke-dasharray", global: true },
    { name: "stroke-dashoffset", global: true },
    { name: "stroke-miterlimit", global: true },
    { name: "opacity", global: true, values: ["0", "0.5", "1"] },
    { name: "visibility", global: true, values: ["visible", "hidden", "collapse"] },
    { name: "display", global: true, values: ["inline", "block", "none"] },
    { name: "clip-path", global: true, values: ["none", "url(#)"] },
    { name: "clip-rule", global: true, values: ["nonzero", "evenodd"] },
    { name: "mask", global: true, values: ["none", "url(#)"] },
    { name: "filter", global: true, values: ["none", "url(#)"] },
    { name: "color", global: true },
    { name: "pointer-events", global: true, values: ["visiblePainted", "none", "all"] },
    { name: "cursor", global: true },
    { name: "font-family", global: true },
    { name: "font-size", global: true },
    { name: "font-weight", global: true, values: ["normal", "bold", "bolder", "lighter", "100", "200", "400", "700"] },
    { name: "font-style", global: true, values: ["normal", "italic", "oblique"] },
    { name: "text-anchor", global: true, values: ["start", "middle", "end"] },
    { name: "dominant-baseline", global: true },
    { name: "letter-spacing", global: true },
    { name: "word-spacing", global: true },
    { name: "direction", global: true, values: ["ltr", "rtl"] },
    { name: "text-decoration", global: true },
    { name: "text-rendering", global: true, values: ["auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"] },
    { name: "shape-rendering", global: true, values: ["auto", "optimizeSpeed", "crispEdges", "geometricPrecision"] },
    { name: "image-rendering", global: true },
    { name: "mix-blend-mode", global: true },
    { name: "paint-order", global: true },
  ],
  elements: [
    { name: "svg", top: true, attributes: ["viewBox", "preserveAspectRatio", "width", "height", "version", "xmlns", "x", "y"] },
    { name: "g", attributes: ["transform"] },
    { name: "defs" },
    { name: "symbol", attributes: ["viewBox", "preserveAspectRatio"] },
    { name: "use", attributes: ["href", "x", "y", "width", "height"] },
    { name: "marker", attributes: ["viewBox", "markerWidth", "markerHeight", "refX", "refY", "orient", "markerUnits"] },
    { name: "clipPath", attributes: ["clipPathUnits"] },
    { name: "mask", attributes: ["maskUnits", "maskContentUnits", "x", "y", "width", "height"] },
    { name: "pattern", attributes: ["patternUnits", "patternContentUnits", "patternTransform", "viewBox", "x", "y", "width", "height"] },
    { name: "linearGradient", attributes: ["gradientUnits", "gradientTransform", "spreadMethod", "x1", "y1", "x2", "y2"], children: ["stop"] },
    { name: "radialGradient", attributes: ["gradientUnits", "gradientTransform", "spreadMethod", "cx", "cy", "r", "fx", "fy", "fr"], children: ["stop"] },
    { name: "stop", attributes: ["offset", "stop-color", "stop-opacity"] },
    { name: "filter", attributes: ["x", "y", "width", "height", "filterUnits", "filterRes", "primitiveUnits"] },
    { name: "rect", attributes: ["x", "y", "width", "height", "rx", "ry"] },
    { name: "circle", attributes: ["cx", "cy", "r"] },
    { name: "ellipse", attributes: ["cx", "cy", "rx", "ry"] },
    { name: "line", attributes: ["x1", "y1", "x2", "y2"] },
    { name: "polyline", attributes: ["points"] },
    { name: "polygon", attributes: ["points"] },
    { name: "path", attributes: ["d", "pathLength"] },
    { name: "text", attributes: ["x", "y", "dx", "dy", "rotate", "textLength", "lengthAdjust"], children: ["tspan", "textPath"] },
    { name: "tspan", attributes: ["x", "y", "dx", "dy", "rotate", "textLength", "lengthAdjust"] },
    { name: "textPath", attributes: ["href", "startOffset", "method", "spacing"] },
    { name: "image", attributes: ["href", "x", "y", "width", "height", "preserveAspectRatio"] },
    { name: "foreignObject", attributes: ["x", "y", "width", "height"] },
    { name: "animate", attributes: ["attributeName", "from", "to", "dur", "repeatCount", "begin", "end", "calcMode", "keyTimes", "keySplines", "additive", "accumulate"] },
    { name: "animateMotion", attributes: ["path", "keyPoints", "rotate", "calcMode"] },
    { name: "animateTransform", attributes: ["attributeName", "type", "from", "to", "dur", "repeatCount"], },
    { name: "set", attributes: ["attributeName", "to"] },
    { name: "mpath", attributes: ["href"] },
    { name: "switch", children: ["g", "rect", "path", "text", "image", "foreignObject"] },
    { name: "a", attributes: ["href", "target", "rel"] },
    { name: "view", attributes: ["viewBox", "preserveAspectRatio", "zoomAndPan"] },
    { name: "cursor", attributes: ["x", "y", "href"] },
    { name: "style", textContent: ["svg { }"] },
    { name: "script", textContent: ["const s = document.createElementNS('http://www.w3.org/2000/svg', 'g')"] },
    { name: "title" },
    { name: "desc" },
    { name: "metadata" },
  ],
}

/** CodeMirror language for SVG source: the XML grammar plus SVG-spec element
 * and attribute emphasis. Lazy — @codemirror/lang-xml loads on first use so
 * the viewer chunk stays small. */
export async function projectExplorerSvgLanguage(): Promise<LanguageSupport> {
  const { xml } = await import("@codemirror/lang-xml")
  const lang = await import("@codemirror/language")
  const { tags } = await import("@lezer/highlight")
  const cmView = await import("@codemirror/view")
  const cmState = await import("@codemirror/state")

  const svgTagSet = new Set(svgTagNames)
  const svgAttrSet = new Set(svgAttributeNames)
  const svgTagMark = cmView.Decoration.mark({ class: "cm-svg-tag--svg" })
  const svgAttrMark = cmView.Decoration.mark({ class: "cm-svg-attr--svg" })

  const buildEmphasis = (view: EditorView): DecorationSet => {
    const builder = new cmState.RangeSetBuilder<Decoration>()
    for (const { from, to } of view.visibleRanges) {
      lang.syntaxTree(view.state).iterate({
        from,
        to,
        enter: (node) => {
          if (node.name === "TagName") {
            if (svgTagSet.has(view.state.doc.sliceString(node.from, node.to)))
              builder.add(node.from, node.to, svgTagMark)
          } else if (node.name === "AttributeName") {
            if (svgAttrSet.has(view.state.doc.sliceString(node.from, node.to)))
              builder.add(node.from, node.to, svgAttrMark)
          }
        },
      })
    }
    return builder.finish()
  }

  const svgEmphasis = cmView.ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildEmphasis(view)
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.geometryChanged)
          this.decorations = buildEmphasis(update.view)
      }
    },
    { decorations: (view) => view.decorations },
  )

  const svgHighlightStyle = lang.HighlightStyle.define([
    { tag: tags.tagName, class: "cm-svg-tag" },
    { tag: tags.attributeName, class: "cm-svg-attr" },
    { tag: tags.attributeValue, class: "cm-svg-attr-value" },
    { tag: tags.angleBracket, class: "cm-svg-bracket" },
    { tag: tags.processingInstruction, class: "cm-svg-meta" },
    { tag: tags.documentMeta, class: "cm-svg-meta" },
    { tag: tags.character, class: "cm-svg-meta" },
    { tag: tags.invalid, class: "cm-svg-invalid" },
  ])

  const svgTheme = cmView.EditorView.theme({
    ".cm-svg-tag": { color: "var(--v2-text-text-muted)" },
    ".cm-svg-tag--svg": { color: "var(--v2-syntax-type, #4ec9b0)", fontWeight: 560 },
    ".cm-svg-attr": { color: "var(--v2-text-text-muted)" },
    ".cm-svg-attr--svg": { color: "var(--v2-syntax-property, #9cdcfe)" },
    ".cm-svg-attr-value": { color: "var(--v2-syntax-string, #ce9178)" },
    ".cm-svg-bracket": { color: "var(--v2-text-text-faint)" },
    ".cm-svg-meta": { color: "var(--v2-text-text-faint)" },
    ".cm-svg-invalid": { color: "var(--v2-state-fg-danger)" },
  })

  const base = xml({ elements: svgSchema.elements, attributes: svgSchema.attributes })
  return new lang.LanguageSupport(base.language, [
    base.support,
    lang.syntaxHighlighting(svgHighlightStyle),
    svgEmphasis,
    svgTheme,
  ])
}
