import { describe, expect, test } from "bun:test"
import { createInertialImageZoom, dampedZoom, imageZoomGeometry } from "./image-zoom"

describe("native-resolution inertial media zoom", () => {
  test("fits without upscaling small originals and keeps the image centered", () => {
    expect(imageZoomGeometry(800, 600, 1600, 800, 1)).toEqual({
      width: 764, height: 382, stageWidth: 800, stageHeight: 600, offsetX: 18, offsetY: 109,
    })
    expect(imageZoomGeometry(800, 600, 100, 100, 1)?.width).toBe(100)
    expect(imageZoomGeometry(800, 600, 0, 100, 1)).toBeUndefined()
    expect(imageZoomGeometry(NaN, 600, 100, 100, 1)).toBeUndefined()
  })

  test("expands SVG display dimensions without a transform or downsampled canvas", () => {
    const raf = globalThis.requestAnimationFrame
    const caf = globalThis.cancelAnimationFrame
    const frames = new Map<number, FrameRequestCallback>()
    let frameID = 0
    globalThis.requestAnimationFrame = (callback) => {
      frames.set(++frameID, callback)
      return frameID
    }
    globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
    const handlers = new Map<string, (event: any) => void>()
    const viewport = {
      clientWidth: 800, clientHeight: 600, scrollLeft: 0, scrollTop: 0, scrollWidth: 800, scrollHeight: 600,
      dataset: {} as Record<string, string>,
      addEventListener(type: string, fn: (event: any) => void) { handlers.set(type, fn) },
      getBoundingClientRect() { return { left: 100, top: 200, width: 800, height: 600 } },
      scrollBy() {},
      setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false },
    }
    const image = { style: {} as Record<string, string> }
    const stage = { style: {} as Record<string, string> }
    const zoom = createInertialImageZoom({
      viewport: viewport as unknown as HTMLElement,
      stage: stage as unknown as HTMLElement,
      image: () => image as unknown as HTMLImageElement,
    })
    zoom.setIntrinsic(1600, 800)
    expect(image.style.width).toBe("764px")
    zoom.zoomTo(2, 500, 500, false)
    expect(image.style.width).toBe("1528px")
    expect(image.style.height).toBe("764px")
    expect(image.style.transform).toBeUndefined()
    expect(stage.style.width).toBe("1564px")
    expect(stage.style.height).toBe("800px")
    expect(viewport.scrollLeft).toBe(382)
    expect(viewport.scrollTop).toBe(100)
    zoom.zoomTo(1, 500, 500, false)
    expect(viewport.scrollLeft).toBeCloseTo(0, 8)
    expect(viewport.scrollTop).toBeCloseTo(0, 8)
    zoom.zoomTo(16, 500, 500, false)
    expect(zoom.scale()).toBe(8)
    zoom.zoomTo(-10, 500, 500, false)
    expect(zoom.scale()).toBe(0.25)
    // A Ctrl-less wheel belongs to the scrolling parent; Ctrl+wheel is a
    // viewer operation and must cancel browser page zoom.
    let prevented = false
    const wheel = handlers.get("wheel")!
    wheel({ ctrlKey: false, metaKey: false, deltaY: -80, deltaMode: 0, clientX: 500, clientY: 500, preventDefault() { prevented = true } })
    expect(prevented).toBe(false)
    zoom.zoomTo(1, 500, 500, false)
    wheel({ ctrlKey: true, metaKey: false, deltaY: -80, deltaMode: 0, clientX: 500, clientY: 500, preventDefault() { prevented = true } })
    expect(prevented).toBe(true)
    expect(zoom.target()).toBeGreaterThan(1)
    expect(frames.size).toBe(1)
    for (let i = 1; i <= 120 && frames.size > 0; i++) {
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((callback) => callback(i * (1000 / 60)))
    }
    expect(zoom.scale()).toBeCloseTo(zoom.target(), 3)
    zoom.zoomTo(1, 500, 500, false)
    const touch = (pointerId: number, clientX: number, clientY: number) => ({
      pointerId, clientX, clientY, pointerType: "touch", button: 0,
      target: null, preventDefault() {},
    })
    handlers.get("pointerdown")!(touch(1, 450, 500))
    handlers.get("pointerdown")!(touch(2, 550, 500))
    handlers.get("pointermove")!(touch(2, 650, 500))
    expect(zoom.scale()).toBeCloseTo(2, 5)
    handlers.get("pointerup")!(touch(2, 650, 500))
    handlers.get("pointerup")!(touch(1, 450, 500))
    zoom.zoomTo(3)
    expect(frames.size).toBe(1)
    zoom.dispose()
    expect(frames.size).toBe(0)
    globalThis.requestAnimationFrame = raf
    globalThis.cancelAnimationFrame = caf
  })

  test("spring converges monotonically at realistic refresh rates, without overshoot", () => {
    for (const fps of [30, 60, 120, 240]) {
      let current = 1
      let velocity = 0
      for (let i = 0; i < fps; i++) {
        const next = dampedZoom(current, 3, velocity, 1 / fps)
        expect(next.value).toBeGreaterThanOrEqual(current)
        expect(next.value).toBeLessThanOrEqual(3)
        current = next.value
        velocity = next.velocity
      }
      expect(current).toBeGreaterThan(2.99)
    }
  })
})
