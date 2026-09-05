import { expect, mock, test } from "bun:test"
import { ANNOTATION_CAPTURED_CHANNEL, ANNOTATION_PICKED_CHANNEL, type BrowserAnnotationPayload } from "./contracts"

// End-to-end through the real BrowserEngine facade (NOT the bare
// AnnotationController). Every other annotation test injects the controller's
// identity getters directly; this one exercises the actual wiring in
// index.ts's api.startAnnotation — which reads the registry generation and
// builds getCurrentGeneration from it — so a forced guest replacement (the
// real unregister/re-register path) is proven to cancel a mid-session pick
// with zero screenshot bytes / zero capture-complete acks, end to end.
//
// No real WebContents is created; electron is mocked and a controllable fake
// stands in for each guest webContents (and the host window's webContents).
mock.module("electron", () => {
  const host = makeFakeWebContents(0, "window")
  return {
    app: { isReady: () => true },
    nativeTheme: { shouldUseDarkColors: false },
    session: { fromPartition: () => ({ clearStorageData: () => Promise.resolve() }) },
    webContents: { fromId: (id: number) => registry.get(id) ?? null },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: host }],
      fromWebContents: () => ({}) as unknown,
    },
  }
})

const registry = new Map<number, ReturnType<typeof makeFakeWebContents>>()

function makeFakeWebContents(id: number, type: "webview" | "window") {
  const handlers = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>()
  const onceHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const wc = {
    id,
    destroyed: false,
    sent: [] as string[],
    type,
    hostWebContents: undefined as unknown,
    ipc: {
      on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
        const set = handlers.get(channel) ?? new Set()
        set.add(fn)
        handlers.set(channel, set)
      },
      removeListener: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
        handlers.get(channel)?.delete(fn)
      },
    },
    on(channel: string, fn: (event: unknown, ...args: unknown[]) => void) {
      const set = handlers.get(channel) ?? new Set()
      set.add(fn)
      handlers.set(channel, set)
    },
    once(channel: string, fn: (event: unknown, ...args: unknown[]) => void) {
      onceHandlers.set(channel, fn)
    },
    removeListener(channel: string, fn: (event: unknown, ...args: unknown[]) => void) {
      handlers.get(channel)?.delete(fn)
    },
    send(channel: string, _payload?: unknown) {
      wc.sent.push(channel)
    },
    isDestroyed() {
      return wc.destroyed
    },
    getType() {
      return wc.type
    },
    getURL() {
      return "https://example.com"
    },
    isLoading() {
      return false
    },
    capturePage() {
      return Promise.resolve({ getSize: () => ({ width: 10, height: 10 }), toDataURL: () => "data:image/png;base64,AAAA", resize: (s: { width: number; height: number }) => ({ getSize: () => s, toDataURL: () => "x", resize: () => ({}) }) })
    },
    setWindowOpenHandler: () => ({ action: "deny" }),
    emitPicked(payload: unknown) {
      const fns = handlers.get(ANNOTATION_PICKED_CHANNEL)
      if (!fns) throw new Error("no picked handler")
      for (const fn of fns) fn({}, payload)
    },
  }
  registry.set(id, wc as never)
  return wc
}

const { BrowserEngine } = await import("./index")

const validPayload = (overrides: Partial<BrowserAnnotationPayload> = {}): BrowserAnnotationPayload => ({
  id: "a1",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "look here",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  cropRect: null,
  submission: "attach",
  createdAt: "2026-09-04T00:00:00Z",
  ...overrides,
})

function makeEngine() {
  const host = registry.get(0)!
  return new BrowserEngine({
    windowId: "test-window",
    sidecarProvider: () => null,
    broadcast: () => undefined,
    getLastFocusedWebContents: () => host as never,
    recordingDirectory: "/tmp",
  })
}

test("engine startAnnotation resolves a real result for a pick with no replacement", async () => {
  const engine = makeEngine()
  // Guest webContents id 1, initial generation 0.
  const guest = makeFakeWebContents(1, "webview")
  guest.hostWebContents = registry.get(0)
  engine.api.registerWebview("tab-e2e-ok", 1, 0)

  const promise = engine.api.startAnnotation("tab-e2e-ok")
  // Normal pick, no crop -> engine should settle with screenshot null and ack once.
  guest.emitPicked(validPayload())
  const result = await promise

  expect(result).not.toBe(null)
  expect(result?.screenshot).toBe(null)
  expect(guest.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(1)
  engine.api.cancelAnnotation("tab-e2e-ok")
})

test("engine: forced guest replacement mid-session cancels the pick with zero screenshot acks", async () => {
  const engine = makeEngine()
  // Initial registration: generation 0.
  const oldGuest = makeFakeWebContents(1, "webview")
  oldGuest.hostWebContents = registry.get(0)
  engine.api.registerWebview("tab-e2e-repl", 1, 0)

  // Start the annotation session through the real engine wiring. The session
  // claims the registry's current generation (0) at this moment.
  const promise = engine.api.startAnnotation("tab-e2e-repl")

  // FORCED REPLACEMENT: the renderer unmounts the old <webview> and mounts a
  // new one for the same tab, bumping the generation past the session's claim.
  engine.api.unregisterWebview("tab-e2e-repl", 1, 0)
  const newGuest = makeFakeWebContents(2, "webview")
  newGuest.hostWebContents = registry.get(0)
  engine.api.registerWebview("tab-e2e-repl", 2, 1)

  // The OLD guest now returns its pick — but the engine's getCurrentGeneration
  // now reads 1 from the registry, so the generation guard must reject it.
  oldGuest.emitPicked(validPayload())

  const result = await promise

  // The forced replacement wins: no annotation is produced for the stranger.
  expect(result).toBe(null)
  // Zero capture-complete acks were ever sent to the old (or new) guest.
  expect(oldGuest.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(0)
  expect(newGuest.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(0)
})
