import { checksum } from "@opencode-ai/core/util/encode"
import DOMPurify from "dompurify"

type MermaidAPI = (typeof import("mermaid"))["default"]

export type MermaidLabels = {
  copy: string
  copied: string
}

type ThemeSnapshot = {
  key: string
  dark: boolean
  fontFamily: string
  background: string
  surface: string
  surfaceMuted: string
  text: string
  textMuted: string
  border: string
  accent: string
}

type CacheEntry = {
  source: string
  theme: string
  svg: string
  diagramType: string
  bytes: number
}

type MermaidState = {
  host: HTMLElement
  canvas: HTMLElement
  viewport: HTMLElement
  stage: HTMLElement
  verticalThumb: HTMLElement
  horizontalThumb: HTMLElement
  type: HTMLElement
  sourcePanel: HTMLElement
  sourceCode: HTMLElement
  labels: MermaidLabels
  source: string
  sourceHash: string
  visible: boolean
  disposed: boolean
  generation: number
  renderedKey?: string
  scale: number
  targetScale: number
  zoomVelocity: number
  zoomFrame?: number
  zoomLastTime?: number
  zoomAnchor?: ZoomAnchor
  naturalWidth: number
  naturalHeight: number
  scrollbarHovered: boolean
  scrollbarScrolling: boolean
  scrollbarDragging: boolean
  scrollbarTimer?: ReturnType<typeof setTimeout>
  resizeObserver?: ResizeObserver
  copyTimer?: ReturnType<typeof setTimeout>
  abort: AbortController
}

type ZoomAnchor = {
  clientX: number
  clientY: number
  rx: number
  ry: number
}

const MERMAID_MAX_TEXT_SIZE = 50_000
const MERMAID_MAX_EDGES = 500
const MERMAID_CACHE_MAX = 64
const MERMAID_CACHE_BYTES = 8 * 1024 * 1024
const MERMAID_MIN_SCALE = 0.5
const MERMAID_MAX_SCALE = 3
const MERMAID_SCALE_STEP = 0.2
const MERMAID_STAGE_PADDING = 40
const MERMAID_ZOOM_SMOOTH_TIME = 0.11
const MERMAID_PNG_MIN_DENSITY = 2
const MERMAID_PNG_MAX_DENSITY = 3
const MERMAID_PNG_MAX_DIMENSION = 8192
const MERMAID_PNG_MAX_PIXELS = 24_000_000

const states = new WeakMap<HTMLElement, MermaidState>()
const active = new Set<HTMLElement>()
const cache = new Map<string, CacheEntry>()
let cacheBytes = 0
let mermaidPromise: Promise<MermaidAPI> | undefined
let renderTail: Promise<void> = Promise.resolve()
let diagramID = 0
let mountedSvgID = 0
let intersectionObserver: IntersectionObserver | undefined
let themeObserver: MutationObserver | undefined

const icon = {
  source:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4M9 2.5 7 13.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy:
    '<svg data-copy-icon viewBox="0 0 16 16" aria-hidden="true"><path d="M4.15 11.01H1.76V1.52H9.1v1.04M14.22 5H6.75v9.49h7.47V5Z" fill="none" stroke="currentColor"/></svg><svg data-check-icon viewBox="0 0 16 16" aria-hidden="true"><path d="m3.54 8.18 2.85 3.57 6.08-7.5" fill="none" stroke="currentColor"/></svg>',
  download:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.25v7.5M5.25 7 8 9.75 10.75 7M2.5 11v2.25h11V11" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  minus:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" fill="none" stroke="currentColor" stroke-linecap="round"/></svg>',
  plus:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M8 3v10" fill="none" stroke="currentColor" stroke-linecap="round"/></svg>',
  reset:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.1 5.1A5 5 0 1 1 3 9M4.1 5.1V2.7M4.1 5.1H1.7" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  expand:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}

export function isMermaidLanguage(language: string | undefined) {
  const value = language?.trim().split(/\s+/, 1)[0]?.toLowerCase()
  return value === "mermaid" || value === "mmd"
}

/**
 * Converts a completed Mermaid fence into an interactive diagram shell.
 * The Mermaid bundle and graph layout stay completely off the streaming path:
 * callers mount only completed fences, and rendering starts near the viewport.
 */
export function mountMermaidBlock(container: HTMLElement, source: string, labels: MermaidLabels) {
  let host = Array.from(container.children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.dataset.component === "markdown-mermaid",
  )
  if (!host) {
    disposeMermaidBlocks(container)
    host = createHost()
    container.replaceChildren(host)
  }
  mount(host, source, labels)
  return host
}

/** Upgrade Mermaid pre/code emitted by the completed markdown parser. */
export function hydrateMermaidBlocks(root: Element, labels: MermaidLabels) {
  const blocks = Array.from(root.querySelectorAll("pre")).filter((block): block is HTMLPreElement => {
    if (!(block instanceof HTMLPreElement)) return false
    const code = block.querySelector(":scope > code")
    if (!(code instanceof HTMLElement)) return false
    return isMermaidLanguage(code.className.match(/(?:^|\s)language-([^\s]+)/)?.[1])
  })

  for (const block of blocks) {
    const code = block.querySelector(":scope > code")
    if (!(code instanceof HTMLElement)) continue
    const source = code.textContent ?? ""
    const wrapper = block.parentElement
    const existing = wrapper?.dataset.component === "markdown-code" ? wrapper : block
    const host = createHost()
    existing.replaceWith(host)
    mount(host, source, labels)
  }
}

export function disposeMermaidBlocks(root: Element) {
  const hosts = [
    ...(root instanceof HTMLElement && root.dataset.component === "markdown-mermaid" ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-component="markdown-mermaid"]')).filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    ),
  ]
  for (const host of hosts) dispose(host)
}

function createHost() {
  const host = document.createElement("div")
  host.dataset.component = "markdown-mermaid"
  host.dataset.state = "waiting"
  host.dir = "ltr"

  const header = document.createElement("div")
  header.dataset.slot = "mermaid-header"

  const identity = document.createElement("div")
  identity.dataset.slot = "mermaid-identity"
  const label = document.createElement("span")
  label.dataset.slot = "mermaid-label"
  label.textContent = "Mermaid"
  const type = document.createElement("span")
  type.dataset.slot = "mermaid-type"
  type.textContent = "Diagram"
  identity.append(label, type)

  const actions = document.createElement("div")
  actions.dataset.slot = "mermaid-actions"
  actions.append(
    actionButton("source", "Toggle Mermaid source", icon.source),
    actionButton("copy", "Copy Mermaid source", icon.copy),
    actionButton("save-png", "Save diagram as PNG", icon.download),
    actionButton("zoom-out", "Zoom out", icon.minus),
    actionButton("zoom-in", "Zoom in", icon.plus),
    actionButton("reset", "Reset view", icon.reset),
    actionButton("expand", "Expand diagram", icon.expand),
  )
  header.append(identity, actions)

  const viewport = document.createElement("div")
  viewport.dataset.slot = "mermaid-viewport"
  viewport.tabIndex = 0
  viewport.setAttribute("aria-label", "Mermaid diagram viewport")
  const stage = document.createElement("div")
  stage.dataset.slot = "mermaid-stage"
  viewport.append(stage)

  const canvas = document.createElement("div")
  canvas.dataset.slot = "mermaid-canvas"
  const verticalThumb = document.createElement("div")
  verticalThumb.className = "scroll-view__thumb"
  verticalThumb.dataset.slot = "mermaid-scrollbar"
  verticalThumb.dataset.orientation = "vertical"
  verticalThumb.dataset.visible = "false"
  const horizontalThumb = document.createElement("div")
  horizontalThumb.className = "scroll-view__thumb"
  horizontalThumb.dataset.slot = "mermaid-scrollbar"
  horizontalThumb.dataset.orientation = "horizontal"
  horizontalThumb.dataset.visible = "false"
  canvas.append(viewport, verticalThumb, horizontalThumb)

  const sourcePanel = document.createElement("div")
  sourcePanel.dataset.slot = "mermaid-source"
  sourcePanel.hidden = true
  const pre = document.createElement("pre")
  const sourceCode = document.createElement("code")
  pre.append(sourceCode)
  sourcePanel.append(pre)

  host.append(header, canvas, sourcePanel)
  return host
}

function actionButton(action: string, label: string, svg: string) {
  const button = document.createElement("button")
  button.type = "button"
  button.dataset.action = action
  if (action === "save-png") button.disabled = true
  button.setAttribute("aria-label", label)
  button.title = label
  button.innerHTML = svg
  return button
}

function mount(host: HTMLElement, source: string, labels: MermaidLabels) {
  const existing = states.get(host)
  if (existing) {
    existing.labels = labels
    if (existing.source === source) {
      queueRender(existing)
      return
    }
    existing.source = source
    existing.sourceHash = checksum(source) ?? String(source.length)
    existing.sourceCode.textContent = source
    existing.renderedKey = undefined
    existing.generation++
    resetView(existing)
    queueRender(existing, true)
    return
  }

  const canvas = host.querySelector<HTMLElement>('[data-slot="mermaid-canvas"]')
  const viewport = host.querySelector<HTMLElement>('[data-slot="mermaid-viewport"]')
  const stage = host.querySelector<HTMLElement>('[data-slot="mermaid-stage"]')
  const verticalThumb = host.querySelector<HTMLElement>('[data-slot="mermaid-scrollbar"][data-orientation="vertical"]')
  const horizontalThumb = host.querySelector<HTMLElement>('[data-slot="mermaid-scrollbar"][data-orientation="horizontal"]')
  const type = host.querySelector<HTMLElement>('[data-slot="mermaid-type"]')
  const sourcePanel = host.querySelector<HTMLElement>('[data-slot="mermaid-source"]')
  const sourceCode = sourcePanel?.querySelector<HTMLElement>("code")
  if (!canvas || !viewport || !stage || !verticalThumb || !horizontalThumb || !type || !sourcePanel || !sourceCode) return

  const state: MermaidState = {
    host,
    canvas,
    viewport,
    stage,
    verticalThumb,
    horizontalThumb,
    type,
    sourcePanel,
    sourceCode,
    labels,
    source,
    sourceHash: checksum(source) ?? String(source.length),
    visible: false,
    disposed: false,
    generation: 0,
    scale: 1,
    targetScale: 1,
    zoomVelocity: 0,
    naturalWidth: 0,
    naturalHeight: 0,
    scrollbarHovered: false,
    scrollbarScrolling: false,
    scrollbarDragging: false,
    abort: new AbortController(),
  }
  states.set(host, state)
  active.add(host)
  sourceCode.textContent = source
  setupInteractions(state)
  observe(state)
}

function dispose(host: HTMLElement) {
  const state = states.get(host)
  if (!state) return
  state.disposed = true
  state.generation++
  state.abort.abort()
  if (state.zoomFrame !== undefined) cancelAnimationFrame(state.zoomFrame)
  state.resizeObserver?.disconnect()
  if (state.scrollbarTimer) clearTimeout(state.scrollbarTimer)
  if (state.copyTimer) clearTimeout(state.copyTimer)
  intersectionObserver?.unobserve(host)
  active.delete(host)
  states.delete(host)
}

function setupInteractions(state: MermaidState) {
  const signal = state.abort.signal
  state.host.addEventListener(
    "click",
    (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest<HTMLButtonElement>("button[data-action]")
      if (!button || !state.host.contains(button)) return
      const action = button.dataset.action
      if (action === "source") {
        state.sourcePanel.hidden = !state.sourcePanel.hidden
        if (state.sourcePanel.hidden) delete button.dataset.active
        else button.dataset.active = "true"
        return
      }
      if (action === "copy") {
        void copySource(state, button)
        return
      }
      if (action === "save-png") {
        void savePng(state, button)
        return
      }
      if (action === "zoom-in") return zoom(state, state.targetScale + MERMAID_SCALE_STEP)
      if (action === "zoom-out") return zoom(state, state.targetScale - MERMAID_SCALE_STEP)
      if (action === "reset") return resetView(state)
      if (action === "expand") return setExpanded(state, state.host.dataset.expanded !== "true")
      if (action === "retry") queueRender(state, true)
    },
    { signal },
  )

  state.viewport.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const pixels = wheelPixels(event, state.viewport.clientHeight)
      const bounded = Math.max(-180, Math.min(180, pixels))
      const factor = Math.exp(-bounded * 0.0018)
      zoom(state, state.targetScale * factor, zoomAnchorAt(state, event.clientX, event.clientY))
    },
    { passive: false, signal },
  )

  state.viewport.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault()
        return zoom(state, state.targetScale + MERMAID_SCALE_STEP)
      }
      if (event.key === "-") {
        event.preventDefault()
        return zoom(state, state.targetScale - MERMAID_SCALE_STEP)
      }
      if (event.key === "0") {
        event.preventDefault()
        return resetView(state)
      }
      if (state.viewport.scrollWidth <= state.viewport.clientWidth && state.viewport.scrollHeight <= state.viewport.clientHeight) return
      const amount = event.shiftKey ? 48 : 20
      let left = 0
      let top = 0
      if (event.key === "ArrowLeft") left = -amount
      else if (event.key === "ArrowRight") left = amount
      else if (event.key === "ArrowUp") top = -amount
      else if (event.key === "ArrowDown") top = amount
      else return
      event.preventDefault()
      state.viewport.scrollBy({ left, top, behavior: "smooth" })
    },
    { signal },
  )

  state.viewport.addEventListener("dblclick", () => resetView(state), { signal })

  let pointer: { id: number; x: number; y: number; left: number; top: number } | undefined
  state.viewport.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return
      if (state.viewport.scrollWidth <= state.viewport.clientWidth && state.viewport.scrollHeight <= state.viewport.clientHeight) return
      event.preventDefault()
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: state.viewport.scrollLeft,
        top: state.viewport.scrollTop,
      }
      state.viewport.setPointerCapture(event.pointerId)
      state.viewport.dataset.panning = "true"
    },
    { signal },
  )
  state.viewport.addEventListener(
    "pointermove",
    (event) => {
      if (!pointer || pointer.id !== event.pointerId) return
      state.viewport.scrollLeft = pointer.left - (event.clientX - pointer.x)
      state.viewport.scrollTop = pointer.top - (event.clientY - pointer.y)
    },
    { signal },
  )
  const stopPan = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) return
    pointer = undefined
    delete state.viewport.dataset.panning
  }
  state.viewport.addEventListener("pointerup", stopPan, { signal })
  state.viewport.addEventListener("pointercancel", stopPan, { signal })

  setupScrollbars(state)

  state.host.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && state.host.dataset.expanded === "true") {
        event.preventDefault()
        setExpanded(state, false)
      }
    },
    { signal },
  )
}

async function copySource(state: MermaidState, button: HTMLButtonElement) {
  if (!navigator.clipboard) return
  try {
    await navigator.clipboard.writeText(state.source)
    button.dataset.copied = "true"
    button.setAttribute("aria-label", state.labels.copied)
    button.title = state.labels.copied
    if (state.copyTimer) clearTimeout(state.copyTimer)
    state.copyTimer = setTimeout(() => {
      delete button.dataset.copied
      button.setAttribute("aria-label", state.labels.copy)
      button.title = state.labels.copy
    }, 2000)
  } catch {
    // Clipboard permission failures should not destabilize diagram rendering.
  }
}

async function savePng(state: MermaidState, button: HTMLButtonElement) {
  if (button.disabled || state.host.dataset.state !== "ready") return
  const svg = state.stage.querySelector<SVGSVGElement>("svg")
  const natural = svg ? viewBoxDimensions(svg.getAttribute("viewBox")) : undefined
  if (!svg || !natural) return

  const idleLabel = "Save diagram as PNG"
  button.disabled = true
  button.dataset.busy = "true"
  button.setAttribute("aria-label", "Saving diagram as PNG")
  button.title = "Saving diagram as PNG"

  try {
    await document.fonts?.ready
    const density = typeof devicePixelRatio === "number" && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1
    const output = pngExportDimensions(natural.width, natural.height, density)
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
    clone.setAttribute("width", String(natural.width))
    clone.setAttribute("height", String(natural.height))
    clone.style.removeProperty("width")
    clone.style.removeProperty("height")
    clone.style.removeProperty("max-width")
    clone.style.removeProperty("max-height")

    const serialized = new XMLSerializer().serializeToString(clone)
    const svgBlob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" })
    const url = URL.createObjectURL(svgBlob)
    try {
      const image = await loadImage(url)
      const canvas = document.createElement("canvas")
      canvas.width = output.width
      canvas.height = output.height
      const context = canvas.getContext("2d", { alpha: false })
      if (!context) throw new Error("Canvas rendering is unavailable")
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = "high"
      context.fillStyle = themeSnapshot().background
      context.fillRect(0, 0, output.width, output.height)
      context.drawImage(image, 0, 0, output.width, output.height)
      const png = await canvasBlob(canvas, "image/png")
      downloadBlob(png, pngFilename(state))
    } finally {
      URL.revokeObjectURL(url)
    }

    button.dataset.saved = "true"
    button.setAttribute("aria-label", "PNG saved")
    button.title = "PNG saved"
    window.setTimeout(() => {
      if (!button.isConnected) return
      delete button.dataset.saved
      button.setAttribute("aria-label", idleLabel)
      button.title = idleLabel
    }, 1800)
  } catch (error) {
    button.dataset.error = "true"
    button.setAttribute("aria-label", "Unable to save PNG")
    button.title = friendlyError(error)
    window.setTimeout(() => {
      if (!button.isConnected) return
      delete button.dataset.error
      button.setAttribute("aria-label", idleLabel)
      button.title = idleLabel
    }, 2200)
  } finally {
    button.disabled = false
    delete button.dataset.busy
  }
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.decoding = "async"
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("The Mermaid SVG could not be rasterized"))
    image.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement, type: string) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("The PNG encoder returned no data"))
    }, type)
  })
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.style.display = "none"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Keep the object URL alive through the browser's download dispatch turn.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function pngFilename(state: MermaidState) {
  const type = (state.type.textContent || "diagram")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return `mermaid-${type || "diagram"}.png`
}

export function pngExportDimensions(width: number, height: number, deviceDensity = 1) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 1, height: 1, scale: 1 }
  const preferred = Math.min(MERMAID_PNG_MAX_DENSITY, Math.max(MERMAID_PNG_MIN_DENSITY, deviceDensity || 1))
  const dimensionScale = Math.min(MERMAID_PNG_MAX_DIMENSION / width, MERMAID_PNG_MAX_DIMENSION / height)
  const pixelScale = Math.sqrt(MERMAID_PNG_MAX_PIXELS / (width * height))
  const scale = Math.max(0.01, Math.min(preferred, dimensionScale, pixelScale))
  return {
    // Floor after applying the hard caps. Rounding each axis independently can
    // push the final canvas a few pixels over the max-area budget.
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  }
}

function zoom(state: MermaidState, next: number, anchor = zoomAnchorAtCenter(state), smooth = true) {
  state.targetScale = Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, next))
  state.zoomAnchor = anchor
  updateZoomButtons(state)

  if (!smooth || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    cancelZoomAnimation(state)
    state.scale = state.targetScale
    state.zoomVelocity = 0
    applyZoomGeometry(state, anchor)
    return
  }

  if (state.zoomFrame !== undefined) return
  state.zoomLastTime = performance.now()
  state.zoomFrame = requestAnimationFrame((time) => animateZoom(state, time))
}

function resetView(state: MermaidState, smooth = true) {
  zoom(state, 1, zoomAnchorAtCenter(state), smooth)
}

function animateZoom(state: MermaidState, time: number) {
  state.zoomFrame = undefined
  if (state.disposed) return
  const last = state.zoomLastTime ?? time
  const dt = Math.max(1 / 240, Math.min(1 / 30, (time - last) / 1000))
  state.zoomLastTime = time

  const stepped = smoothDamp(state.scale, state.targetScale, state.zoomVelocity, MERMAID_ZOOM_SMOOTH_TIME, dt)
  state.scale = stepped.value
  state.zoomVelocity = stepped.velocity
  const done = Math.abs(state.targetScale - state.scale) < 0.0005 && Math.abs(state.zoomVelocity) < 0.005
  if (done) {
    state.scale = state.targetScale
    state.zoomVelocity = 0
  }
  applyZoomGeometry(state, state.zoomAnchor)
  if (!done) state.zoomFrame = requestAnimationFrame((nextTime) => animateZoom(state, nextTime))
}

function smoothDamp(current: number, target: number, velocity: number, smoothTime: number, dt: number) {
  const omega = 2 / Math.max(0.0001, smoothTime)
  const x = omega * dt
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = current - target
  const temp = (velocity + omega * change) * dt
  let nextVelocity = (velocity - omega * temp) * decay
  let value = target + (change + temp) * decay
  if ((target - current > 0) === (value > target)) {
    value = target
    nextVelocity = 0
  }
  return { value, velocity: nextVelocity }
}

function cancelZoomAnimation(state: MermaidState) {
  if (state.zoomFrame !== undefined) cancelAnimationFrame(state.zoomFrame)
  state.zoomFrame = undefined
  state.zoomLastTime = undefined
}

function applyZoomGeometry(state: MermaidState, anchor?: ZoomAnchor) {
  const svg = state.stage.querySelector<SVGSVGElement>("svg")
  if (!svg || !state.naturalWidth || !state.naturalHeight) return
  const viewportWidth = Math.max(1, state.viewport.clientWidth)
  const availableWidth = Math.max(1, viewportWidth - MERMAID_STAGE_PADDING)
  const baseWidth = Math.min(state.naturalWidth, availableWidth)
  const baseHeight = baseWidth * (state.naturalHeight / state.naturalWidth)
  const width = baseWidth * state.scale
  const height = baseHeight * state.scale
  const stageWidth = Math.max(viewportWidth, width + MERMAID_STAGE_PADDING)
  const stageHeight = Math.max(state.host.dataset.expanded === "true" ? state.viewport.clientHeight : 0, height + MERMAID_STAGE_PADDING)

  svg.style.setProperty("width", `${width}px`, "important")
  svg.style.setProperty("height", `${height}px`, "important")
  svg.style.setProperty("max-width", "none", "important")
  svg.style.setProperty("max-height", "none", "important")
  state.stage.style.width = `${stageWidth}px`
  state.stage.style.height = `${stageHeight}px`

  if (anchor) {
    const rect = svg.getBoundingClientRect()
    const nextX = rect.left + rect.width * anchor.rx
    const nextY = rect.top + rect.height * anchor.ry
    state.viewport.scrollLeft += nextX - anchor.clientX
    state.viewport.scrollTop += nextY - anchor.clientY
  }

  if (state.scale > 1.001) state.host.dataset.zoomed = "true"
  else delete state.host.dataset.zoomed
  updateZoomButtons(state)
  updateScrollbars(state)
}

function zoomAnchorAt(state: MermaidState, clientX: number, clientY: number): ZoomAnchor {
  const svg = state.stage.querySelector<SVGSVGElement>("svg")
  if (!svg) return { clientX, clientY, rx: 0.5, ry: 0.5 }
  const rect = svg.getBoundingClientRect()
  const rx = rect.width ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0.5
  const ry = rect.height ? Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)) : 0.5
  return { clientX, clientY, rx, ry }
}

function zoomAnchorAtCenter(state: MermaidState) {
  const rect = state.viewport.getBoundingClientRect()
  return zoomAnchorAt(state, rect.left + rect.width / 2, rect.top + rect.height / 2)
}

function wheelPixels(event: WheelEvent, pageSize: number) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * pageSize
  return event.deltaY
}

function updateZoomButtons(state: MermaidState) {
  for (const action of ["zoom-in", "zoom-out"] as const) {
    const button = state.host.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)
    if (!button) continue
    button.disabled = action === "zoom-in" ? state.targetScale >= MERMAID_MAX_SCALE : state.targetScale <= MERMAID_MIN_SCALE
  }
}

function setExpanded(state: MermaidState, expanded: boolean) {
  if (expanded) state.host.dataset.expanded = "true"
  else delete state.host.dataset.expanded
  const button = state.host.querySelector<HTMLButtonElement>('button[data-action="expand"]')
  if (button) {
    const label = expanded ? "Collapse diagram" : "Expand diagram"
    button.setAttribute("aria-label", label)
    button.title = label
    if (expanded) button.dataset.active = "true"
    else delete button.dataset.active
  }
  requestAnimationFrame(() => applyZoomGeometry(state, zoomAnchorAtCenter(state)))
  if (!expanded) resetView(state, false)
}

function setupScrollbars(state: MermaidState) {
  const signal = state.abort.signal
  const markScrolling = () => {
    state.scrollbarScrolling = true
    if (state.scrollbarTimer) clearTimeout(state.scrollbarTimer)
    state.scrollbarTimer = setTimeout(() => {
      state.scrollbarScrolling = false
      updateScrollbars(state)
    }, 800)
    updateScrollbars(state)
  }

  state.viewport.addEventListener("scroll", markScrolling, { passive: true, signal })
  state.canvas.addEventListener("pointerenter", () => {
    state.scrollbarHovered = true
    updateScrollbars(state)
  }, { signal })
  state.canvas.addEventListener("pointerleave", () => {
    state.scrollbarHovered = false
    updateScrollbars(state)
  }, { signal })

  setupScrollbarDrag(state, state.verticalThumb, "vertical")
  setupScrollbarDrag(state, state.horizontalThumb, "horizontal")

  if (typeof ResizeObserver !== "undefined") {
    state.resizeObserver = new ResizeObserver(() => {
      applyZoomGeometry(state)
      updateScrollbars(state)
    })
    state.resizeObserver.observe(state.viewport)
  }
  updateScrollbars(state)
}

function setupScrollbarDrag(state: MermaidState, thumb: HTMLElement, orientation: "vertical" | "horizontal") {
  thumb.addEventListener("pointerdown", (event) => {
    event.preventDefault()
    event.stopPropagation()
    state.scrollbarDragging = true
    thumb.dataset.dragging = "true"
    thumb.setPointerCapture(event.pointerId)
    updateScrollbars(state)

    const vertical = orientation === "vertical"
    const startPointer = vertical ? event.clientY : event.clientX
    const startScroll = vertical ? state.viewport.scrollTop : state.viewport.scrollLeft
    const clientSize = vertical ? state.viewport.clientHeight : state.viewport.clientWidth
    const scrollSize = vertical ? state.viewport.scrollHeight : state.viewport.scrollWidth
    const thumbSize = vertical ? thumb.offsetHeight : thumb.offsetWidth
    const trackSize = clientSize - 16
    const travel = Math.max(1, trackSize - thumbSize)
    const maxScroll = Math.max(0, scrollSize - clientSize)

    const move = (next: PointerEvent) => {
      const pointer = vertical ? next.clientY : next.clientX
      const scroll = startScroll + ((pointer - startPointer) / travel) * maxScroll
      if (vertical) state.viewport.scrollTop = scroll
      else state.viewport.scrollLeft = scroll
    }
    const done = (next: PointerEvent) => {
      state.scrollbarDragging = false
      delete thumb.dataset.dragging
      if (thumb.hasPointerCapture(next.pointerId)) thumb.releasePointerCapture(next.pointerId)
      thumb.removeEventListener("pointermove", move)
      thumb.removeEventListener("pointerup", done)
      thumb.removeEventListener("pointercancel", done)
      updateScrollbars(state)
    }
    thumb.addEventListener("pointermove", move)
    thumb.addEventListener("pointerup", done)
    thumb.addEventListener("pointercancel", done)
  }, { signal: state.abort.signal })
}

function updateScrollbars(state: MermaidState) {
  const viewport = state.viewport
  const verticalOverflow = viewport.scrollHeight > viewport.clientHeight + 1
  const horizontalOverflow = viewport.scrollWidth > viewport.clientWidth + 1
  const visible = state.scrollbarHovered || state.scrollbarScrolling || state.scrollbarDragging
  updateScrollbarThumb(state.verticalThumb, {
    clientSize: viewport.clientHeight - (horizontalOverflow ? 12 : 0),
    scrollSize: viewport.scrollHeight,
    scrollOffset: viewport.scrollTop,
    overflow: verticalOverflow,
    visible,
    orientation: "vertical",
  })
  updateScrollbarThumb(state.horizontalThumb, {
    clientSize: viewport.clientWidth - (verticalOverflow ? 12 : 0),
    scrollSize: viewport.scrollWidth,
    scrollOffset: viewport.scrollLeft,
    overflow: horizontalOverflow,
    visible,
    orientation: "horizontal",
  })
}

function updateScrollbarThumb(
  thumb: HTMLElement,
  input: {
    clientSize: number
    scrollSize: number
    scrollOffset: number
    overflow: boolean
    visible: boolean
    orientation: "vertical" | "horizontal"
  },
) {
  if (!input.overflow || input.clientSize <= 0 || input.scrollSize <= 0) {
    thumb.dataset.visible = "false"
    return
  }
  const padding = 8
  const track = Math.max(1, input.clientSize - padding * 2)
  const size = Math.min(track, Math.max(32, (input.clientSize / input.scrollSize) * track))
  const maxScroll = Math.max(1, input.scrollSize - input.clientSize)
  const maxPosition = Math.max(0, track - size)
  const position = padding + (input.scrollOffset / maxScroll) * maxPosition
  thumb.dataset.visible = input.visible ? "true" : "false"
  if (input.orientation === "vertical") {
    thumb.style.height = `${size}px`
    thumb.style.transform = `translateY(${position}px)`
  } else {
    thumb.style.width = `${size}px`
    thumb.style.transform = `translateX(${position}px)`
  }
}

function observe(state: MermaidState) {
  ensureThemeObserver()
  const observer = getIntersectionObserver()
  if (!observer) {
    state.visible = true
    queueRender(state)
    return
  }
  observer.observe(state.host)
}

function getIntersectionObserver() {
  if (typeof IntersectionObserver === "undefined") return
  return (intersectionObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue
        const state = states.get(entry.target)
        if (!state) continue
        state.visible = entry.isIntersecting
        if (state.visible) queueRender(state)
      }
    },
    { rootMargin: "600px 0px" },
  ))
}

function ensureThemeObserver() {
  if (themeObserver || typeof MutationObserver === "undefined") return
  themeObserver = new MutationObserver(() => {
    for (const host of active) {
      const state = states.get(host)
      if (!state || !state.visible || state.disposed) continue
      queueRender(state)
    }
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-color-scheme"],
  })
}

function queueRender(state: MermaidState, force = false) {
  if (state.disposed || !state.visible) return
  if (!state.source.trim()) {
    applyError(state, new Error("The Mermaid diagram source is empty."))
    return
  }
  const theme = themeSnapshot()
  const key = cacheKey(state.source, theme.key)
  if (!force && state.renderedKey === key && state.host.dataset.state === "ready") return

  const hit = getCached(key, state.source, theme.key)
  if (hit) {
    applyRendered(state, hit, key)
    return
  }

  const generation = ++state.generation
  setLoading(state)
  renderTail = renderTail
    .catch(() => undefined)
    .then(
      () =>
        new Promise<void>((resolve) => {
          scheduleWork(async () => {
            try {
              if (state.disposed || !state.visible || generation !== state.generation) return
              await document.fonts?.ready
              if (state.disposed || generation !== state.generation) return
              const freshTheme = themeSnapshot()
              const freshKey = cacheKey(state.source, freshTheme.key)
              if (freshKey !== key) {
                queueRender(state)
                return
              }
              const mermaid = await loadMermaid()
              if (state.disposed || generation !== state.generation) return
              mermaid.initialize(configuration(freshTheme))
              const result = await mermaid.render(`oc-mermaid-${++diagramID}-${state.sourceHash}`, state.source)
              const svg = sanitizeMermaidSvg(result.svg)
              if (!svg) throw new Error("Mermaid produced an empty SVG")
              const entry = putCached(key, state.source, freshTheme.key, svg, result.diagramType ?? "diagram")
              if (state.disposed || generation !== state.generation) return
              applyRendered(state, entry, key)
            } catch (error) {
              if (!state.disposed && generation === state.generation) applyError(state, error)
            } finally {
              resolve()
            }
          })
        }),
    )
}

function scheduleWork(run: () => void) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 180 })
    return
  }
  requestAnimationFrame(run)
}

function setLoading(state: MermaidState) {
  setPngExportAvailable(state, false)
  if (state.host.dataset.state === "ready") {
    state.host.dataset.state = "refreshing"
    state.host.setAttribute("aria-busy", "true")
    return
  }
  state.host.dataset.state = "loading"
  state.host.setAttribute("aria-busy", "true")
  state.type.textContent = "Rendering"
  const loading = document.createElement("div")
  loading.dataset.slot = "mermaid-loading"
  loading.setAttribute("role", "status")
  const spinner = document.createElement("span")
  spinner.dataset.slot = "mermaid-spinner"
  const text = document.createElement("span")
  text.textContent = "Rendering diagram"
  loading.append(spinner, text)
  state.stage.replaceChildren(loading)
}

function applyRendered(state: MermaidState, entry: CacheEntry, key: string) {
  state.stage.innerHTML = entry.svg
  const svg = state.stage.querySelector("svg")
  if (svg) {
    namespaceSvgIds(svg, `oc-mermaid-mounted-${++mountedSvgID}`)
    svg.setAttribute("role", svg.getAttribute("role") ?? "img")
    if (!svg.hasAttribute("aria-label") && !svg.hasAttribute("aria-labelledby")) svg.setAttribute("aria-label", "Mermaid diagram")
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet")
    const natural = viewBoxDimensions(svg.getAttribute("viewBox"))
    state.naturalWidth = natural?.width ?? 0
    state.naturalHeight = natural?.height ?? 0
  }
  state.type.textContent = prettyType(entry.diagramType)
  state.host.dataset.state = "ready"
  state.host.removeAttribute("aria-busy")
  setPngExportAvailable(state, true)
  state.renderedKey = key
  state.scale = 1
  state.targetScale = 1
  state.zoomVelocity = 0
  requestAnimationFrame(() => applyZoomGeometry(state))
}

function applyError(state: MermaidState, error: unknown) {
  setPngExportAvailable(state, false)
  state.host.dataset.state = "error"
  state.host.removeAttribute("aria-busy")
  state.type.textContent = "Render error"
  const box = document.createElement("div")
  box.dataset.slot = "mermaid-error"
  box.setAttribute("role", "alert")
  const title = document.createElement("strong")
  title.textContent = "Unable to render this Mermaid diagram"
  const detail = document.createElement("span")
  detail.textContent = friendlyError(error)
  const retry = document.createElement("button")
  retry.type = "button"
  retry.dataset.action = "retry"
  retry.textContent = "Retry"
  box.append(title, detail, retry)
  state.stage.replaceChildren(box)
}

function setPngExportAvailable(state: MermaidState, available: boolean) {
  const button = state.host.querySelector<HTMLButtonElement>('button[data-action="save-png"]')
  if (!button || button.dataset.busy === "true") return
  button.disabled = !available
}

function friendlyError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  const compact = raw.replace(/\s+/g, " ").trim()
  if (!compact) return "The diagram definition could not be parsed."
  return compact.length <= 420 ? compact : `${compact.slice(0, 417)}...`
}

function prettyType(value: string) {
  const normalized = value.replace(/-v\d+$/i, "").replace(/[-_]+/g, " ").trim()
  if (!normalized) return "Diagram"
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase())
}

async function loadMermaid() {
  return (mermaidPromise ??= import("mermaid")
    .then((module) => module.default)
    .catch((error) => {
      mermaidPromise = undefined
      throw error
    }))
}

function configuration(theme: ThemeSnapshot) {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: MERMAID_MAX_TEXT_SIZE,
    maxEdges: MERMAID_MAX_EDGES,
    layout: "dagre",
    darkMode: theme.dark,
    theme: "base" as const,
    fontFamily: theme.fontFamily,
    flowchart: {
      useMaxWidth: false,
      diagramPadding: 8,
      nodeSpacing: 32,
      rankSpacing: 42,
    },
    sequence: {
      useMaxWidth: false,
      diagramMarginX: 16,
      diagramMarginY: 12,
      actorMargin: 36,
      boxMargin: 8,
      boxTextMargin: 4,
      noteMargin: 8,
      messageMargin: 28,
    },
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "suppressErrorRendering",
      "maxTextSize",
      "maxEdges",
      "layout",
      "theme",
      "themeVariables",
      "themeCSS",
      "fontFamily",
      "htmlLabels",
      "darkMode",
    ],
    themeVariables: {
      background: theme.background,
      primaryColor: theme.surface,
      primaryTextColor: theme.text,
      primaryBorderColor: theme.border,
      secondaryColor: theme.surfaceMuted,
      tertiaryColor: theme.background,
      lineColor: theme.textMuted,
      textColor: theme.text,
      titleColor: theme.text,
      mainBkg: theme.surface,
      nodeBorder: theme.border,
      clusterBkg: theme.surfaceMuted,
      clusterBorder: theme.border,
      edgeLabelBackground: theme.background,
      actorBkg: theme.surface,
      actorBorder: theme.border,
      actorTextColor: theme.text,
      signalColor: theme.textMuted,
      signalTextColor: theme.text,
      labelBoxBkgColor: theme.surfaceMuted,
      labelBoxBorderColor: theme.border,
      labelTextColor: theme.text,
      noteBkgColor: theme.surfaceMuted,
      noteBorderColor: theme.border,
      noteTextColor: theme.text,
      cScale0: theme.accent,
    },
  }
}

function themeSnapshot(): ThemeSnapshot {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const scheme = root.dataset.colorScheme || (style.colorScheme.includes("dark") ? "dark" : "light")
  const dark = scheme === "dark"
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    key: `${root.dataset.theme ?? "default"}:${scheme}`,
    dark,
    fontFamily: read("--font-family-sans", "Inter, ui-sans-serif, system-ui, sans-serif"),
    background: read("--v2-background-bg-base", dark ? "#0d0d0d" : "#ffffff"),
    surface: read("--v2-background-bg-layer-02", dark ? "#181818" : "#f6f6f6"),
    surfaceMuted: read("--v2-background-bg-layer-01", dark ? "#121212" : "#fafafa"),
    text: read("--v2-text-text-base", dark ? "#f2f2f2" : "#161616"),
    textMuted: read("--v2-text-text-muted", dark ? "#a0a0a0" : "#666666"),
    border: read("--v2-border-border-base", dark ? "#3a3a3a" : "#d8d8d8"),
    accent: read("--v2-text-text-accent", dark ? "#8ab4ff" : "#245fcc"),
  }
}

function cacheKey(source: string, theme: string) {
  return `${theme}:${source.length}:${checksum(source) ?? "0"}`
}

function getCached(key: string, source: string, theme: string) {
  const hit = cache.get(key)
  if (!hit || hit.source !== source || hit.theme !== theme) return
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function putCached(key: string, source: string, theme: string, svg: string, diagramType: string) {
  const previous = cache.get(key)
  if (previous) cacheBytes -= previous.bytes
  cache.delete(key)
  const bytes = (source.length + svg.length + theme.length + diagramType.length) * 2
  const entry = { source, theme, svg, diagramType, bytes }
  if (bytes > MERMAID_CACHE_BYTES) return entry
  cache.set(key, entry)
  cacheBytes += bytes
  while (cache.size > MERMAID_CACHE_MAX || cacheBytes > MERMAID_CACHE_BYTES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    const evicted = cache.get(oldest)
    cache.delete(oldest)
    cacheBytes -= evicted?.bytes ?? 0
  }
  return entry
}

/**
 * Mermaid runs at securityLevel=strict. This second boundary keeps generated
 * SVG inert if a future diagram type emits an interactive node or external URL.
 * Local url(#id) references remain because Mermaid uses them for markers.
 */
export function sanitizeMermaidSvg(input: string) {
  if (!DOMPurify.isSupported) return ""
  const clean = String(
    DOMPurify.sanitize(input, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ["style"],
      ADD_ATTR: ["role", "aria-label", "aria-labelledby", "aria-describedby", "aria-roledescription", "tabindex"],
      FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed", "image", "a"],
      FORBID_CONTENTS: ["script", "foreignObject", "iframe", "object", "embed"],
      // Do not use SANITIZE_NAMED_PROPS here. Mermaid scopes its generated
      // stylesheet to the SVG render id. DOMPurify's named-prop isolation
      // prefixes ids without rewriting CSS selectors, which makes Mermaid's
      // theme rules stop matching and leaves SVG defaults (black fill/stroke).
      // SANITIZE_DOM remains enabled by default, and we namespace every id plus
      // its local references together when the sanitized SVG is mounted.
      FORBID_ATTR: ["name"],
    }),
  )
  const template = document.createElement("template")
  template.innerHTML = clean
  const svg = template.content.querySelector("svg")
  if (!svg) return ""

  // Mermaid diagram renderers are inconsistent about root sizing. Some emit
  // width="100%", some fixed dimensions, and several add an inline max-width.
  // Those values describe Mermaid's temporary render container, not our
  // timeline viewport. Preserve the viewBox as the source of truth and expose
  // its natural width to CSS so compact diagrams stay compact while wide
  // diagrams fluidly fit the message column.
  const viewBox = svg.getAttribute("viewBox")
  const natural = viewBoxDimensions(viewBox)
  svg.removeAttribute("width")
  svg.removeAttribute("height")
  svg.style.removeProperty("width")
  svg.style.removeProperty("height")
  svg.style.removeProperty("max-width")
  svg.style.removeProperty("max-height")
  if (natural) {
    svg.style.setProperty("--mermaid-natural-width", `${Math.ceil(natural.width)}px`)
    svg.style.setProperty("--mermaid-natural-ratio", `${natural.width} / ${natural.height}`)
  }
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet")

  for (const node of Array.from(svg.querySelectorAll("*"))) {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith("on")) {
        node.removeAttribute(attribute.name)
        continue
      }
      if (name === "href" || name === "xlink:href") {
        if (!fragmentReference(attribute.value)) node.removeAttribute(attribute.name)
        continue
      }
      if (attribute.value.toLowerCase().includes("url(")) {
        const value = sanitizeCssUrls(attribute.value)
        if (value) node.setAttribute(attribute.name, value)
        else node.removeAttribute(attribute.name)
      }
    }
  }
  for (const style of Array.from(svg.querySelectorAll("style"))) style.textContent = sanitizeCssUrls(style.textContent ?? "")
  return svg.outerHTML
}

/**
 * Cached Mermaid SVGs may be mounted more than once. Rebase every SVG id at
 * mount time and rewrite its local references and embedded CSS in lockstep.
 * This keeps Mermaid's id-scoped theme CSS functional while preventing
 * duplicate marker/filter/clip ids from leaking across diagrams.
 */
function namespaceSvgIds(svg: SVGElement, namespace: string) {
  const ids = new Map<string, string>()
  let index = 0
  for (const node of [svg, ...Array.from(svg.querySelectorAll<SVGElement>("[id]"))]) {
    const id = node.getAttribute("id")
    if (!id || ids.has(id)) continue
    ids.set(id, `${namespace}-${++index}`)
  }
  if (!ids.size) return

  for (const node of [svg, ...Array.from(svg.querySelectorAll<SVGElement>("*"))]) {
    const id = node.getAttribute("id")
    if (id) {
      const next = ids.get(id)
      if (next) node.setAttribute("id", next)
    }

    for (const attribute of Array.from(node.attributes)) {
      if (attribute.name === "id") continue
      const name = attribute.name.toLowerCase()
      const value =
        name === "aria-labelledby" || name === "aria-describedby"
          ? rebaseSvgIdList(attribute.value, ids)
          : rebaseSvgReferenceText(attribute.value, ids)
      if (value !== attribute.value) node.setAttribute(attribute.name, value)
    }
  }

  for (const style of Array.from(svg.querySelectorAll("style"))) {
    style.textContent = rebaseSvgReferenceText(style.textContent ?? "", ids)
  }
}

export function rebaseSvgReferenceText(value: string, ids: ReadonlyMap<string, string>) {
  let result = value
  for (const [from, to] of ids) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    result = result.replace(new RegExp(`#${escaped}(?=[^A-Za-z0-9_:.-]|$)`, "g"), `#${to}`)
  }
  return result
}

export function rebaseSvgIdList(value: string, ids: ReadonlyMap<string, string>) {
  return value
    .split(/(\s+)/)
    .map((token) => ids.get(token) ?? token)
    .join("")
}

export function viewBoxDimensions(value: string | null | undefined) {
  if (!value) return
  const parts = value.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4) return
  const width = parts[2]
  const height = parts[3]
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
  return { width, height }
}

function fragmentReference(value: string) {
  return /^#[A-Za-z_][\w:.-]*$/.test(value.trim())
}

export function sanitizeCssUrls(css: string) {
  return css
    .replace(/@import\s+[^;{}]*(?:;|$)/gi, "")
    .replace(/url\(\s*([^)]*?)\s*\)/gi, (_match, raw: string) => {
      const value = raw.trim().replace(/^(['"])(.*)\1$/, "$2")
      return fragmentReference(value) ? `url(${value})` : "none"
    })
}
