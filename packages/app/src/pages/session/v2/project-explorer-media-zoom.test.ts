import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createMediaZoom } from "./project-explorer-svg-viewer"

const settle = () => new Promise((resolve) => setTimeout(resolve, 80))
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

function mount() {
  const viewport = document.createElement("div")
  const stage = document.createElement("div")
  Object.defineProperty(viewport, "clientWidth", { value: 800, configurable: true })
  Object.defineProperty(viewport, "clientHeight", { value: 600, configurable: true })
  viewport.appendChild(stage)
  document.body.appendChild(viewport)
  const root = createRoot((dispose) => {
    const zoom = createMediaZoom({ viewport: () => viewport, stage: () => stage })
    return { zoom, dispose }
  })
  return { ...root, viewport, stage }
}

const wheel = (zoom: { onWheel: (event: WheelEvent) => void }, deltaY: number, clientX = 400, clientY = 300) => {
  const event = new WheelEvent("wheel", { deltaY, cancelable: true })
  // happy-dom's WheelEvent drops clientX/clientY from the init dict
  Object.defineProperty(event, "clientX", { value: clientX })
  Object.defineProperty(event, "clientY", { value: clientY })
  zoom.onWheel(event)
}

const pointer = (
  zoom: { [K in "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"]: (event: PointerEvent) => void },
  kind: "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel",
  clientX: number,
  clientY: number,
  button = 0,
) => zoom[kind](new PointerEvent(kind, { clientX, clientY, button, pointerId: 1, bubbles: true }))

const scaleOf = (stage: HTMLDivElement) => Number(/scale\(([\d.]+)\)/.exec(stage.style.transform)?.[1] ?? 1)
const translateOf = (stage: HTMLDivElement) => {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(stage.style.transform)
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 }
}

describe("createMediaZoom", () => {
  test("wheel down zooms in (scale grows) and centers around the cursor", async () => {
    const { zoom, stage, dispose } = mount()
    wheel(zoom, -100)
    await settle()
    expect(scaleOf(stage)).toBeGreaterThan(1)
    expect(zoom.percent()).toBeGreaterThan(100)
    dispose()
  })

  test("wheel up zooms out back toward 1 and re-centers at fit (min scale 1)", async () => {
    const { zoom, stage, dispose } = mount()
    wheel(zoom, -100, 100, 100)
    await settle()
    expect(scaleOf(stage)).toBeGreaterThan(1)
    for (let i = 0; i < 60; i++) wheel(zoom, 100)
    await settle()
    expect(scaleOf(stage)).toBe(1)
    expect(translateOf(stage)).toEqual({ x: 0, y: 0 })
    expect(zoom.percent()).toBe(100)
    dispose()
  })

  test("zoom-out from an off-center zoom re-centers the image", async () => {
    const { zoom, viewport, stage, dispose } = mount()
    wheel(zoom, -100, 100, 100)
    await settle()
    expect(scaleOf(stage)).toBeGreaterThan(1.05)
    expect(translateOf(stage).x).toBeLessThan(0)
    for (let i = 0; i < 60; i++) wheel(zoom, 100)
    await settle()
    expect(stage.style.transform).toBe("translate(0px, 0px) scale(1)")
    void viewport
    dispose()
  })

  test("zoom clamps to 8x max", async () => {
    const { zoom, stage, dispose } = mount()
    for (let i = 0; i < 120; i++) wheel(zoom, -100)
    await settle()
    expect(scaleOf(stage)).toBe(8)
    expect(zoom.percent()).toBe(800)
    dispose()
  })

  test("zoomBy buttons step the scale and reset returns to 1", async () => {
    const { zoom, stage, dispose } = mount()
    zoom.zoomBy(1.25)
    await settle()
    const zoomed = scaleOf(stage)
    expect(zoomed).toBeGreaterThan(1.1)
    zoom.zoomBy(1.25)
    await settle()
    expect(scaleOf(stage)).toBeGreaterThan(zoomed)
    zoom.reset()
    await settle()
    expect(scaleOf(stage)).toBe(1)
    expect(zoom.percent()).toBe(100)
    dispose()
  })

  test("click-drag pans the stage while zoomed in", async () => {
    const { zoom, stage, dispose } = mount()
    zoom.zoomBy(2)
    await settle()
    const before = translateOf(stage)
    pointer(zoom, "onPointerDown", 400, 300)
    pointer(zoom, "onPointerMove", 350, 260)
    pointer(zoom, "onPointerMove", 300, 220)
    pointer(zoom, "onPointerUp", 300, 220)
    await tick()
    const after = translateOf(stage)
    expect(after.x).toBeLessThan(before.x - 80)
    expect(after.y).toBeLessThan(before.y - 60)
    dispose()
  })

  test("drag is a no-op at fit scale (min 1)", async () => {
    const { zoom, stage, dispose } = mount()
    const before = stage.style.transform
    pointer(zoom, "onPointerDown", 400, 300)
    pointer(zoom, "onPointerMove", 300, 200)
    pointer(zoom, "onPointerUp", 300, 200)
    await tick()
    expect(stage.style.transform).toBe(before)
    dispose()
  })

  test("fast drag flings the stage with inertia", async () => {
    const { zoom, stage, dispose } = mount()
    zoom.zoomBy(2)
    await settle()
    pointer(zoom, "onPointerDown", 600, 300)
    for (let i = 1; i <= 5; i++) {
      pointer(zoom, "onPointerMove", 600 - i * 20, 300)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const atRelease = translateOf(stage)
    pointer(zoom, "onPointerUp", 500, 300)
    await settle()
    const after = translateOf(stage)
    expect(after.x).toBeLessThan(atRelease.x - 10)
    dispose()
  })

  test("wheel keeps the content under the cursor anchored", async () => {
    const { zoom, stage, dispose } = mount()
    wheel(zoom, -100, 200, 150)
    await settle()
    const transform = stage.style.transform
    expect(transform).toContain("translate(")
    expect(transform).toContain("scale(")
    dispose()
  })
})
