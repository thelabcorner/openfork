/**
 * Browser-native image zoom with a critically damped spring and exact cursor
 * anchoring. The IMAGE is resized at each animation step (never a scaled canvas
 * or composited bitmap snapshot). SVG sources are re-rasterized by the browser
 * from their vector description at the requested display dimensions; raster
 * sources retain their full-resolution original, with no lossy preview stage.
 */
export const IMAGE_ZOOM_SMOOTH_TIME = 0.11

export function dampedZoom(current: number, target: number, velocity: number, dt: number, smoothTime = IMAGE_ZOOM_SMOOTH_TIME) {
  const omega = 2 / Math.max(0.0001, smoothTime)
  const x = omega * Math.max(1 / 240, Math.min(1 / 30, dt))
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = current - target
  const temp = (velocity + omega * change) * (x / omega)
  let nextVelocity = (velocity - omega * temp) * decay
  let value = target + (change + temp) * decay
  if ((target - current > 0) === (value > target)) {
    value = target
    nextVelocity = 0
  }
  return { value, velocity: nextVelocity }
}

export function imageZoomGeometry(
  viewportWidth: number, viewportHeight: number, intrinsicWidth: number, intrinsicHeight: number,
  scale: number, padding = 18,
) {
  if (![viewportWidth, viewportHeight, intrinsicWidth, intrinsicHeight, scale].every(Number.isFinite) ||
    Math.min(viewportWidth, viewportHeight, intrinsicWidth, intrinsicHeight, scale) <= 0) return
  const fit = Math.min(1, (viewportWidth - 2 * padding) / intrinsicWidth, (viewportHeight - 2 * padding) / intrinsicHeight)
  const width = intrinsicWidth * Math.max(1e-6, fit) * scale
  const height = intrinsicHeight * Math.max(1e-6, fit) * scale
  const stageWidth = Math.max(viewportWidth, width + 2 * padding)
  const stageHeight = Math.max(viewportHeight, height + 2 * padding)
  return { width, height, stageWidth, stageHeight, offsetX: (stageWidth - width) / 2, offsetY: (stageHeight - height) / 2 }
}

export function createInertialImageZoom(options: {
  viewport: HTMLElement
  stage: HTMLElement
  image: () => HTMLImageElement | undefined
  minScale?: number
  maxScale?: number
  padding?: number
  onScale?: (current: number, target: number) => void
}) {
  const viewport = options.viewport
  const minScale = options.minScale ?? 0.25
  const maxScale = options.maxScale ?? 8
  const padding = options.padding ?? 18
  let intrinsicWidth = 0
  let intrinsicHeight = 0
  let scale = 1
  let target = 1
  let velocity = 0
  let frame: number | undefined
  let lastTime: number | undefined
  let size = { width: viewport.clientWidth, height: viewport.clientHeight }
  let anchor: { x: number; y: number; u: number; v: number } | undefined
  let pointer: { id: number; x: number; y: number; left: number; top: number } | undefined
  const touches = new Map<number, { x: number; y: number }>()
  let pinch: { distance: number; scale: number } | undefined
  let moved = false
  let suppressClickUntil = 0
  let disposed = false
  const abort = new AbortController()
  const clamp = (value: number) => Math.max(minScale, Math.min(maxScale, value))
  const geometry = (value: number) => imageZoomGeometry(size.width, size.height, intrinsicWidth, intrinsicHeight, value, padding)

  const apply = () => {
    const g = geometry(scale)
    const image = options.image()
    if (!g || !image) return
    // Setting the image's actual dimensions, rather than transform:scale(),
    // keeps vector image/svg+xml sources sharp at arbitrary zoom.
    image.style.width = `${g.width}px`
    image.style.height = `${g.height}px`
    options.stage.style.width = `${g.stageWidth}px`
    options.stage.style.height = `${g.stageHeight}px`
    if (anchor) {
      viewport.scrollLeft = g.offsetX + anchor.u * g.width - anchor.x
      viewport.scrollTop = g.offsetY + anchor.v * g.height - anchor.y
    }
    viewport.dataset.zoomed = scale > 1.001 || scale < 0.999 ? "true" : "false"
    options.onScale?.(scale, target)
  }

  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    lastTime = undefined
  }
  const stopGestures = () => {
    const ids = [...touches.keys()]
    if (pointer) ids.push(pointer.id)
    for (const id of ids) if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id)
    touches.clear()
    pointer = undefined
    pinch = undefined
    moved = false
    delete viewport.dataset.panning
  }

  const step = (now: number) => {
    frame = undefined
    if (disposed) return
    const dt = lastTime === undefined ? 1 / 60 : (now - lastTime) / 1000
    lastTime = now
    const result = dampedZoom(scale, target, velocity, dt)
    scale = result.value
    velocity = result.velocity
    const done = Math.abs(target - scale) < 0.0005 && Math.abs(velocity) < 0.005
    if (done) {
      scale = target
      velocity = 0
    }
    apply()
    if (!done) frame = requestAnimationFrame(step)
    else lastTime = undefined
  }

  const zoomTo = (next: number, clientX?: number, clientY?: number, smooth = true) => {
    if (disposed || !Number.isFinite(next)) return
    const rect = viewport.getBoundingClientRect()
    const x = clientX === undefined ? rect.width / 2 : clientX - rect.left
    const y = clientY === undefined ? rect.height / 2 : clientY - rect.top
    const g = geometry(scale)
    anchor = g ? {
      x, y,
      u: (viewport.scrollLeft + x - g.offsetX) / g.width,
      v: (viewport.scrollTop + y - g.offsetY) / g.height,
    } : undefined
    target = clamp(next)
    if (!smooth || (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)) {
      cancel()
      scale = target
      velocity = 0
      apply()
      return
    }
    options.onScale?.(scale, target)
    if (frame === undefined) frame = requestAnimationFrame(step)
  }

  const setIntrinsic = (width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    cancel()
    stopGestures()
    intrinsicWidth = width
    intrinsicHeight = height
    scale = target = 1
    velocity = 0
    anchor = undefined
    apply()
    viewport.scrollLeft = 0
    viewport.scrollTop = 0
  }

  const resize = (width = viewport.clientWidth, height = viewport.clientHeight) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    // Preserve the viewport center's normalized location during window resize.
    const g = geometry(scale)
    if (g) anchor = {
      x: width / 2, y: height / 2,
      u: (viewport.scrollLeft + size.width / 2 - g.offsetX) / g.width,
      v: (viewport.scrollTop + size.height / 2 - g.offsetY) / g.height,
    }
    size = { width, height }
    apply()
  }

  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1)
    zoomTo(target * Math.exp(-Math.max(-180, Math.min(180, delta)) * 0.0018), event.clientX, event.clientY)
  }
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return
    if (event.key === "+" || event.key === "=") zoomTo(target + 0.25)
    else if (event.key === "-") zoomTo(target - 0.25)
    else if (event.key === "0") zoomTo(1)
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const amount = event.shiftKey ? 48 : 20
      viewport.scrollBy({
        left: event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0,
        top: event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0,
        behavior: "smooth",
      })
    } else return
    event.preventDefault()
  }
  const down = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touches.size === 1) moved = false
      viewport.setPointerCapture(event.pointerId)
      if (touches.size >= 2) {
        const [a, b] = [...touches.values()]
        pinch = { distance: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)), scale: target }
        pointer = undefined
        moved = true
        suppressClickUntil = performance.now() + 250
        viewport.dataset.panning = "true"
        event.preventDefault()
        return
      }
    }
    if (event.button !== 0 || (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight)) return
    if (typeof Element !== "undefined" && event.target instanceof Element && event.target.closest("button, a, input")) return
    event.preventDefault()
    moved = false
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }
    viewport.setPointerCapture(event.pointerId)
    viewport.dataset.panning = "true"
  }
  const move = (event: PointerEvent) => {
    if (touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pinch && touches.size >= 2) {
        const [a, b] = [...touches.values()]
        const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y)
        zoomTo(pinch.scale * distance / pinch.distance, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2, false)
        return
      }
    }
    if (!pointer || pointer.id !== event.pointerId) return
    const dx = event.clientX - pointer.x
    const dy = event.clientY - pointer.y
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      moved = true
      suppressClickUntil = performance.now() + 250
    }
    viewport.scrollLeft = pointer.left - dx
    viewport.scrollTop = pointer.top - dy
  }
  const up = (event: PointerEvent) => {
    touches.delete(event.pointerId)
    if (touches.size < 2) pinch = undefined
    if (pointer?.id === event.pointerId) pointer = undefined
    if (moved) suppressClickUntil = performance.now() + 250
    if (!pointer && !pinch) delete viewport.dataset.panning
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
  }

  viewport.addEventListener("wheel", wheel, { passive: false, signal: abort.signal })
  viewport.addEventListener("keydown", key, { signal: abort.signal })
  viewport.addEventListener("pointerdown", down, { signal: abort.signal })
  viewport.addEventListener("pointermove", move, { signal: abort.signal })
  viewport.addEventListener("pointerup", up, { signal: abort.signal })
  viewport.addEventListener("pointercancel", up, { signal: abort.signal })
  viewport.addEventListener("lostpointercapture", up, { signal: abort.signal })
  viewport.addEventListener("dblclick", () => zoomTo(1), { signal: abort.signal })

  return {
    zoomTo,
    zoomBy: (amount: number) => zoomTo(target + amount),
    reset: () => zoomTo(1),
    resize,
    setIntrinsic,
    target: () => target,
    scale: () => scale,
    consumeDrag: () => {
      const value = moved && performance.now() <= suppressClickUntil
      moved = false
      return value
    },
    dispose: () => {
      disposed = true
      cancel()
      stopGestures()
      abort.abort()
    },
  }
}
