import { render } from "solid-js/web"
import { createMemoryHistory, MemoryRouter, type BaseRouterProps } from "@solidjs/router"
import type { Component } from "solid-js"
import { AppBaseProviders, AppInterface } from "../../../app/src/app"
import { PlatformProvider, type Platform } from "../../../app/src/context/platform"
import type { ServerConnection } from "../../../app/src/context/server"
import { createDesktopFetch } from "../../src/renderer/control-fetch"
import type { SidecarControlFetchInput } from "../../../app/src/utils/sidecar-control-request"

declare global {
  interface Window {
    __fullAppGateControl?: {
      dispatch: (requestID: string, input: SidecarControlFetchInput) => Promise<{
        status: number
        statusText: string
        headers: Record<string, string>
        body?: string
      }>
      cancel: (requestID: string) => void
    }
    __fullAppGate?: { run: () => Promise<Record<string, unknown>> }
    __fullAppGateOptionalHold?: boolean
    __fullAppRoute?: string
  }
}

const query = new URLSearchParams(location.search)
const moduleStartedAt = performance.now()
const baseURL = query.get("server")!
const directory = query.get("directory")!
const password = query.get("password")!
const modelControlURL = query.get("modelControl")!
const auth = `Basic ${btoa(`opencode:${password}`)}`
const sidecarOrigin = new URL(baseURL).origin
const requestCounts: Record<string, number> = {}
const heldOptional: Array<() => Promise<void>> = []
const heldOptionalPaths: string[] = []
const originalFetch = globalThis.fetch.bind(globalThis)
let sseOpens = 0
let heldOptionalCount = 0
let historyReads = 0
let partReads = 0
let sessionRootReads = 0
let usageCalls = 0
let catalogCalls = 0
const shouldHoldOptional = (url: URL) => url.pathname === "/fork/credential" || url.pathname === "/fork/usage"
const rendererErrors: string[] = []
const consoleErrors: string[] = []
const responseStatuses: Record<string, number> = {}
const streamInterestRequests: Array<{ at: number; body?: unknown; status?: number; acknowledgement?: unknown }> = []
const decodedEventFrames: Array<{ type: string; sessionID?: string; payloadPreview?: string }> = []
const historyResponses: Array<{ path: string; status: number; messageCount: number; partCount: number }> = []
const streamInterestRequest = new WeakMap<Request, (typeof streamInterestRequests)[number]>()
const recordResponse = (request: Request, status: number, responseBody?: string) => {
  const key = `${request.method} ${new URL(request.url).pathname} ${status}`
  responseStatuses[key] = (responseStatuses[key] ?? 0) + 1
  if (responseBody !== undefined) recordResponseBody(request, status, responseBody)
}
const recordResponseBody = (request: Request, status: number, responseBody: string) => {
  const interest = streamInterestRequest.get(request)
  if (interest) {
    interest.status = status
    if (responseBody) {
      try { interest.acknowledgement = JSON.parse(responseBody) } catch { interest.acknowledgement = responseBody.slice(0, 300) }
    }
  }
  const url = new URL(request.url)
  if (request.method === "GET" && /\/message(?:\/|$)/.test(url.pathname) && responseBody !== undefined) {
    try {
      const parsed = JSON.parse(responseBody) as unknown
      const messages = Array.isArray(parsed) ? parsed : []
      historyResponses.push({
        path: url.pathname,
        status,
        messageCount: messages.length,
        partCount: messages.reduce((total, message) => total + ((message as { parts?: unknown[] })?.parts?.length ?? 0), 0),
      })
    } catch {
      historyResponses.push({ path: url.pathname, status, messageCount: -1, partCount: -1 })
    }
  }
}
const recordInterestRequest = (request: Request) => {
  const url = new URL(request.url)
  if (request.method !== "POST" || url.pathname !== "/global/event/interest") return
  const item: (typeof streamInterestRequests)[number] = { at: performance.now() }
  streamInterestRequests.push(item)
  streamInterestRequest.set(request, item)
  void request.clone().text().then((value) => { item.body = JSON.parse(value) }).catch((error) => { item.body = `unreadable: ${String(error)}` })
}
const observeEventStream = (response: Response) => {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response
  const [application, observer] = response.body.tee()
  void (async () => {
    const reader = observer.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        buffered += decoder.decode(value, { stream: !done })
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffered)
          if (!boundary || boundary.index === undefined) break
          const frame = buffered.slice(0, boundary.index)
          buffered = buffered.slice(boundary.index + boundary[0].length)
          const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
          if (!data || data === "[DONE]") continue
          try {
            const raw = JSON.parse(data) as Record<string, any>
            const event = (raw.payload && typeof raw.payload === "object" ? raw.payload : raw) as Record<string, any>
            const properties = (event.properties && typeof event.properties === "object" ? event.properties : event.data) as Record<string, any> | undefined
            decodedEventFrames.push({
              type: String(event.type ?? "unknown"),
              sessionID: typeof properties?.sessionID === "string" ? properties.sessionID : undefined,
              payloadPreview: properties ? JSON.stringify(properties).slice(0, 240) : undefined,
            })
          } catch {
            decodedEventFrames.push({ type: "unparseable" })
          }
        }
        if (done) break
      }
    } catch (error) {
      decodedEventFrames.push({ type: `observer-error:${String(error)}` })
    } finally {
      reader.releaseLock()
    }
  })()
  return new Response(application, { status: response.status, statusText: response.statusText, headers: response.headers })
}
const recordFetchResponse = (request: Request, response: Response) => {
  recordResponse(request, response.status)
  if (request.method === "GET" && /\/message(?:\/|$)/.test(new URL(request.url).pathname)) {
    void response.clone().text().then((text) => recordResponseBody(request, response.status, text))
  }
  return observeEventStream(response)
}
let maxFrameGapMs = 0
let lastFrameAt = performance.now()
const sampleFrame = () => {
  const now = performance.now()
  maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrameAt)
  lastFrameAt = now
  requestAnimationFrame(sampleFrame)
}
requestAnimationFrame(sampleFrame)
window.addEventListener("error", (event) => rendererErrors.push(`${event.message} at ${event.filename}:${event.lineno}`))
window.addEventListener("unhandledrejection", (event) => rendererErrors.push(String(event.reason)))
window.addEventListener("vite:preloadError", (event) => rendererErrors.push(`dynamic import failed: ${String((event as CustomEvent).detail)}`))
const originalConsoleError = console.error.bind(console)
console.error = (...values: unknown[]) => {
  consoleErrors.push(values.map((value) => value instanceof Error ? value.stack ?? value.message : String(value)).join(" "))
  originalConsoleError(...values)
}
let longAnimationFrames = 0
let maxLongAnimationFrameMs = 0
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longAnimationFrames++
      maxLongAnimationFrameMs = Math.max(maxLongAnimationFrameMs, entry.duration)
    }
  }).observe({ type: "long-animation-frame", buffered: true } as PerformanceObserverInit)
} catch {}
const rootReadsByDirectory: Record<string, number> = {}
const historyPaths: string[] = []
const observed = (request: Request) => {
  const url = new URL(request.url)
  if (url.origin !== sidecarOrigin) return
  const path = url.pathname
  requestCounts[`${request.method} ${path}`] = (requestCounts[`${request.method} ${path}`] ?? 0) + 1
  recordInterestRequest(request)
  if (request.method === "GET" && (path === "/global/event" || path === "/api/event")) sseOpens++
  if (path === "/global/session/roots") {
    const rootDirectory = url.searchParams.get("directory")
    if (rootDirectory) {
      sessionRootReads++
      rootReadsByDirectory[rootDirectory] = (rootReadsByDirectory[rootDirectory] ?? 0) + 1
    }
  }
  if (/\/message(?:\/|$)/.test(path) || /\/messages(?:\/|$)/.test(path)) { historyReads++; historyPaths.push(path) }
  if (/\/part(?:\/|$)/.test(path)) partReads++
  if (/usage|quota/i.test(path)) usageCalls++
  if (/provider|catalog|model/i.test(path)) catalogCalls++
}
const authenticatedFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== sidecarOrigin) return originalFetch(request)
  observed(request)
  if (window.__fullAppGateOptionalHold && shouldHoldOptional(url)) {
    heldOptionalCount++
      heldOptionalPaths.push(url.pathname)
      return new Promise<Response>((resolve, reject) => heldOptional.push(() => {
        const headers = new Headers(request.headers)
        headers.set("authorization", auth)
        return originalFetch(new Request(request, { headers })).then((response) => {
          resolve(recordFetchResponse(request, response))
        }, reject)
      }))
  }
  const headers = new Headers(request.headers)
  headers.set("authorization", auth)
  try {
    const response = await originalFetch(new Request(request, { headers }))
    return recordFetchResponse(request, response)
  } catch (error) {
    if (!request.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
      rendererErrors.push(`fetch failed ${request.method} ${url.pathname}: ${String(error)}`)
    }
    throw error
  }
}
// Production's loopback event stream intentionally uses the webview fetch
// path. Wrap that path too so SSE is counted and authenticated exactly once
// by this fixture, while all non-sidecar requests retain the original fetch.
globalThis.fetch = authenticatedFetch
const desktopFetch = createDesktopFetch({
  fetch: authenticatedFetch,
  awaitInitialization: async () => ({ url: baseURL, username: "opencode", password }),
  dispatch: (requestID, input) => {
    if (!window.__fullAppGateControl) throw new Error("full-app test control bridge is unavailable")
    const request = new Request(input.url, { method: input.method, headers: input.headers, body: input.body })
    observed(request)
    const url = new URL(input.url)
    if (window.__fullAppGateOptionalHold && shouldHoldOptional(url)) {
      heldOptionalCount++
      heldOptionalPaths.push(url.pathname)
      return new Promise((resolve, reject) => heldOptional.push(() => {
        return window.__fullAppGateControl!.dispatch(requestID, input).then((response) => {
          recordResponse(request, response.status, response.body)
          resolve(response)
        }, reject)
      }))
    }
    return window.__fullAppGateControl.dispatch(requestID, input).then((response) => {
      recordResponse(request, response.status, response.body)
      return response
    })
  },
  cancel: (requestID) => window.__fullAppGateControl?.cancel(requestID),
})

// Persisted app state uses Chromium localStorage in this isolated Electron
// profile, with the same name:key partition used by the app's web fallback.
const storage = (name = "default.dat") => ({
  getItem: (key: string) => localStorage.getItem(`${name}:${key}`),
  setItem: (key: string, value: string) => localStorage.setItem(`${name}:${key}`, value),
  removeItem: (key: string) => localStorage.removeItem(`${name}:${key}`),
})
const serverKey = baseURL.replace(/\/+$/, "")
storage("opencode.global.dat").setItem("server", JSON.stringify({
  list: [],
  projects: { local: [{ worktree: directory, expanded: true }] },
  lastProject: { local: directory },
  recentlyClosed: {},
}))
const platform = {
  platform: "desktop",
  os: "windows",
  fetch: desktopFetch,
  storage,
  openDirectoryPickerDialog: async () => null,
  openExternal: () => undefined,
  refresh: async () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
  getDefaultServer: async () => serverKey,
} as unknown as Platform
const connection = {
  type: "http",
  http: { url: serverKey, username: "opencode", password },
} as ServerConnection.Any
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const within = async <T,>(promise: Promise<T>, ms: number, message: string): Promise<T> => Promise.race([
  promise,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
])
const waitFor = async (predicate: () => boolean, message: string | (() => string), ms = 20_000) => {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {
    if (predicate()) return
    await frame()
  }
  throw new Error(typeof message === "function" ? message() : message)
}
const sidecar = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set("authorization", auth)
  return platform.fetch!(`${baseURL}${path.replace(/^\//, "")}`, { ...init, headers })
}
const waitSessionsIdle = async (ids: string[]) => {
  const deadline = performance.now() + 15_000
  let latest: Record<string, { type?: string }> = {}
  while (performance.now() < deadline) {
    const response = await sidecar(`session/status?directory=${encodeURIComponent(directory)}`)
    if (!response.ok) throw new Error(`Tier 0 session-status projection failed (${response.status})`)
    latest = await response.json() as Record<string, { type?: string }>
    if (ids.every((id) => latest[id]?.type !== "busy")) return latest
    await new Promise<void>((resolve) => setTimeout(resolve, 75))
  }
  throw new Error(`working session owners did not converge to idle: ${JSON.stringify(latest)}`)
}
const snapshot = () => ({
  path: window.__fullAppRoute ?? "/",
  visibleBodyText: document.body.innerText,
  sessionTurns: [...document.querySelectorAll<HTMLElement>("[data-component='session-turn']")].map((element) => ({
    text: element.innerText.slice(0, 360),
    messageID: element.dataset.messageId ?? element.getAttribute("data-message-id"),
    owner: element.getAttribute("data-owner"),
  })),
  tabState: [...document.querySelectorAll<HTMLElement>("[data-titlebar-tab]")].map((element) => ({
    text: element.innerText,
    selected: element.getAttribute("aria-selected") ?? element.hasAttribute("data-active"),
  })),
  streamInterestRequests: streamInterestRequests.map((item) => ({ ...item })),
  decodedEventFrames: [...decodedEventFrames],
  historyResponses: [...historyResponses],
  rows: [...document.querySelectorAll<HTMLElement>("[data-component='home-session-row']")].map((element) => element.innerText),
  tabs: document.querySelectorAll("[data-titlebar-tab]").length,
  sseOpens,
  sessionRootReads,
  historyReads,
  partReads,
  usageCalls,
  catalogCalls,
  heldOptionalCount,
  heldOptionalPaths: [...heldOptionalPaths],
  rootReadsByDirectory: { ...rootReadsByDirectory },
  historyPaths: [...historyPaths],
  rendererErrors: [...rendererErrors],
  consoleErrors: [...consoleErrors],
  responseStatuses: { ...responseStatuses },
  maxFrameGapMs,
  longAnimationFrames,
  maxLongAnimationFrameMs,
  visibleAlerts: [...document.querySelectorAll<HTMLElement>("[role='alert']")].map((element) => element.innerText),
  requestCounts: { ...requestCounts },
})
const desktopRouter: Component<BaseRouterProps> = (props) => {
  const history = createMemoryHistory()
  window.__fullAppRoute = history.get()
  history.listen((value) => { window.__fullAppRoute = value })
  return <MemoryRouter {...props} history={history} />
}

render(() => (
  <PlatformProvider value={platform}>
    <AppBaseProviders>
      <AppInterface
        defaultServer={serverKey}
        canonicalLocalServer={serverKey}
        servers={[connection]}
        includeStoredServers={false}
        disableHealthCheck
        router={desktopRouter}
      />
    </AppBaseProviders>
  </PlatformProvider>
), document.getElementById("root")!)

window.__fullAppGate = {
  async run() {
    const runStartedAt = performance.now()
    await waitFor(() => document.querySelector("[data-component='home-session-scroll-track']") !== null ||
      document.querySelector("[data-component='home-session-row']") !== null ||
      document.body.innerText.toLowerCase().includes("recent sessions"), () =>
      `production Home did not mount; route=${window.__fullAppRoute}; body=${JSON.stringify(document.body.innerText.slice(0, 1600))}; errors=${JSON.stringify(rendererErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}; requests=${JSON.stringify(requestCounts)}; roots=${JSON.stringify(rootReadsByDirectory)}`)
    if ((window.__fullAppRoute ?? "/") !== "/") throw new Error(`cold app did not remain on Home: ${window.__fullAppRoute}`)
    await waitFor(() => sessionRootReads > 0, "cold Home did not finish its bounded project-root read")
    const missingDirectory = await sidecar("global/session/roots?limit=8")
    const malformedDirectory = await sidecar("global/session/roots?directory=&limit=8")
    const locationFailures = [missingDirectory.status, malformedDirectory.status]
    if (missingDirectory.ok || malformedDirectory.ok) {
      throw new Error(`global root reads must fail closed without a valid directory: ${locationFailures.join(",")}`)
    }
    const cold = snapshot()
    const coldElapsedMs = performance.now() - moduleStartedAt
    const coldSinceGateMs = performance.now() - runStartedAt

    // The sidecar creates this row through its real POST /session API while the
    // production Home stays mounted. No draft route or tab API is invoked.
    const rowCreateStartedAt = performance.now()
    const created = await sidecar(`session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "full-app-first-project-row" }),
    })
    const createdText = await created.text()
    if (!created.ok) throw new Error(`sidecar session creation failed (${created.status}): ${createdText}`)
    const first = JSON.parse(createdText) as { id: string }
    await waitFor(() => [...document.querySelectorAll<HTMLElement>("[data-component='home-session-row']")]
      .some((element) => element.innerText.includes("full-app-first-project-row")),
    "new session did not become visible on Home through the global index/event owner")
    if ((window.__fullAppRoute ?? "/") !== "/") throw new Error("newly visible session changed route before the user selected it")
    if (document.querySelectorAll("[data-titlebar-tab]").length !== 0) throw new Error("row visibility created a session tab")
    const visibleBeforeSelect = snapshot()
    const rowVisibilityMs = performance.now() - rowCreateStartedAt

    // Only after cold Home and row visibility have been measured may optional
    // background work be held; session and global-event paths stay live.
    window.__fullAppGateOptionalHold = true
    const row = [...document.querySelectorAll<HTMLButtonElement>("[data-component='home-session-row']")]
      .find((element) => element.innerText.includes("full-app-first-project-row"))
    if (!row) throw new Error("visible Home row disappeared before selection")
    const detailOpenStartedAt = performance.now()
    row.click()
    await waitFor(() => (window.__fullAppRoute ?? "").includes(`/session/${first.id}`), "actual Home row click did not open session detail")
    await waitFor(() => document.querySelector("[data-component='prompt-input']") !== null, () =>
      `selected detail composer did not mount; route=${window.__fullAppRoute}; counts=${JSON.stringify(requestCounts)}; statuses=${JSON.stringify(responseStatuses)}; historyPaths=${JSON.stringify(historyPaths)}; body=${JSON.stringify(document.body.innerText.slice(0, 1800))}; fields=${JSON.stringify([...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")].map((element) => element.value))}; errors=${JSON.stringify(rendererErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`)
    await waitFor(() => streamInterestRequests.some((item) => {
      const body = item.body as { generation?: number; sessions?: string[] } | undefined
      const ack = item.acknowledgement as { updated?: boolean; generation?: number } | undefined
      return body?.sessions?.includes(first.id) && ack?.updated === true && ack.generation === body.generation
    }), () => `selected route did not receive an acknowledged session-interest generation for ${first.id}; interest=${JSON.stringify(streamInterestRequests)}`)
    const selected = snapshot()
    const detailReadyMs = performance.now() - detailOpenStartedAt

    const scenarios: Array<Record<string, unknown>> = []
    for (const count of [1, 3, 6]) {
      const ids = [first.id]
      for (let index = ids.length; index < count; index++) {
        const response = await sidecar(`session?directory=${encodeURIComponent(directory)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: `full-app-working-${count}-${index}` }),
        })
        const body = await response.text()
        if (!response.ok) throw new Error(`session fixture create failed (${response.status}): ${body}`)
        ids.push((JSON.parse(body) as { id: string }).id)
      }
      const startedBefore = performance.now()
      const prompts = await Promise.all(ids.map((id) => sidecar(`session/${encodeURIComponent(id)}/prompt_async?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "full-app-gate", modelID: "gate-model" }, parts: [{ type: "text", text: `full-app-gate-${id}-cycle-${count}` }] }),
      })))
      const statuses = prompts.map((response) => response.status)
      if (statuses.some((status) => status !== 204)) throw new Error(`session streams were not admitted: ${statuses.join(",")}`)
      const admittedAt = performance.now()
      const release = await originalFetch(`${modelControlURL}gate/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessions: ids.map((id) => ({ id, cycle: count })) }),
      })
      if (!release.ok) throw new Error(`mock model stream release failed (${release.status})`)
      const released = await release.json() as { missing?: string[] }
      if (released.missing?.length) throw new Error(`mock model did not observe streams: ${released.missing.join(",")}`)
      const releaseCompletedAt = performance.now()
      const uniqueTail = `full-app-gate-tail-${first.id}-cycle-${count}`
      await waitFor(() => document.body.innerText.includes(uniqueTail),
        () => {
          const current = snapshot()
          return `selected detail stream did not render for concurrency ${count}; expected=${uniqueTail}; route=${current.path}; bodyTail=${JSON.stringify(current.visibleBodyText.slice(-2400))}; turns=${JSON.stringify(current.sessionTurns)}; tabs=${JSON.stringify(current.tabState)}; interest=${JSON.stringify(current.streamInterestRequests)}; eventFrames=${JSON.stringify(current.decodedEventFrames.slice(-80))}; historyResponses=${JSON.stringify(current.historyResponses)}; requestCounts=${JSON.stringify(current.requestCounts)}; statuses=${JSON.stringify(current.responseStatuses)}; historyPaths=${JSON.stringify(current.historyPaths)}; errors=${JSON.stringify(current.rendererErrors)}; consoleErrors=${JSON.stringify(current.consoleErrors)}`
        }, 30_000)
      const selectedTailAt = performance.now()
      const idle = await waitSessionsIdle(ids)
      const idleAt = performance.now()
      const view = snapshot()
      if (view.tabs > 1) throw new Error(`background session fanout opened extra tabs at concurrency ${count}`)
      if (!view.historyPaths.every((path) => path.includes(first.id))) {
        throw new Error(`background session history loaded while unopened at concurrency ${count}: ${view.historyPaths.join(",")}`)
      }
      scenarios.push({
        count, ids, statuses,
        admissionMs: admittedAt - startedBefore,
        releaseWaitMs: releaseCompletedAt - admittedAt,
        selectedTailMs: selectedTailAt - releaseCompletedAt,
        idleConvergenceMs: idleAt - selectedTailAt,
        uniqueTail,
        idle,
        view,
      })
    }
    const releaseHeld = heldOptional.splice(0)
    window.__fullAppGateOptionalHold = false
    await Promise.all(releaseHeld.map((release) => release()))
    return { cold, coldElapsedMs, coldSinceGateMs, rowVisibilityMs, locationFailures, visibleBeforeSelect, selected, detailReadyMs, scenarios, final: snapshot(), heldOptionalCount, heldOptionalPaths: [...heldOptionalPaths] }
  },
}
