import { expect, mock, test } from "bun:test"
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  type BrowserAnnotationPayload,
} from "./contracts"

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
    zoomFactor: 1,
    audioMuted: false,
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
    setZoomFactor(value: number) {
      wc.zoomFactor = value
    },
    setAudioMuted(value: boolean) {
      wc.audioMuted = value
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
    emitIpc(channel: string, payload: unknown) {
      for (const fn of handlers.get("ipc-message") ?? []) fn({}, channel, payload)
    },
    emitEvent(channel: string, ...args: unknown[]) {
      for (const fn of handlers.get(channel) ?? []) fn({}, ...args)
      const once = onceHandlers.get(channel)
      if (once) {
        onceHandlers.delete(channel)
        once({}, ...args)
      }
    },
    handlerCount(channel: string) {
      return handlers.get(channel)?.size ?? 0
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

function makeEngine(broadcast: (channel: string, payload: unknown) => void = () => undefined) {
  const host = registry.get(0)!
  const requests = new Map<string, number>()
  const engine = new BrowserEngine({
    windowId: "test-window",
    sidecarProvider: () => null,
    broadcast: (channel, payload) => {
      if (channel === "browser-tab-request") {
        const request = payload as { tabId: string; lifecycleGeneration: number }
        requests.set(request.tabId, request.lifecycleGeneration)
      }
      broadcast(channel, payload)
    },
    getLastFocusedWebContents: () => host as never,
    recordingDirectory: "/tmp",
  })
  return {
    engine,
    requests,
    requestTab: (url = "https://example.com") => {
      const { tabId } = engine.api.openTab(url)
      const lifecycleGeneration = requests.get(tabId)
      if (lifecycleGeneration === undefined) throw new Error(`No lifecycle request for ${tabId}`)
      return { tabId, lifecycleGeneration }
    },
  }
}

test("renderer detach preserves logical owner/mute state and replacement restores it before publication", () => {
  const states: Array<{ owner?: unknown; muted?: boolean; attached?: boolean }> = []
  const { engine, requestTab } = makeEngine((channel, payload) => {
    if (channel === "browser-state") states.push(payload as { owner?: unknown; muted?: boolean; attached?: boolean })
  })
  const requested = requestTab()
  const first = makeFakeWebContents(10, "webview")
  first.hostWebContents = registry.get(0)
  engine.api.registerWebview(requested.tabId, 10, 0, requested.lifecycleGeneration)
  engine.registry.setOwner(requested.tabId, { kind: "agent", sessionId: "sess-preserve" })
  engine.registry.setMuted(requested.tabId, true)

  engine.api.unregisterWebview(requested.tabId, 10, 0, requested.lifecycleGeneration)
  const detached = engine.registry.get(requested.tabId)
  expect(detached).toBeDefined()
  expect(detached?.attached).toBe(false)
  expect(detached?.owner).toEqual({ kind: "agent", sessionId: "sess-preserve" })
  expect(detached?.muted).toBe(true)

  const replacement = makeFakeWebContents(11, "webview")
  replacement.hostWebContents = registry.get(0)
  engine.api.registerWebview(requested.tabId, 11, 1, requested.lifecycleGeneration)
  expect(replacement.audioMuted).toBe(true)
  expect(replacement.zoomFactor).toBe(1)
  expect(engine.registry.get(requested.tabId)?.owner).toEqual({ kind: "agent", sessionId: "sess-preserve" })
  expect(states.at(-1)?.attached).toBe(true)
  expect(states.at(-1)?.muted).toBe(true)
})

test("logical close rejects a late renderer registration from the closed lifetime", () => {
  const { engine, requestTab } = makeEngine()
  const requested = requestTab()
  const first = makeFakeWebContents(12, "webview")
  first.hostWebContents = registry.get(0)
  engine.api.registerWebview(requested.tabId, 12, 0, requested.lifecycleGeneration)
  expect(engine.api.closeTab(requested.tabId)).toEqual({ closed: true })

  const late = makeFakeWebContents(13, "webview")
  late.hostWebContents = registry.get(0)
  expect(() => engine.api.registerWebview(requested.tabId, 13, 1, requested.lifecycleGeneration)).toThrow(
    "Rejected stale or unexpected webview registration",
  )
  expect(engine.registry.get(requested.tabId)).toBeUndefined()
})

test("old-lifetime unregister cannot detach a same-id successor lifetime", () => {
  const { engine, requestTab } = makeEngine()
  const first = requestTab()
  const firstGuest = makeFakeWebContents(16, "webview")
  firstGuest.hostWebContents = registry.get(0)
  engine.api.registerWebview(first.tabId, 16, 0, first.lifecycleGeneration)
  expect(engine.api.closeTab(first.tabId)).toEqual({ closed: true })

  // The public API normally allocates UUIDs, so exercise the lifecycle
  // coordinator directly to model a future same-id restoration/recreation.
  const lifecycle = (engine as unknown as {
    tabLifecycle: { request: (tabId: string) => number }
  }).tabLifecycle
  const successorGeneration = lifecycle.request(first.tabId)
  const successor = makeFakeWebContents(17, "webview")
  successor.hostWebContents = registry.get(0)
  engine.api.registerWebview(first.tabId, 17, 0, successorGeneration)

  // Cleanup from the old Solid/webview presentation may arrive arbitrarily
  // late. Its lifecycle epoch must make it a no-op against the successor.
  engine.api.unregisterWebview(first.tabId, 16, 0, first.lifecycleGeneration)
  expect(engine.registry.get(first.tabId)?.attached).toBe(true)
  expect(engine.registry.get(first.tabId)?.webContentsId).toBe(17)
  expect(engine.registry.get(first.tabId)?.lifecycleGeneration).toBe(successorGeneration)
})

test("crashed guest transitions logical lifecycle to detached and annotation refuses dead presentation", async () => {
  const { engine, requestTab } = makeEngine()
  const requested = requestTab()
  const guest = makeFakeWebContents(18, "webview")
  guest.hostWebContents = registry.get(0)
  engine.api.registerWebview(requested.tabId, 18, 0, requested.lifecycleGeneration)

  guest.emitEvent("render-process-gone")

  expect(engine.registry.get(requested.tabId)?.attached).toBe(false)
  const lifecycle = (engine as unknown as {
    tabLifecycle: { snapshot: (tabId: string) => { generation: number; phase: string } | undefined }
  }).tabLifecycle
  expect(lifecycle.snapshot(requested.tabId)).toEqual({
    generation: requested.lifecycleGeneration,
    phase: "detached",
  })
  await expect(engine.api.startAnnotation(requested.tabId)).resolves.toBe(null)
})

test("agent-opened tab is agent-owned on the first published attached state", async () => {
  const states: Array<{ tabId?: string; owner?: unknown }> = []
  const { engine, requests } = makeEngine((channel, payload) => {
    if (channel === "browser-state") states.push(payload as { tabId?: string; owner?: unknown })
  })
  const opened = engine.operations.dispatch(
    undefined,
    { name: "open", input: { url: "https://example.com", activate: true } },
    "sess-first-publish",
  )
  await Promise.resolve()
  const [request] = [...requests.entries()]
  if (!request) throw new Error("agent open did not request a renderer tab")
  const [tabId, lifecycleGeneration] = request
  const guest = makeFakeWebContents(14, "webview")
  guest.hostWebContents = registry.get(0)
  engine.api.registerWebview(tabId, 14, 0, lifecycleGeneration)
  await opened

  const firstPublished = states.find((state) => state.tabId === tabId)
  expect(firstPublished?.owner).toEqual({ kind: "agent", sessionId: "sess-first-publish" })
})

test("user close can revoke a requested tab before its webview attaches", () => {
  const { engine, requestTab } = makeEngine()
  const requested = requestTab()
  expect(engine.registry.get(requested.tabId)).toBeUndefined()
  expect(engine.api.closeTab(requested.tabId)).toEqual({ closed: true })

  const late = makeFakeWebContents(15, "webview")
  late.hostWebContents = registry.get(0)
  expect(() => engine.api.registerWebview(requested.tabId, 15, 0, requested.lifecycleGeneration)).toThrow(
    "Rejected stale or unexpected webview registration",
  )
})

test("closing a pending agent open rejects it immediately instead of waiting for attach timeout", async () => {
  const { engine, requests } = makeEngine()
  const opened = engine.operations.dispatch(
    undefined,
    { name: "open", input: { url: "https://example.com/pending", activate: true } },
    "sess-cancel-pending",
  )
  await Promise.resolve()
  const [request] = [...requests.entries()]
  if (!request) throw new Error("agent open did not request a renderer tab")
  const [tabId] = request

  expect(engine.api.closeTab(tabId)).toEqual({ closed: true })
  await expect(opened).rejects.toMatchObject({ tag: "BrowserControlInterrupted" })
})

test("engine startAnnotation resolves a real result for a pick with no replacement", async () => {
  const { engine, requestTab } = makeEngine()
  const requested = requestTab()
  // Guest webContents id 1, initial generation 0.
  const guest = makeFakeWebContents(1, "webview")
  guest.hostWebContents = registry.get(0)
  engine.api.registerWebview(requested.tabId, 1, 0, requested.lifecycleGeneration)

  const promise = engine.api.startAnnotation(requested.tabId)
  // Normal pick, no crop -> engine should settle with screenshot null and ack once.
  guest.emitPicked(validPayload())
  const result = await promise

  expect(result).not.toBe(null)
  expect(result?.screenshot).toBe(null)
  expect(guest.sent.filter((c) => c === ANNOTATION_CAPTURED_CHANNEL).length).toBe(1)
  engine.api.cancelAnnotation(requested.tabId)
})

test("engine: forced guest replacement mid-session cancels the pick with zero screenshot acks", async () => {
  const { engine, requestTab } = makeEngine()
  const requested = requestTab()
  // Initial registration: generation 0.
  const oldGuest = makeFakeWebContents(1, "webview")
  oldGuest.hostWebContents = registry.get(0)
  engine.api.registerWebview(requested.tabId, 1, 0, requested.lifecycleGeneration)

  // Start the annotation session through the real engine wiring. The session
  // claims the registry's current generation (0) at this moment.
  const promise = engine.api.startAnnotation(requested.tabId)

  // FORCED REPLACEMENT: the renderer unmounts the old <webview> and mounts a
  // new one for the same tab, bumping the generation past the session's claim.
  engine.api.unregisterWebview(requested.tabId, 1, 0, requested.lifecycleGeneration)
  const newGuest = makeFakeWebContents(2, "webview")
  newGuest.hostWebContents = registry.get(0)
  engine.api.registerWebview(requested.tabId, 2, 1, requested.lifecycleGeneration)

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

test("engine rewires a reused WebContents without retaining stale guest identity listeners", async () => {
  const { engine, requestTab } = makeEngine()
  const guest = makeFakeWebContents(3, "webview")
  guest.hostWebContents = registry.get(0)

  const oldTab = requestTab()
  engine.api.registerWebview(oldTab.tabId, 3, 0, oldTab.lifecycleGeneration)
  expect(guest.handlerCount("ipc-message")).toBe(1)
  engine.api.closeTab(oldTab.tabId)
  expect(guest.handlerCount("ipc-message")).toBe(0)

  const newTab = requestTab()
  engine.api.registerWebview(newTab.tabId, 3, 0, newTab.lifecycleGeneration)
  expect(guest.handlerCount("ipc-message")).toBe(1)
  guest.emitIpc(HUMAN_INPUT_CHANNEL, { kind: "pointer", x: 10, y: 10, button: 0 })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(engine.registry.get(oldTab.tabId)).toBeUndefined()
  expect(engine.arbiter.controller(oldTab.tabId)).toBe("none")
  expect(engine.registry.get(newTab.tabId)?.controller).toBe("human")
})

test("engine suppresses duplicate guest-state IPC while preserving real state transitions", () => {
  const states: unknown[] = []
  const { engine, requestTab } = makeEngine((channel, payload) => {
    if (channel === "browser-state") states.push(payload)
  })
  const requested = requestTab()
  const guest = makeFakeWebContents(4, "webview")
  guest.hostWebContents = registry.get(0)

  engine.api.registerWebview(requested.tabId, 4, 0, requested.lifecycleGeneration)
  expect(states).toHaveLength(1)
  expect(guest.handlerCount("ipc-message")).toBe(1)

  // Electron may deliver dom-ready + navigation close together. The renderer
  // coalesces these, but main also treats an identical presentation identity
  // as a true no-op so duplicate IPC cannot rewire listeners or republish.
  engine.api.registerWebview(requested.tabId, 4, 0, requested.lifecycleGeneration)
  expect(states).toHaveLength(1)
  expect(guest.handlerCount("ipc-message")).toBe(1)

  engine.registry.sync(requested.tabId)
  engine.registry.sync(requested.tabId)
  expect(states).toHaveLength(1)

  engine.registry.setMuted(requested.tabId, true)
  expect(states).toHaveLength(2)
})
