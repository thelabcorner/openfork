import { expect, test } from "bun:test"
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_PICKED_CHANNEL,
  type BrowserAnnotationPayload,
} from "./contracts"
import { AnnotationController, clampCropToViewport } from "./annotation"

// annotation.ts uses a TYPE-ONLY import of electron (`import type { NativeImage,
// WebContents }`), so no electron runtime module is required here. The controller
// is exercised through a minimal fake WebContents that records send() traffic and
// emits the IPC events the controller subscribes to.

interface FakeImage {
  getSize: () => { width: number; height: number }
  toDataURL: () => string
  resize: (size: { width: number; height: number }) => FakeImage
}

const makeImage = (w = 10, h = 10): FakeImage => ({
  getSize: () => ({ width: w, height: h }),
  toDataURL: () => "data:image/png;base64,AAAA",
  resize: (size) => makeImage(size.width, size.height),
})

class FakeWebContents {
  destroyed = false
  sent: string[] = []
  private handlers = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>()
  private onceHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  ipc = {
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => this.on(channel, fn),
    removeListener: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) =>
      this.removeListener(channel, fn),
  }

  on(channel: string, fn: (event: unknown, ...args: unknown[]) => void): void {
    const set = this.handlers.get(channel) ?? new Set()
    set.add(fn)
    this.handlers.set(channel, set)
  }
  once(channel: string, fn: (event: unknown, ...args: unknown[]) => void): void {
    this.onceHandlers.set(channel, fn)
  }
  removeListener(channel: string, fn: (event: unknown, ...args: unknown[]) => void): void {
    this.handlers.get(channel)?.delete(fn)
  }
  send(channel: string, _payload?: unknown): void {
    this.sent.push(channel)
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  async capturePage(): Promise<FakeImage> {
    return makeImage()
  }

  // test drivers
  emitPicked(payload: unknown): void {
    const fn = this.handlers.get(ANNOTATION_PICKED_CHANNEL)
    if (!fn) throw new Error("no picked handler registered")
    for (const h of fn) h({}, payload)
  }
  emitNavigation(isMainFrame = true): void {
    // "did-start-navigation" is registered with .on() (persistent), while
    // "destroyed" uses .once(). Fire both maps so the driver matches how the
    // controller actually subscribes.
    this.onceHandlers.get("did-start-navigation")?.({}, "https://other.example", false, isMainFrame)
    const persistent = this.handlers.get("did-start-navigation")
    if (persistent) for (const h of persistent) h({}, "https://other.example", false, isMainFrame)
  }
}

const validPayload = (overrides: Partial<BrowserAnnotationPayload> = {}): BrowserAnnotationPayload => ({
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
  strokes: [],
  styleChanges: [],
  screenshot: null,
  cropRect: null,
  submission: "attach",
  createdAt: "2026-09-04T00:00:00Z",
  ...overrides,
})

const identity = (generation: number, genOf: (tabId: string) => number | undefined) => ({
  generation,
  webContentsId: 1,
  getCurrentGeneration: genOf,
  getCurrentViewport: () => ({ width: 800, height: 600 }),
})

// --- CRITICAL ACCEPTANCE: forced guest replacement mid-session ---------------

test("replacement before capture: start() resolves null and acks NO capture-complete", async () => {
  const wc = new FakeWebContents()
  const ctrl = new AnnotationController()
  // Session claimed generation 1; the tab was replaced/unregistered, so the
  // registry now reports undefined for it.
  const promise = ctrl.start("tab-1", wc as never, "light", identity(1, () => undefined))
  wc.emitPicked(validPayload())
  const result = await promise
  expect(result).toBe(null)
  expect(wc.sent).not.toContain(ANNOTATION_CAPTURED_CHANNEL)
  expect(wc.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(0)
})

test("generation bump before capture: start() resolves null and acks NO capture-complete", async () => {
  const wc = new FakeWebContents()
  const ctrl = new AnnotationController()
  // A re-registration bumped the registry generation past the session's claim.
  const promise = ctrl.start("tab-1", wc as never, "light", identity(1, () => 2))
  wc.emitPicked(validPayload())
  const result = await promise
  expect(result).toBe(null)
  expect(wc.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(0)
})

// --- CRITICAL ACCEPTANCE: navigation during capture --------------------------

test("main-frame navigation during capture: start() resolves null, no ack to same-generation guest", async () => {
  const wc = new FakeWebContents()
  const ctrl = new AnnotationController()
  // Same generation (navigation does NOT bump generation), but the navigation
  // subscription must cancel the in-flight pick.
  const promise = ctrl.start("tab-1", wc as never, "light", identity(5, () => 5))
  wc.emitPicked(validPayload({ cropRect: { x: 0, y: 0, width: 50, height: 50 } }))
  // Fire a main-frame navigation before capture resolves.
  wc.emitNavigation(true)
  const result = await promise
  expect(result).toBe(null)
  expect(wc.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(0)
})

test("subframe (SPA) navigation during capture does NOT cancel", async () => {
  const wc = new FakeWebContents()
  const ctrl = new AnnotationController()
  const promise = ctrl.start("tab-1", wc as never, "light", identity(5, () => 5))
  wc.emitPicked(validPayload({ cropRect: { x: 0, y: 0, width: 50, height: 50 } }))
  wc.emitNavigation(false) // in-place SPA push
  const result = await promise
  // The pick still completes because only main-frame navigation abandons it.
  expect(result).not.toBe(null)
  expect(result?.screenshot).not.toBe(null)
  expect(wc.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(1)
})

// --- happy paths ------------------------------------------------------------

test("valid payload, no crop: settles with screenshot null and acks exactly once", async () => {
  const wc = new FakeWebContents()
  const ctrl = new AnnotationController()
  const promise = ctrl.start("tab-1", wc as never, "light", identity(1, () => 1))
  wc.emitPicked(validPayload({ cropRect: null }))
  const result = await promise
  expect(result).not.toBe(null)
  expect(result?.screenshot).toBe(null)
  expect(wc.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(1)
})

test("valid payload with crop: settles with a screenshot and acks exactly once", async () => {
  const wc = new FakeWebContents()
  const ctrl = new AnnotationController()
  const promise = ctrl.start("tab-1", wc as never, "light", identity(1, () => 1))
  wc.emitPicked(validPayload({ cropRect: { x: 0, y: 0, width: 50, height: 50 } }))
  const result = await promise
  expect(result).not.toBe(null)
  expect(result?.screenshot).not.toBe(null)
  expect(wc.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(1)
})

test("malformed payload (screenshot spoofed) resolves null, no capture ack", async () => {
  const wc = new FakeWebContents()
  const ctrl = new AnnotationController()
  const promise = ctrl.start("tab-1", wc as never, "light", identity(1, () => 1))
  const spoofed = validPayload() as unknown as Record<string, unknown>
  spoofed.screenshot = makeImage()
  wc.emitPicked(spoofed)
  const result = await promise
  expect(result).toBe(null)
  expect(wc.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(0)
})

// --- pure clamp (host-side re-clamp of the guest's crop against real viewport)

test("clampCropToViewport keeps the rect inside the viewport", () => {
  const viewport = { width: 100, height: 100 }
  expect(clampCropToViewport({ x: 0, y: 0, width: 200, height: 200 }, viewport)).toEqual({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  })
})

test("clampCropToViewport floors coordinates at 0 and sizes at >=1", () => {
  const viewport = { width: 100, height: 100 }
  expect(clampCropToViewport({ x: -10, y: -10, width: 5, height: 5 }, viewport)).toEqual({
    x: 0,
    y: 0,
    width: 5,
    height: 5,
  })
})

test("clampCropToViewport shrinks an overflowing rect to the remaining viewport", () => {
  const viewport = { width: 100, height: 100 }
  // x=90, width=50 -> right edge 140; remaining from x=90 is 10.
  expect(clampCropToViewport({ x: 90, y: 10, width: 50, height: 50 }, viewport)).toEqual({
    x: 90,
    y: 10,
    width: 10,
    height: 50,
  })
})
