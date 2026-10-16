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
      traceStart: (scenario: string) => Promise<{ scenario: string; startedAt: number }>
      traceStop: (scenario: string) => Promise<Record<string, unknown>>
      restartSidecar: () => Promise<{ pid?: number }>
      profileStopStartup: () => Promise<Record<string, unknown>>
      clickStop: (input: { x: number; y: number }) => Promise<{ requestedAt: number; dispatchedAt: number }>
      seedLargeHistory: (input: { sessionID: string; messageID: string; count: number }) => Promise<{ messageID: string; parts: number; elapsedMs: number }>
    }
    __fullAppGate?: { run: () => Promise<Record<string, unknown>> }
    __fullAppGateOptionalHold?: boolean
    __fullAppGateDraftProviderHold?: boolean
    __fullAppGateDraftAuxHold?: boolean
    __fullAppGateHoldPartDetail?: boolean
    __fullAppGateHoldEventStream?: boolean
    __fullAppGateHeldEventStreamCount?: () => number
    __fullAppGateReleaseEventStream?: () => Promise<void>
    __fullAppGateGapRepairCalls?: string[][]
    __fullAppGateHeldPartDetailCount?: () => number
    __fullAppGateReleasePartDetail?: () => Promise<void>
    __fullAppGateReleaseNewSessionFeatures?: () => void
    __fullAppRoute?: string
    __fullAppRouteBack?: () => void
    __fullAppGateReadServerSession?: (sessionID: string) => unknown
    __fullAppGateReadLiveReasoning?: (sessionID: string) => unknown
    __fullAppGateReadTimeline?: (sessionID: string) => unknown
    __fullAppGateReadTimelineRenderer?: (sessionID: string) => unknown
    __fullAppGateReadTimelineCounts?: (sessionID: string) => unknown
    __fullAppGateInjectParts?: (sessionID: string, messageID: string, count: number) => void
    __fullAppGateScrollTimeline?: (sessionID: string, direction: "up" | "bottom") => Promise<Record<string, unknown>>
    __fullAppGateApplyEvents?: unknown[]
    __fullAppGateLoadedModules?: string[]
    __fullAppGateTraceTimelineSizeWrite?: (entry: Record<string, unknown>) => void
    __fullAppGateReactiveWork?: {
      start: () => void
      count: (name: string, amount?: number) => void
      beginFlush: () => number | undefined
      event: (flushID: number | undefined, type: string, sessionID?: string) => void
      endFlush: (flushID: number | undefined, processed: number, elapsedMs: number) => void
      stop: () => Record<string, unknown>
      snapshot: () => Record<string, unknown>
      sameSemanticUsers: (name: string, a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => boolean
    }
    __fullAppGateStopClickHandledAt?: number
  }
}

const query = new URLSearchParams(location.search)
const moduleStartedAt = performance.now()
const baseURL = query.get("server")!
const directory = query.get("directory")!
const password = query.get("password")!
const modelControlURL = query.get("modelControl")!
const reasoningOnly = query.get("reasoningOnly") === "1"
const startupOnly = query.get("startupOnly") === "1"
const profileStartup = query.get("profileStartup") === "1"
const preNavigationTrace = query.get("preNavigationTrace") === "1"
const startupTraceStart = profileStartup && preNavigationTrace
  ? Promise.resolve(undefined)
  : profileStartup
  ? window.__fullAppGateControl!.traceStart("startup")
  : undefined
const startupTraceClockMark = startupTraceStart?.then(() => {
  const perfNow = performance.now()
  performance.mark("full-app-gate:startup-profile-clock")
  return { perfNow, markName: "full-app-gate:startup-profile-clock" }
})
const auth = `Basic ${btoa(`opencode:${password}`)}`
const sidecarOrigin = new URL(baseURL).origin
const requestCounts: Record<string, number> = {}
const heldOptional: Array<() => Promise<void>> = []
const heldOptionalPaths: string[] = []
const heldDraftProvider: Array<() => Promise<void>> = []
const heldDraftAux: Array<() => Promise<void>> = []
const heldDraftAuxPaths: string[] = []
const heldPartDetail: Array<() => Promise<void>> = []
const heldEventStreams: Array<() => Promise<void>> = []
const originalFetch = globalThis.fetch.bind(globalThis)
let sseOpens = 0
let heldOptionalCount = 0
let historyReads = 0
let partReads = 0
let partDetailReads = 0
let sessionRootReads = 0
let usageCalls = 0
let catalogCalls = 0
const shouldHoldOptional = (url: URL) => url.pathname === "/fork/credential" || url.pathname === "/fork/usage"
const shouldHoldDraftAux = (url: URL) => url.pathname === "/api/reference" || url.pathname === "/api/skill"
const rendererErrors: string[] = []
const resizeObserverWarnings: string[] = []
const resizeObserverCallbacks: Array<Record<string, unknown>> = []
const timelineSizeWrites: Array<Record<string, unknown>> = []
window.__fullAppGateTraceTimelineSizeWrite = (entry) => {
  timelineSizeWrites.push(entry)
  if (timelineSizeWrites.length > 2_000) timelineSizeWrites.splice(0, timelineSizeWrites.length - 2_000)
}
const consoleErrors: string[] = []
const consoleErrorRecords: Array<{ at: number; text: string }> = []
const responseStatuses: Record<string, number> = {}
const requestStartedAt = new WeakMap<Request, number>()
const requestStartedWallAt = new WeakMap<Request, number>()
const requestTimings: Array<{ method: string; path: string; status: number; startedAt: number; elapsedMs: number }> = []
const requestFailures: Array<{ method: string; path: string; at: number; error: string }> = []
let controlledSidecarRestartWindow = false
const controlAcks: Array<{ method: string; path: string; status: number; startedAt?: number; at: number; body?: unknown }> = []
const streamInterestRequests: Array<{ at: number; body?: unknown; status?: number; acknowledgement?: unknown }> = []
const decodedEventFrames: Array<{ at: number; type: string; sessionID?: string; payloadPreview?: string }> = []
const reactiveWorkCounters: Record<string, number> = {}
const reactiveWorkFlushes: Array<Record<string, unknown>> = []
let reactiveWorkEnabled = false
let activeReactiveFlush:
  | { id: number; startedAt: number; processed: number; eventCounts: Record<string, number>; sessionIDs: Set<string>; counters: Record<string, number> }
  | undefined
let reactiveFlushID = 0
window.__fullAppGateReactiveWork = {
  start: () => {
    reactiveWorkEnabled = true
    activeReactiveFlush = undefined
    reactiveFlushID = 0
    reactiveWorkFlushes.length = 0
    for (const key of Object.keys(reactiveWorkCounters)) delete reactiveWorkCounters[key]
  },
  count: (name, amount = 1) => {
    if (!reactiveWorkEnabled || !Number.isFinite(amount) || amount <= 0) return
    reactiveWorkCounters[name] = (reactiveWorkCounters[name] ?? 0) + amount
    if (activeReactiveFlush) activeReactiveFlush.counters[name] = (activeReactiveFlush.counters[name] ?? 0) + amount
  },
  beginFlush: () => {
    if (!reactiveWorkEnabled) return
    const active = {
      id: ++reactiveFlushID,
      startedAt: performance.now(),
      processed: 0,
      eventCounts: {} as Record<string, number>,
      sessionIDs: new Set<string>(),
      counters: {} as Record<string, number>,
    }
    activeReactiveFlush = active
    return active.id
  },
  event: (flushID, type, sessionID) => {
    if (!reactiveWorkEnabled || !activeReactiveFlush || activeReactiveFlush.id !== flushID) return
    activeReactiveFlush.eventCounts[type] = (activeReactiveFlush.eventCounts[type] ?? 0) + 1
    if (sessionID) activeReactiveFlush.sessionIDs.add(sessionID)
  },
  endFlush: (flushID, processed, elapsedMs) => {
    const active = activeReactiveFlush
    if (!reactiveWorkEnabled || !active || active.id !== flushID) return
    active.processed = processed
    reactiveWorkFlushes.push({
      id: active.id,
      startedAt: active.startedAt,
      elapsedMs,
      processed,
      eventCounts: active.eventCounts,
      sessionIDs: [...active.sessionIDs].slice(0, 8),
      counters: active.counters,
    })
    if (reactiveWorkFlushes.length > 2_000) reactiveWorkFlushes.shift()
    activeReactiveFlush = undefined
  },
  snapshot: () => ({
    totals: { ...reactiveWorkCounters },
    flushCount: reactiveWorkFlushes.length,
    flushes: [...reactiveWorkFlushes],
  }),
  stop: () => {
    reactiveWorkEnabled = false
    activeReactiveFlush = undefined
    return window.__fullAppGateReactiveWork?.snapshot() ?? {}
  },
  sameSemanticUsers: (name, a, b) => {
    window.__fullAppGateReactiveWork?.count(`${name}Calls`)
    if (a === b) return true
    if (!a || !b || a.length !== b.length) return false
    for (let index = 0; index < a.length; index++) {
      window.__fullAppGateReactiveWork?.count(`${name}Comparisons`)
      if (a[index] !== b[index]) return false
    }
    return true
  },
}
const gateMark = (name: string) => performance.mark(`full-app-gate:${name}`)
const historyResponses: Array<{ path: string; status: number; messageCount: number; partCount: number; bytes: number; windowed: string | null }> = []
const partDetailResponses: Array<{
  path: string
  status: number
  bytes: number
  pageCount: number
  maxSliceCodePoints: number
  partIDs: string[]
  offsets: number[]
  nextCursor?: string
  cursor?: string
}> = []
const streamInterestRequest = new WeakMap<Request, (typeof streamInterestRequests)[number]>()
const recordResponse = (request: Request, status: number, responseBody?: string, responseHeaders?: HeadersInit) => {
  const url = new URL(request.url)
  const key = `${request.method} ${url.pathname} ${status}`
  responseStatuses[key] = (responseStatuses[key] ?? 0) + 1
  if (/\/(?:abort|interrupt)$/.test(url.pathname)) {
    let body: unknown
    if (responseBody !== undefined) {
      try { body = JSON.parse(responseBody) } catch { body = responseBody.slice(0, 200) }
    }
    controlAcks.push({ method: request.method, path: url.pathname, status, startedAt: requestStartedWallAt.get(request), at: Date.now(), body })
  }
  const startedAt = requestStartedAt.get(request)
  if (startedAt !== undefined) requestTimings.push({ method: request.method, path: url.pathname, status, startedAt, elapsedMs: performance.now() - startedAt })
  if (responseBody !== undefined) recordResponseBody(request, status, responseBody, responseHeaders)
}
const recordResponseBody = (request: Request, status: number, responseBody: string, responseHeaders?: HeadersInit) => {
  const interest = streamInterestRequest.get(request)
  if (interest) {
    interest.status = status
    if (responseBody) {
      try { interest.acknowledgement = JSON.parse(responseBody) } catch { interest.acknowledgement = responseBody.slice(0, 300) }
    }
  }
  const url = new URL(request.url)
  if (request.method === "GET" && /\/message\/[^/]+\/parts$/.test(url.pathname) && responseBody !== undefined) {
    try {
      const parsed = JSON.parse(responseBody) as {
        data?: Array<{ partID?: string; offset?: number; text?: string }>
        nextCursor?: string
      }
      const data = parsed.data ?? []
      partDetailResponses.push({
        path: url.pathname,
        status,
        bytes: new TextEncoder().encode(responseBody).byteLength,
        pageCount: data.length,
        maxSliceCodePoints: Math.max(0, ...data.map((item) => Array.from(item.text ?? "").length)),
        partIDs: data.map((item) => String(item.partID ?? "")),
        offsets: data.map((item) => Number(item.offset ?? -1)),
        nextCursor: parsed.nextCursor,
        cursor: url.searchParams.get("cursor") ?? undefined,
      })
    } catch {
      partDetailResponses.push({
        path: url.pathname,
        status,
        bytes: new TextEncoder().encode(responseBody).byteLength,
        pageCount: -1,
        maxSliceCodePoints: -1,
        partIDs: [],
        offsets: [],
        cursor: url.searchParams.get("cursor") ?? undefined,
      })
    }
    return
  }
  if (request.method === "GET" && /\/message(?:\/|$)/.test(url.pathname) && responseBody !== undefined) {
    try {
      const parsed = JSON.parse(responseBody) as unknown
      const messages = Array.isArray(parsed) ? parsed : []
      historyResponses.push({
        path: url.pathname,
        status,
        messageCount: messages.length,
        partCount: messages.reduce((total, message) => total + ((message as { parts?: unknown[] })?.parts?.length ?? 0), 0),
        bytes: new TextEncoder().encode(responseBody).byteLength,
        windowed: new Headers(responseHeaders).get("x-windowed-messages"),
      })
    } catch {
      historyResponses.push({ path: url.pathname, status, messageCount: -1, partCount: -1, bytes: new TextEncoder().encode(responseBody).byteLength, windowed: new Headers(responseHeaders).get("x-windowed-messages") })
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
              at: performance.now(),
              type: String(event.type ?? "unknown"),
              sessionID: typeof properties?.sessionID === "string" ? properties.sessionID : undefined,
              payloadPreview: properties ? JSON.stringify(properties).slice(0, 240) : undefined,
            })
            gateMark(`event:${String(event.type ?? "unknown")}`)
            if (/lsp/i.test(String(event.type ?? ""))) console.info("FULL_APP_GATE_LSP_EVENT", JSON.stringify(decodedEventFrames.at(-1)))
          } catch {
            decodedEventFrames.push({ at: performance.now(), type: "unparseable" })
          }
        }
        if (done) break
      }
    } catch (error) {
      decodedEventFrames.push({ at: performance.now(), type: `observer-error:${String(error)}` })
    } finally {
      reader.releaseLock()
    }
  })()
  return new Response(application, { status: response.status, statusText: response.statusText, headers: response.headers })
}
const recordFetchResponse = (request: Request, response: Response) => {
  recordResponse(request, response.status)
  if (request.method === "GET" && /\/message(?:\/|$)/.test(new URL(request.url).pathname)) {
    void response.clone().text().then((text) => recordResponseBody(request, response.status, text, response.headers))
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
window.addEventListener("error", (event) => {
  const detail = `${event.message} at ${event.filename}:${event.lineno}`
  if (event.message === "ResizeObserver loop completed with undelivered notifications.") {
    const at = performance.now()
    resizeObserverWarnings.push(detail)
    ;((window as any).__fullAppGateResizeObserverWarnings ??= []).push({
      at,
      recent: resizeObserverCallbacks.filter((callback) => at - Number(callback.at) < 100).slice(-20),
    })
  }
  else rendererErrors.push(detail)
})
window.addEventListener("unhandledrejection", (event) => rendererErrors.push(String(event.reason)))
window.addEventListener("vite:preloadError", (event) => rendererErrors.push(`dynamic import failed: ${String((event as CustomEvent).detail)}`))
const originalConsoleError = console.error.bind(console)
console.error = (...values: unknown[]) => {
  const text = values.map((value) => value instanceof Error ? value.stack ?? value.message : String(value)).join(" ")
  consoleErrors.push(text)
  consoleErrorRecords.push({ at: performance.now(), text })
  originalConsoleError(...values)
}
let longAnimationFrames = 0
let maxLongAnimationFrameMs = 0
const longAnimationFrameTrace: Array<Record<string, unknown>> = []
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const value = entry as PerformanceEntry & Record<string, any>
      longAnimationFrames++
      maxLongAnimationFrameMs = Math.max(maxLongAnimationFrameMs, entry.duration)
      longAnimationFrameTrace.push({
        scenario: (window as any).__fullAppGateScenario ?? "startup",
        startTime: entry.startTime,
        duration: entry.duration,
        blockingDuration: value.blockingDuration,
        renderStart: value.renderStart,
        styleAndLayoutStart: value.styleAndLayoutStart,
        scripts: (value.scripts ?? []).map((script: Record<string, any>) => ({
          duration: script.duration,
          invoker: script.invoker,
          invokerType: script.invokerType,
          sourceURL: script.sourceURL,
          sourceFunctionName: script.sourceFunctionName,
          forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
        })),
      })
      if (longAnimationFrameTrace.length > 40) longAnimationFrameTrace.shift()
    }
  }).observe({ type: "long-animation-frame", buffered: true } as PerformanceObserverInit)
} catch {}
const rootReadsByDirectory: Record<string, number> = {}
const sessionRootRequests: Array<{ directory: string | null; projectID: string | null; stack: string }> = []
const historyPaths: string[] = []
const observedRequests: Array<{
  at: number
  atWall: number
  method: string
  path: string
  directory: string | null
  locationDirectory: string | null
  directoryHeader: string | null
}> = []
const observed = (request: Request) => {
  const url = new URL(request.url)
  if (url.origin !== sidecarOrigin) return
  const path = url.pathname
  const encodedDirectoryHeader = request.headers.get("x-opencode-directory")
  let directoryHeader = encodedDirectoryHeader
  if (encodedDirectoryHeader) {
    try { directoryHeader = decodeURIComponent(encodedDirectoryHeader) } catch {}
  }
  observedRequests.push({
    at: performance.now(),
    atWall: Date.now(),
    method: request.method,
    path,
    directory: url.searchParams.get("directory"),
    locationDirectory: url.searchParams.get("location[directory]"),
    directoryHeader,
  })
  if (path === "/lsp") console.info("FULL_APP_GATE_LSP_REQUEST", JSON.stringify({ at: observedRequests.at(-1)?.at, precedingEvents: decodedEventFrames.slice(-20) }))
  requestStartedAt.set(request, performance.now())
  requestStartedWallAt.set(request, Date.now())
  requestCounts[`${request.method} ${path}`] = (requestCounts[`${request.method} ${path}`] ?? 0) + 1
  recordInterestRequest(request)
  if (request.method === "GET" && (path === "/global/event" || path === "/api/event")) sseOpens++
   if (path === "/global/session/roots") {
     const rootDirectory = url.searchParams.get("directory")
     sessionRootRequests.push({
       directory: rootDirectory,
       projectID: url.searchParams.get("projectID"),
       stack: new Error("session roots request").stack ?? "",
     })

    if (rootDirectory) {
      sessionRootReads++
      const rootKey = rootDirectory.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
      rootReadsByDirectory[rootKey] = (rootReadsByDirectory[rootKey] ?? 0) + 1
    }
  }
  if (/\/message(?:\/|$)/.test(path) || /\/messages(?:\/|$)/.test(path) || /\/timeline-parts$/.test(path)) { historyReads++; historyPaths.push(path) }
  if (/\/part(?:\/|$)/.test(path)) partReads++
  if (request.method === "GET" && /\/message\/[^/]+\/parts$/.test(path)) partDetailReads++
  if (/usage|quota/i.test(path)) usageCalls++
  if (/provider|catalog|model/i.test(path)) catalogCalls++
}
const authenticatedFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== sidecarOrigin) return originalFetch(request)
  observed(request)
  if (window.__fullAppGateHoldEventStream && request.method === "GET" && url.pathname === "/global/event") {
    return new Promise<Response>((resolve, reject) => {
      let settled = false
      const remove = () => {
        const index = heldEventStreams.indexOf(release)
        if (index >= 0) heldEventStreams.splice(index, 1)
        request.signal.removeEventListener("abort", abort)
      }
      const abort = () => {
        if (settled) return
        settled = true
        remove()
        reject(new DOMException("The operation was aborted", "AbortError"))
      }
      const release = async () => {
        if (settled) return
        settled = true
        remove()
        const headers = new Headers(request.headers)
        headers.set("authorization", auth)
        try {
          const response = await originalFetch(new Request(request, { headers }))
          resolve(recordFetchResponse(request, response))
        } catch (error) {
          reject(error)
        }
      }
      request.signal.addEventListener("abort", abort, { once: true })
      heldEventStreams.push(release)
    })
  }
  if (window.__fullAppGateHoldPartDetail && request.method === "GET" && /\/message\/[^/]+\/parts\/?$/.test(url.pathname)) {
    return new Promise<Response>((resolve, reject) => heldPartDetail.push(() => {
      const headers = new Headers(request.headers)
      headers.set("authorization", auth)
      return originalFetch(new Request(request, { headers })).then((response) => {
        resolve(recordFetchResponse(request, response))
      }, reject)
    }))
  }
  if (window.__fullAppGateDraftProviderHold && request.method === "GET" && url.pathname === "/provider") {
    heldOptionalCount++
    heldOptionalPaths.push(url.pathname)
    return new Promise<Response>((resolve, reject) => heldDraftProvider.push(() => {
      const headers = new Headers(request.headers)
      headers.set("authorization", auth)
      return originalFetch(new Request(request, { headers })).then((response) => {
        resolve(recordFetchResponse(request, response))
      }, reject)
    }))
  }
  if (window.__fullAppGateDraftAuxHold && request.method === "GET" && shouldHoldDraftAux(url)) {
    heldOptionalCount++
    heldOptionalPaths.push(url.pathname)
    heldDraftAuxPaths.push(url.pathname)
    return new Promise<Response>((resolve, reject) => heldDraftAux.push(() => {
      const headers = new Headers(request.headers)
      headers.set("authorization", auth)
      return originalFetch(new Request(request, { headers })).then((response) => {
        resolve(recordFetchResponse(request, response))
      }, reject)
    }))
  }
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
      requestFailures.push({ method: request.method, path: url.pathname, at: performance.now(), error: String(error) })
      // Usage and OpenFork identity probes are optional metadata reads. The
      // server-health owner catches probe failures and retains its prior
      // projection, so preserve request evidence without treating an expected
      // rejection during the gate's deliberate sidecar outage as a renderer crash.
      const expectedBackgroundOutage = controlledSidecarRestartWindow &&
        request.method === "GET" &&
        (url.pathname === "/experimental/openrouter-free-usage" || url.pathname === "/instance/identity")
      if (!expectedBackgroundOutage) rendererErrors.push(`fetch failed ${request.method} ${url.pathname}: ${String(error)}`)
    }
    throw error
  }
}
// Production's loopback event stream intentionally uses the webview fetch
// path. Wrap that path too so SSE is counted and authenticated exactly once
// by this fixture, while all non-sidecar requests retain the original fetch.
globalThis.fetch = authenticatedFetch
window.__fullAppGateHeldEventStreamCount = () => heldEventStreams.length
window.__fullAppGateReleaseEventStream = async () => {
  window.__fullAppGateHoldEventStream = false
  const release = heldEventStreams.splice(0)
  await Promise.all(release.map((item) => item()))
}
const desktopFetch = createDesktopFetch({
  fetch: authenticatedFetch,
  awaitInitialization: async () => ({ url: baseURL, username: "opencode", password }),
  dispatch: (requestID, input) => {
    if (!window.__fullAppGateControl) throw new Error("full-app test control bridge is unavailable")
    const request = new Request(input.url, { method: input.method, headers: input.headers, body: input.body })
    observed(request)
    const url = new URL(input.url)
    if (window.__fullAppGateDraftProviderHold && input.method === "GET" && url.pathname === "/provider") {
      heldOptionalCount++
      heldOptionalPaths.push(url.pathname)
      return new Promise((resolve, reject) => heldDraftProvider.push(() => {
        return window.__fullAppGateControl!.dispatch(requestID, input).then((response) => {
          recordResponse(request, response.status, response.body, response.headers)
          resolve(response)
        }, reject)
      }))
    }
    if (window.__fullAppGateDraftAuxHold && input.method === "GET" && shouldHoldDraftAux(url)) {
      heldOptionalCount++
      heldOptionalPaths.push(url.pathname)
      heldDraftAuxPaths.push(url.pathname)
      return new Promise((resolve, reject) => heldDraftAux.push(() => {
        return window.__fullAppGateControl!.dispatch(requestID, input).then((response) => {
          recordResponse(request, response.status, response.body, response.headers)
          resolve(response)
        }, reject)
      }))
    }
    if (window.__fullAppGateOptionalHold && shouldHoldOptional(url)) {
      heldOptionalCount++
      heldOptionalPaths.push(url.pathname)
      return new Promise((resolve, reject) => heldOptional.push(() => {
        return window.__fullAppGateControl!.dispatch(requestID, input).then((response) => {
          recordResponse(request, response.status, response.body, response.headers)
          resolve(response)
        }, reject)
      }))
    }
    if (window.__fullAppGateHoldPartDetail && input.method === "GET" && /\/message\/[^/]+\/parts\/?$/.test(url.pathname)) {
      return new Promise((resolve, reject) => heldPartDetail.push(() => {
        return window.__fullAppGateControl!.dispatch(requestID, input).then((response) => {
          recordResponse(request, response.status, response.body, response.headers)
          resolve(response)
        }, reject)
      }))
    }
    return window.__fullAppGateControl.dispatch(requestID, input).then((response) => {
      recordResponse(request, response.status, response.body, response.headers)
      return response
    })
  },
  cancel: (requestID) => window.__fullAppGateControl?.cancel(requestID),
})

window.__fullAppGateHeldPartDetailCount = () => heldPartDetail.length
window.__fullAppGateReleasePartDetail = async () => {
  const release = heldPartDetail.shift()
  if (!release) throw new Error("no held progressive detail request to release")
  await release()
}

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
// The regression trigger depends on reasoning being visible in the transcript.
storage().setItem("settings.v3", JSON.stringify({ general: { showReasoningSummaries: true } }))
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
const waitFor = async <T,>(predicate: () => T | false | undefined, message: string | (() => string), ms = 20_000): Promise<T> => {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {
    const value = predicate()
    if (value !== false && value !== undefined) return value
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
const phaseTraceTotals = () => {
  const trace = (window as any).__opencodePhaseTrace?.() as { windows?: Array<Record<string, any>>; current?: Record<string, any> } | undefined
  const samples = [...(trace?.windows ?? []), ...(trace?.current ? [trace.current] : [])]
  const totals = { projectionRuns: 0, projectionTurns: 0, projectionScanRows: 0, rowsBuilt: 0, rowsMs: 0, rowIndexRowsVisited: 0, rowIndexFullRebuildRows: 0, rowIndexTailRows: 0, projectionMs: 0, projectionScanRowsByPass: {} as Record<string, number> }
  for (const sample of samples) {
    totals.projectionRuns += Number(sample.projectionRuns ?? 0)
    totals.projectionTurns += Number(sample.projectionTurns ?? 0)
    totals.projectionScanRows += Number(sample.projectionScanRows ?? 0)
    totals.rowsBuilt += Number(sample.rowsBuilt ?? 0)
    totals.rowsMs += Number(sample.rowsMs ?? 0)
    totals.rowIndexRowsVisited += Number(sample.rowIndexRowsVisited ?? 0)
    totals.rowIndexFullRebuildRows += Number(sample.rowIndexFullRebuildRows ?? 0)
    totals.rowIndexTailRows += Number(sample.rowIndexTailRows ?? 0)
    totals.projectionMs += Number(sample.projectionMs ?? 0)
    for (const [pass, count] of Object.entries(sample.projectionScanRowsByPass ?? {})) {
      totals.projectionScanRowsByPass[pass] = (totals.projectionScanRowsByPass[pass] ?? 0) + Number(count)
    }
  }
  return totals
}
const snapshot = () => {
  const path = window.__fullAppRoute ?? "/"
  const activeSessionID = path.match(/\/session\/(ses_[A-Za-z0-9_-]+)/)?.[1]
  return {
  scenario: (window as any).__fullAppGateScenario ?? "startup",
  path,
  loadedModules: [...(window.__fullAppGateLoadedModules ?? [])],
  globalBoundaryErrors: [...(((window as any).__fullAppGateBoundaryErrors ?? []) as unknown[])],
  workspaceBootstrapDirectories: [...(((window as any).__fullAppGateBootstrapDirectories ?? []) as unknown[])],
  globalChildCreations: [...(((window as any).__fullAppGateGlobalChildCalls ?? []) as unknown[])],
  globalSDKProviders: [...(((window as any).__fullAppGateGlobalSDKProviders ?? []) as unknown[])],
  viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
  activeSessionID,
  reducerStore: activeSessionID ? window.__fullAppGateReadServerSession?.(activeSessionID) : undefined,
  timelineModel: activeSessionID ? window.__fullAppGateReadTimeline?.(activeSessionID) : undefined,
  timelineRenderer: activeSessionID ? window.__fullAppGateReadTimelineRenderer?.(activeSessionID) : undefined,
  stopClickHandledAt: window.__fullAppGateStopClickHandledAt,
  showReasoningSummariesStorage: localStorage.getItem("default.dat:settings.v3"),
  timelineMarkdown: [...document.querySelectorAll<HTMLElement>("[data-timeline-part-id]")]
    .filter((element) => element.closest("[data-component='session-turn']"))
    .slice(-12)
    .map((element) => {
      const markdown = element.querySelector<HTMLElement>("[data-component='markdown']")
      const rect = element.getBoundingClientRect()
      return {
        partID: element.dataset.timelinePartId,
        textPart: element.innerText.slice(0, 500),
        markdownText: markdown?.innerText.slice(0, 500),
        markdownReady: markdown?.dataset.markdownReady,
        markdownChildren: markdown?.children.length,
        markdownHTML: markdown?.innerHTML.slice(0, 1200),
        partRect: { top: rect.top, bottom: rect.bottom, height: rect.height },
      }
    }),
  timelineSizeWrites: timelineSizeWrites.filter((entry) => entry.scenario === ((window as any).__fullAppGateScenario ?? "startup")).slice(-300),
  appliedMessageEvents: activeSessionID ? (window.__fullAppGateApplyEvents ?? []).filter((event) => (event as { sessionID?: string }).sessionID === activeSessionID) : [],
  visibleBodyText: document.body.innerText,
  promptComposerMounted: document.querySelector("[data-component='prompt-input']") !== null,
  errorDetailsFields: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")]
    .map((element) => element.value)
    .filter(Boolean),
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
   sessionRootRequests: [...sessionRootRequests],
   historyPaths: [...historyPaths],

  observedRequests: [...observedRequests],
  controlAcks: [...controlAcks],
  rendererErrors: [...rendererErrors],
  resizeObserverWarnings: [...resizeObserverWarnings],
  resizeObserverWarningAttribution: (window as any).__fullAppGateResizeObserverWarnings ?? [],
  consoleErrors: [...consoleErrors],
  consoleErrorRecords: [...consoleErrorRecords],
  responseStatuses: { ...responseStatuses },
  requestTimings: [...requestTimings],
  requestFailures: [...requestFailures],
  maxFrameGapMs,
  longAnimationFrames,
  maxLongAnimationFrameMs,
  longAnimationFrameTrace: [...longAnimationFrameTrace],
  visibleAlerts: [...document.querySelectorAll<HTMLElement>("[role='alert']")].map((element) => element.innerText),
  requestCounts: { ...requestCounts },
  }
}
const desktopRouter: Component<BaseRouterProps> = (props) => {
  const history = createMemoryHistory()
  window.__fullAppRoute = history.get()
  window.__fullAppRouteBack = () => history.go(-1)
  history.listen((value) => { window.__fullAppRoute = value })
  return <MemoryRouter {...props} history={history} />
}

const NativeResizeObserver = window.ResizeObserver
window.ResizeObserver = class extends NativeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    const created = new Error().stack?.split("\n").slice(2, 7).find((line) => /packages\/(app|ui|session-ui)\/src/.test(line))
    super((entries, observer) => {
      resizeObserverCallbacks.push({
        scenario: (window as any).__fullAppGateScenario ?? "startup",
        at: performance.now(),
        created,
        entries: entries.map((entry) => {
          const element = entry.target as HTMLElement
          return {
            tag: element.tagName,
            index: element.dataset.index,
            timelineKey: element.closest<HTMLElement>("[data-timeline-key]")?.dataset.timelineKey,
            component: element.dataset.component,
            slot: element.dataset.slot,
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          }
        }),
      })
      if (resizeObserverCallbacks.length > 300) resizeObserverCallbacks.splice(0, resizeObserverCallbacks.length - 300)
      const windowState = window as any
      windowState.__fullAppGateResizeObserverDepth = (windowState.__fullAppGateResizeObserverDepth ?? 0) + 1
      try {
        callback(entries, observer)
      } finally {
        windowState.__fullAppGateResizeObserverDepth -= 1
      }
    })
  }
} as typeof ResizeObserver

document.addEventListener("click", (event) => {
  const target = event.target
  if (target instanceof Element && target.closest("[data-slot='prompt-turn-baton']")) {
    window.__fullAppGateStopClickHandledAt = Date.now()
  }
}, true)

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
      `production Home did not mount; route=${window.__fullAppRoute}; body=${JSON.stringify(document.body.innerText.slice(0, 1600))}; errorDetails=${JSON.stringify([...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")].map((element) => element.value).filter(Boolean))}; boundary=${JSON.stringify((window as any).__fullAppGateBoundaryErrors ?? [])}; errors=${JSON.stringify(rendererErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}; requests=${JSON.stringify(requestCounts)}; roots=${JSON.stringify(rootReadsByDirectory)}`)
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
    const startupTraceResult = profileStartup
      ? {
          preNavigation: preNavigationTrace,
          clockMark: await startupTraceClockMark,
          longAnimationFrames: [...longAnimationFrameTrace],
          moduleEvaluation: [...(((window as any).__fullAppGateModuleEvaluations ?? []) as Array<Record<string, unknown>>)],
          trace: await window.__fullAppGateControl!.traceStop("startup"),
          profile: await window.__fullAppGateControl!.profileStopStartup(),
        }
      : undefined

    // Exercise the actual empty-Home new-session affordance while this is still
    // a cold project. The draft route must mount from Tier 0/2 owners without
    // constructing an Instance or opening a session tab.
    const newSessionStartedAt = performance.now()
    window.__fullAppGateDraftProviderHold = true
    window.__fullAppGateDraftAuxHold = true
    const newSessionMilestones: Record<string, any> = { homeActionAt: newSessionStartedAt }
    const newSessionButton = document.querySelector<HTMLButtonElement>("[data-action='home-new-session']")
    if (!newSessionButton) throw new Error(`cold Home did not expose its production new-session action; body=${JSON.stringify(document.body.innerText.slice(0, 1200))}`)
    newSessionButton.click()
    await waitFor(() => (window.__fullAppRoute ?? "").includes("new-session"),
      () => `production new-session navigation did not occur; route=${window.__fullAppRoute}`)
    newSessionMilestones.routeNavigationAt = performance.now()
    const fastInput = await waitFor(() => {
      const element = document.querySelector<HTMLTextAreaElement>("[data-component='new-session-fast-input']")
      if (!element) return undefined
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? element : undefined
    }, "new-session fast input did not become usable before advanced composer loading", 6_000)
    await waitFor(() => document.activeElement === fastInput,
      "new-session fast input did not receive route autofocus before the enhancement-demand check")
    await waitFor(() => typeof window.__fullAppGateReleaseNewSessionFeatures === "function",
      "new-session did not start loading the complete page after route entry")
    if ((window as any).__fullAppGateEnhancedRequestCount !== 1) {
      throw new Error(`new-session route entry requested the enhanced page ${(window as any).__fullAppGateEnhancedRequestCount} times; expected exactly once`)
    }
    newSessionMilestones.completePageRequestedOnEntry = true
    const fastInputMarker = "draft typed while advanced composer is held"
    fastInput.value = fastInputMarker
    fastInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: fastInputMarker }))
    newSessionMilestones.fastInputUsableAt = performance.now()
    newSessionMilestones.fastInputTextRetained = fastInput.value === fastInputMarker
    newSessionMilestones.advancedComposerHeld = true
    window.__fullAppGateReleaseNewSessionFeatures!()
    // Keep optional workspace suggestion data unresolved, and wait for actual
    // editor visibility before releasing it. This timestamps user readiness
    // independently of how long the held sidecar requests take to finish.
    const composerReadyBeforeRelease = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-component='session-new-design'] [data-component='prompt-input'][contenteditable='true']")
      if (!element) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }, "new-session composer did not become usable while draft auxiliary reads were held", 6_000).then(() => true, () => false)
    const draftAuxProbeAt = performance.now()
    newSessionMilestones.draftAuxPathsHeldAtComposer = [...heldDraftAuxPaths]
    newSessionMilestones.draftAuxPendingBeforeRelease = heldDraftAux.length
    newSessionMilestones.composerVisibleBeforeDraftAuxRelease = composerReadyBeforeRelease
    if (composerReadyBeforeRelease) {
      newSessionMilestones.routeMountedAt = draftAuxProbeAt
      newSessionMilestones.composerUsableAt = draftAuxProbeAt
      const composer = document.querySelector<HTMLElement>("[data-component='session-new-design'] [data-component='prompt-input'][contenteditable='true']")
      composer?.focus()
      if (document.activeElement === composer) newSessionMilestones.composerFocusedAt = performance.now()
    }
    const draftAuxReleases = heldDraftAux.splice(0)
    window.__fullAppGateDraftAuxHold = false
    await Promise.all(draftAuxReleases.map((release) => release()))
    await waitFor(() => (window.__fullAppRoute ?? "").includes("new-session") && document.querySelector("[data-component='session-new-design']") !== null,
      () => `production new-session draft route did not mount from cold Home; route=${window.__fullAppRoute}; body=${JSON.stringify(document.body.innerText.slice(-1800))}; errors=${JSON.stringify(rendererErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`)
    newSessionMilestones.routeMountedAt ??= performance.now()
    await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-component='session-new-design'] [data-component='prompt-input'][contenteditable='true']")
      if (!element) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }, () => `new-session draft mounted without a visible, editable composer; route=${window.__fullAppRoute}; body=${JSON.stringify(document.body.innerText.slice(-1800))}; errors=${JSON.stringify(rendererErrors)}`)
    newSessionMilestones.composerUsableAt ??= performance.now()
    const composer = document.querySelector<HTMLElement>("[data-component='session-new-design'] [data-component='prompt-input'][contenteditable='true']")
    if (!composer) throw new Error("new-session composer disappeared after becoming usable")
    await waitFor(() => composer.textContent?.includes(fastInputMarker) === true,
      "draft text typed into the fast input was lost when the advanced composer mounted")
    newSessionMilestones.fastInputDraftTransferred = true
    composer.focus()
    if (document.activeElement !== composer) throw new Error("new-session composer was visible but could not receive focus")
    newSessionMilestones.composerFocusedAt ??= performance.now()
    // Upstream #46392 reports OOM after pasting a several-hundred-KB HTML
    // document into the composer. The production V2 composer routes large
    // pastes into an attachment; prove the actual editor stays bounded.
    const largePasteText = `<html><body>${"<section><p>performance gate large paste</p></section>".repeat(9_000)}</body></html>`
    const largePasteClipboard = new DataTransfer()
    largePasteClipboard.setData("text/plain", largePasteText)
    const largePasteStartedAt = performance.now()
    composer.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: largePasteClipboard }))
    await waitFor(
      () => document.querySelector("[data-component='prompt-input-v2-attachments']") !== null,
      "large paste did not become a composer attachment",
      10_000,
    )
    await frame()
    const largePasteEditorChars = composer.textContent?.length ?? 0
    const largePasteAttachmentText = document.querySelector<HTMLElement>("[data-component='prompt-input-v2-attachments']")?.innerText ?? ""
    if (largePasteEditorChars > 1024 || !largePasteAttachmentText) {
      throw new Error(`large paste expanded into the editable composer instead of an attachment (editor chars=${largePasteEditorChars}; attachment=${largePasteAttachmentText.slice(0, 200)})`)
    }
    newSessionMilestones.largePaste = {
      inputChars: largePasteText.length,
      editorChars: largePasteEditorChars,
      attachmentMounted: true,
      elapsedMs: performance.now() - largePasteStartedAt,
    }
    await waitFor(() => heldDraftProvider.length > 0,
      () => `new-session did not issue a provider catalog request while the draft-only hold was active; observed=${JSON.stringify(observedRequests.slice(-40))}`)
    const providerHoldObserved = heldDraftProvider.length > 0
    newSessionMilestones.providerCatalogHeldAt = performance.now()
    await waitFor(() => requestTimings.some((item) => item.method === "GET" && item.path === "/config"),
      () => `new-session route did not complete its workspace config read; timings=${JSON.stringify(requestTimings.filter((item) => item.path === "/config"))}; requests=${JSON.stringify(requestCounts)}`)
    const configTiming = requestTimings.find((item) => item.method === "GET" && item.path === "/config" && item.startedAt >= newSessionStartedAt)
    if (!configTiming) throw new Error(`new-session config completion had no matching start timestamp: ${JSON.stringify(requestTimings.filter((item) => item.path === "/config"))}`)
    newSessionMilestones.configStartedAt = configTiming.startedAt
    newSessionMilestones.configCompletedAt = configTiming.startedAt + configTiming.elapsedMs
    const draftProviderReleases = heldDraftProvider.splice(0)
    newSessionMilestones.providerCatalogStillPendingBeforeRelease = draftProviderReleases.length > 0
    window.__fullAppGateDraftProviderHold = false
    await Promise.all(draftProviderReleases.map((release) => release()))
    const newSessionRoute = snapshot()
    const newSessionRouteMountMs = (newSessionMilestones.routeMountedAt ?? newSessionStartedAt) - newSessionStartedAt
    const newSessionComposerUsableMs = (newSessionMilestones.composerUsableAt ?? newSessionStartedAt) - newSessionStartedAt
    const newSessionComposerFocusMs = (newSessionMilestones.composerFocusedAt ?? newSessionStartedAt) - newSessionStartedAt
    const newSessionConfigReadMs = configTiming.elapsedMs
    const newSessionDraftRouteSettledMs = performance.now() - newSessionStartedAt
    newSessionMilestones.resources = performance.getEntriesByType("resource")
      .filter((entry) => entry.startTime >= newSessionStartedAt)
      .slice(-200)
      .map((entry) => {
        const resource = entry as PerformanceResourceTiming
        return {
          name: resource.name,
          initiatorType: resource.initiatorType,
          startTime: resource.startTime,
          duration: resource.duration,
          responseEnd: resource.responseEnd,
          transferSize: resource.transferSize,
        }
      })
    newSessionMilestones.routeModuleMarks = ["draft-route.tsx", "new-session-import-start", "new-session-import-resolved", "new-session.tsx", "new-session-enhanced-import-start", "new-session-enhanced-import-resolved", "new-session-enhanced.tsx"].map((name) => ({
      name,
      startTime: performance.getEntriesByName(name.includes("import")
        ? `full-app-gate:${name}`
        : `full-app-gate:module:${name}`)[0]?.startTime,
    }))
    if (newSessionRoute.tabs > 1 || newSessionRoute.historyReads !== 0 || newSessionRoute.partReads !== 0 || (requestCounts["POST /session"] ?? 0) !== 0) {
      throw new Error(`cold new-session draft performed session/history fanout before submission; route=${newSessionRoute.path}; tabs=${JSON.stringify(newSessionRoute.tabState)}; composerUsableMs=${newSessionComposerUsableMs}; configTimings=${JSON.stringify((newSessionRoute.requestTimings as Array<{ path: string }>).filter((item) => item.path === "/config"))}; history=${newSessionRoute.historyPaths}; requests=${JSON.stringify(newSessionRoute.requestCounts)}`)
    }
    const startupNewSessionMilestones = { ...newSessionMilestones, routeMountMs: newSessionRouteMountMs, composerUsableMs: newSessionComposerUsableMs, composerFocusMs: newSessionComposerFocusMs, configReadMs: newSessionConfigReadMs, draftRouteSettledMs: newSessionDraftRouteSettledMs, providerCatalogHeld: providerHoldObserved }
    if (startupOnly) {
      return {
        startupOnly: true,
        cold,
        coldElapsedMs,
        coldSinceGateMs,
        startupTrace: startupTraceResult,
        newSessionRoute,
        newSessionMilestones: startupNewSessionMilestones,
        locationFailures,
        final: snapshot(),
        heldOptionalCount,
        heldOptionalPaths: [...heldOptionalPaths],
      }
    }
    if (!window.__fullAppRouteBack) throw new Error("fixture router could not return from draft to Home")
    window.__fullAppRouteBack()
    await waitFor(() => window.__fullAppRoute === "/" && document.querySelector("[data-component='home-session-scroll-track']") !== null,
      "production Home did not return after cold draft-route coverage")
    const closeDraft = document.querySelector<HTMLButtonElement>("[data-titlebar-tab-slot] [aria-label='Close tab']")
    if (!closeDraft) throw new Error(`production draft tab had no close action after returning Home; tabs=${JSON.stringify(snapshot().tabState)}`)
    closeDraft.click()
    await waitFor(() => document.querySelectorAll("[data-titlebar-tab]").length === 0, "closing the draft tab did not restore tab-free Home")

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
    const requestedLargeHistoryParts = Number(new URLSearchParams(location.search).get("largeHistoryParts"))
    let largeHistorySeed: { messageID: string; parts: number; elapsedMs: number } | undefined
    if (requestedLargeHistoryParts > 0) {
      if (!Number.isInteger(requestedLargeHistoryParts) || requestedLargeHistoryParts < 100 || requestedLargeHistoryParts > 80_000) {
        throw new Error("large-history Electron fixture accepts between 100 and 80,000 parts")
      }
      largeHistorySeed = await window.__fullAppGateControl!.seedLargeHistory({
        sessionID: first.id,
        messageID: `msg_gate_large_history_${first.id}`,
        count: requestedLargeHistoryParts,
      })
      if (largeHistorySeed.parts !== requestedLargeHistoryParts) throw new Error("large-history fixture did not seed its exact part count")
    }

    // Hold the actual usage-summary SQLite statement while the user opens the
    // selected Session. The test-only Node transform waits inside sqlite.node
    // after Effect SQL acquires the scanDb connection's statement permit.
    const scanProjectID = `gate-unmaterialized-${first.id}`
    const scanStartedAt = performance.now()
    let scanSummarySettled = false
    const scanSummaryPromise = sidecar(
      `usage/summary?since=0&until=${Date.now()}&resolution=day&projectID=${encodeURIComponent(scanProjectID)}`,
    ).then(
      async (response) => ({ status: response.status, value: await response.json() as unknown }),
      (error) => ({ error: String(error) }),
    ).then((result) => {
      scanSummarySettled = true
      return result
    })
    let scanStatus: { arrivals: number; held: boolean; releaseRequested: boolean } | undefined
    const scanWaitDeadline = performance.now() + 20_000
    while (performance.now() < scanWaitDeadline) {
      const response = await originalFetch(new URL("/gate/scan/status", modelControlURL))
      if (!response.ok) throw new Error(`scan hold status failed (${response.status})`)
      scanStatus = await response.json() as typeof scanStatus
      if (scanStatus?.held) break
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20))
    }
    if (scanStatus?.arrivals !== 1 || !scanStatus.held || scanStatus.releaseRequested) {
      const earlyResult = scanSummarySettled ? await scanSummaryPromise : undefined
      throw new Error("usage summary did not hold the real scanDb statement permit: " + JSON.stringify({
        scanStatus,
        scanSummarySettled,
        earlyResult,
        requests: requestTimings.filter((item) => item.path.includes("usage/summary")).slice(-4),
        failures: requestFailures.filter((item) => item.path.includes("usage/summary")).slice(-4),
      }))
    }
    const releaseScan = async () => {
      const response = await originalFetch(new URL("/gate/scan/release", modelControlURL), { method: "POST" })
      if (!response.ok) throw new Error(`scan hold release failed (${response.status})`)
      return await response.json() as { arrivals: number; released: boolean }
    }

    // Only after cold Home and row visibility have been measured may optional
    // background work be held; session and global-event paths stay live.
    window.__fullAppGateOptionalHold = true
    const row = [...document.querySelectorAll<HTMLButtonElement>("[data-component='home-session-row']")]
      .find((element) => element.innerText.includes("full-app-first-project-row"))
    if (!row) throw new Error("visible Home row disappeared before selection")
    const detailOpenStartedAt = performance.now()
    let selected: ReturnType<typeof snapshot>
    let selectedHistoryRequestCount = 0
    let detailReadyMs = 0
    let scanHeldThroughActivation = false
    try {
      row.click()
      await waitFor(() => (window.__fullAppRoute ?? "").includes(`/session/${first.id}`), "actual Home row click did not open session detail")
      await waitFor(() => document.querySelector("[data-component='prompt-input']") !== null, () =>
        `selected detail composer did not mount; route=${window.__fullAppRoute}; counts=${JSON.stringify(requestCounts)}; statuses=${JSON.stringify(responseStatuses)}; historyPaths=${JSON.stringify(historyPaths)}; body=${JSON.stringify(document.body.innerText.slice(0, 1800))}; fields=${JSON.stringify([...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")].map((element) => element.value))}; errors=${JSON.stringify(rendererErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`)
      await waitFor(() => streamInterestRequests.some((item) => {
        const body = item.body as { generation?: number; sessions?: string[] } | undefined
        const ack = item.acknowledgement as { updated?: boolean; generation?: number } | undefined
        return body?.sessions?.includes(first.id) && ack?.updated === true && ack.generation === body.generation
      }), () => `selected route did not receive an acknowledged session-interest generation for ${first.id}; interest=${JSON.stringify(streamInterestRequests)}`)
      await waitFor(() => historyResponses.some((item) => item.path.includes(first.id)),
        () => `selected session's initial history read did not settle; history=${JSON.stringify(historyResponses)}`)
      selected = snapshot()
      selectedHistoryRequestCount = historyPaths.length
      detailReadyMs = performance.now() - detailOpenStartedAt
      if (!(selected.loadedModules as string[]).includes("session.tsx:SessionPage")) {
        throw new Error(`real session route did not invoke the dynamically imported SessionPage; route=${selected.path}; loadedModules=${JSON.stringify(selected.loadedModules)}; errors=${JSON.stringify(rendererErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`)
      }
      const statusResponse = await originalFetch(new URL("/gate/scan/status", modelControlURL))
      if (!statusResponse.ok) throw new Error(`scan hold status after activation failed (${statusResponse.status})`)
      const afterActivation = await statusResponse.json() as typeof scanStatus
      scanHeldThroughActivation = afterActivation?.arrivals === 1 && afterActivation.held && !afterActivation.releaseRequested
      if (!scanHeldThroughActivation || scanSummarySettled) {
        throw new Error(`session activation did not finish while the scan permit stayed held: ${JSON.stringify({ afterActivation, scanSummarySettled })}`)
      }
    } finally {
      await releaseScan()
    }
    const scanRelease = await originalFetch(new URL("/gate/scan/status", modelControlURL)).then(async (response) => {
      if (!response.ok) throw new Error(`final scan hold status failed (${response.status})`)
      return await response.json() as typeof scanStatus
    })
    const scanSummaryResult = await within(scanSummaryPromise, 15_000, "usage summary did not finish after releasing its scan permit")
    if ("error" in scanSummaryResult || scanSummaryResult.status !== 200) {
      throw new Error(`held usage summary failed after release: ${JSON.stringify(scanSummaryResult)}`)
    }
    const usageScanContention = {
      requestPath: "/usage/summary",
      projectID: scanProjectID,
      scanArrivals: scanRelease?.arrivals,
      scanReleased: scanRelease?.releaseRequested,
      heldBeforeSelection: scanStatus.held,
      heldThroughActivation: scanHeldThroughActivation,
      summarySettledBeforeRelease: false,
      summaryStatus: scanSummaryResult.status,
      summaryValue: scanSummaryResult.value,
      summaryElapsedMs: performance.now() - scanStartedAt,
      selectedRouteReadyMs: detailReadyMs,
      selectedHistoryRequestCount,
    }

    if (largeHistorySeed) {
      const history = historyResponses.filter((item) => item.path === `/session/${first.id}/message`)
      const page = history.at(-1)
      const omitted = page?.windowed ? JSON.parse(page.windowed) as Array<{ messageID: string; omittedParts?: number }> : []
      const omission = omitted.find((item) => item.messageID === largeHistorySeed!.messageID)
      const readStore = () => window.__fullAppGateReadServerSession?.(first.id) as {
        messages?: Array<{ id: string; parts?: unknown[] }>
        messageWindow?: Record<string, unknown>
      } | undefined
      const stored = () => readStore()?.messages?.find((message) => message.id === largeHistorySeed!.messageID)
      const timelineRecoveryStartedAt = performance.now()
      await waitFor(
        () => stored()?.parts?.length === largeHistorySeed!.parts && !readStore()?.messageWindow?.[largeHistorySeed!.messageID],
        () => `automatic complete timeline hydration did not converge: ${JSON.stringify({
          expectedParts: largeHistorySeed!.parts,
          actualParts: stored()?.parts?.length,
          window: readStore()?.messageWindow?.[largeHistorySeed!.messageID],
          paths: historyPaths.filter((path) => path.includes("/timeline-parts")),
        })}`,
        90_000,
      )
      const timelineRecoveryElapsedMs = performance.now() - timelineRecoveryStartedAt
      await frame()
      const timelinePartReads = historyPaths.filter((path) => path.includes("/timeline-parts"))
      const keyedFetch = historyPaths.some((item) => item.endsWith(`/message/${largeHistorySeed!.messageID}`))
      const omittedRowVisible = [...document.querySelectorAll<HTMLElement>("[data-timeline-key]")]
        .some((element) => element.dataset.timelineKey === `content-window:${largeHistorySeed!.messageID}`)
      const recovered = stored()
      const recoveredText = recovered?.parts?.map((part) => JSON.stringify(part)).join("\n") ?? ""
      const largeHistory = {
        seed: largeHistorySeed,
        detailReadyMs,
        history,
        historyPaths: [...historyPaths],
        keyedFetch,
        partReads,
        partDetailReads,
        timelinePartReads,
        timelineRecoveryElapsedMs,
        recoveredPartCount: recovered?.parts?.length,
        timelinePartContentComplete: recoveredText.includes("gate-large-history-part-00000") &&
          recoveredText.includes(`gate-large-history-part-${String(largeHistorySeed.parts - 1).padStart(5, "0")}`),
        omittedRowVisible,
        composerUsableAfterDetail: document.querySelector("[data-component='prompt-input']") !== null,
        omittedParts: omission?.omittedParts,
        composerMounted: selected.promptComposerMounted,
        rendererErrors: [...rendererErrors],
        consoleErrors: [...consoleErrors],
      }
      return {
        cold,
        coldElapsedMs,
        coldSinceGateMs,
        newSessionRoute,
        visibleBeforeSelect,
        selected,
        detailReadyMs,
        usageScanContention,
        largeHistory,
        final: snapshot(),
      }
    }

    const historySeedStartedAt = performance.now()
    const requestedHistorySeedCycles = Number(new URLSearchParams(location.search).get("historyCycles"))
    const historySeedCycles = Number.isInteger(requestedHistorySeedCycles) && requestedHistorySeedCycles >= 1 && requestedHistorySeedCycles <= 320
      ? requestedHistorySeedCycles
      : 48
    const historySeedTraceBefore = phaseTraceTotals()
    ;(window as any).__fullAppGateScenario = "history-seed"
    let historySeedTailTrace: Record<string, unknown> | undefined
    for (let cycle = 1; cycle <= historySeedCycles; cycle++) {
      if (new URLSearchParams(location.search).get("profileHistory") === "1" && cycle === historySeedCycles - 1) {
        await window.__fullAppGateControl!.traceStart("history-seed-tail")
        gateMark("history-seed-tail:trace-active")
      }
      const response = await sidecar(`session/${encodeURIComponent(first.id)}/prompt_async?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: { providerID: "full-app-gate", modelID: "gate-model" },
          parts: [{ type: "text", text: `full-app-gate-${first.id}-cycle-${1000 + cycle}` }],
        }),
      })
      if (response.status !== 204) throw new Error(`history fixture prompt admission failed at turn ${cycle} (${response.status})`)
      const release = await originalFetch(`${modelControlURL}gate/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessions: [{ id: first.id, cycle: 1000 + cycle }] }),
      })
      if (!release.ok) throw new Error(`history fixture model release failed at turn ${cycle} (${release.status})`)
      const result = await release.json() as {
        missing?: string[]
        observations?: Array<{ key?: string; markerFound: boolean; path?: string; messagesPreview?: string }>
      }
      if (result.missing?.length) {
        throw new Error(`history fixture model was not observed at turn ${cycle}: ${JSON.stringify({ status: release.status, ...result })}`)
      }
      await waitSessionsIdle([first.id])
      if (new URLSearchParams(location.search).get("profileHistory") === "1" && cycle === historySeedCycles) {
        historySeedTailTrace = await window.__fullAppGateControl!.traceStop("history-seed-tail")
        gateMark("history-seed-tail:trace-stopped")
      }
    }
    const historySeedElapsedMs = performance.now() - historySeedStartedAt
    const historySeedTraceAfter = phaseTraceTotals()
    const historySeedTrace = {
      projectionRuns: historySeedTraceAfter.projectionRuns - historySeedTraceBefore.projectionRuns,
      projectionTurns: historySeedTraceAfter.projectionTurns - historySeedTraceBefore.projectionTurns,
      projectionScanRows: historySeedTraceAfter.projectionScanRows - historySeedTraceBefore.projectionScanRows,
      rowsBuilt: historySeedTraceAfter.rowsBuilt - historySeedTraceBefore.rowsBuilt,
      rowsMs: historySeedTraceAfter.rowsMs - historySeedTraceBefore.rowsMs,
      rowIndexRowsVisited: historySeedTraceAfter.rowIndexRowsVisited - historySeedTraceBefore.rowIndexRowsVisited,
      rowIndexFullRebuildRows: historySeedTraceAfter.rowIndexFullRebuildRows - historySeedTraceBefore.rowIndexFullRebuildRows,
      rowIndexTailRows: historySeedTraceAfter.rowIndexTailRows - historySeedTraceBefore.rowIndexTailRows,
      projectionMs: historySeedTraceAfter.projectionMs - historySeedTraceBefore.projectionMs,
      projectionScanRowsByPass: Object.fromEntries([...new Set([
        ...Object.keys(historySeedTraceBefore.projectionScanRowsByPass),
        ...Object.keys(historySeedTraceAfter.projectionScanRowsByPass),
      ])].map((pass) => [pass, (historySeedTraceAfter.projectionScanRowsByPass[pass] ?? 0) - (historySeedTraceBefore.projectionScanRowsByPass[pass] ?? 0)])),
    }
    const historySeedRenderer = window.__fullAppGateReadTimelineRenderer?.(first.id) as { timelineRows?: unknown[] } | undefined
    if ((historySeedRenderer?.timelineRows?.length ?? 0) < historySeedCycles * 2) {
      throw new Error(`history fixture rendered too few timeline rows: expected at least ${historySeedCycles * 2}, got ${historySeedRenderer?.timelineRows?.length ?? 0}`)
    }
    // The scenario snapshots need prompt-event attribution for the 1/3/6
    // streams, not a duplicate copy of every event in the long-history seed.
    ;(window.__fullAppGateApplyEvents ??= []).splice(0)
    await window.__fullAppGateScrollTimeline?.(first.id, "bottom")

    const requestedLargePartCount = Number(new URLSearchParams(location.search).get("largeParts"))
    if (Number.isInteger(requestedLargePartCount) && requestedLargePartCount > 0) {
      const state = window.__fullAppGateReadServerSession?.(first.id) as { messages?: Array<{ id: string; role: string }> } | undefined
      const assistant = state?.messages?.findLast((message) => message.role === "assistant")
      if (!assistant || !window.__fullAppGateInjectParts || !window.__fullAppGateReadTimelineCounts) {
        throw new Error("large-part renderer fixture diagnostics are unavailable")
      }
      let timerFiredAt = 0
      const timer = new Promise<void>((resolveTimer) => setTimeout(() => {
        timerFiredAt = performance.now()
        resolveTimer()
      }, 0))
      const injectStartedAt = performance.now()
      window.__fullAppGateInjectParts(first.id, assistant.id, requestedLargePartCount)
      const injectionMs = performance.now() - injectStartedAt
      await timer
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())))
      const rendered = window.__fullAppGateReadTimelineCounts(first.id) as { rows?: number; virtualRows?: number } | undefined
      return {
        cold,
        coldElapsedMs,
        coldSinceGateMs,
        newSessionRoute,
        detailReadyMs,
        usageScanContention,
        largeParts: {
          count: requestedLargePartCount,
          injectionMs,
          timerDelayMs: timerFiredAt - injectStartedAt,
          rows: rendered?.rows,
          virtualRows: rendered?.virtualRows,
          historyRequestCount: historyPaths.length,
          rendererErrors: [...rendererErrors],
          consoleErrors: [...consoleErrors],
        },
        final: { rendererErrors: [...rendererErrors], consoleErrors: [...consoleErrors] },
      }
    }

    // Exercise the actual live-tool binding above its former 64 KiB clipping
    // threshold. This isolates the presentation contract; other scenarios use
    // source-built server/provider events for transport ownership.
    const toolAssistant = (window as any).__fullAppGateReadServerSession?.(first.id)?.messages?.findLast((message: { role: string }) => message.role === "assistant")
    if (!toolAssistant) throw new Error("running-tool presentation fixture has no assistant owner")
    const liveToolOutput = "gate-tool-output-start\n" + "complete running output\n".repeat(4_000) + "gate-tool-output-end"
    const toolHistoryReadsBefore = historyPaths.length
    const toolStartedAt = performance.now()
    const removeTool = (window as any).__fullAppGateInjectRunningTool(first.id, toolAssistant.id, liveToolOutput) as () => void
    let runningToolOutput: Record<string, unknown>
    try {
      await window.__fullAppGateScrollTimeline?.(first.id, "bottom")
      const tool = await waitFor(() => document.querySelector<HTMLElement>("[data-timeline-part-id='prt_gate_running_tool_output']"), "running-tool row did not mount")
      const trigger = tool.querySelector<HTMLButtonElement>("[data-slot='collapsible-trigger']")
      if (trigger?.getAttribute("aria-expanded") === "false") {
        const rect = trigger.getBoundingClientRect()
        await window.__fullAppGateControl!.clickStop({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      }
      const outputNode = await waitFor(() => tool.querySelector<HTMLElement>("[data-slot='bash-pre']"), "running tool output did not open")
      await waitFor(() => outputNode.textContent === liveToolOutput,
        () => `running-tool output was clipped: expected=${liveToolOutput.length}; actual=${outputNode.textContent?.length}; preview=${outputNode.textContent?.slice(0, 100)}`)
      runningToolOutput = { chars: liveToolOutput.length, completeWhileRunning: true,
        elapsedMs: performance.now() - toolStartedAt, historyReadDelta: historyPaths.length - toolHistoryReadsBefore }
    } finally {
      removeTool()
    }
    const scenarios: Array<Record<string, unknown>> = []
    for (const count of (reasoningOnly ? [] : [1, 3, 6])) {
      const scenarioName = count === 6 ? "stream-6-user-scroll-up" : `stream-${count}`
      ;(window as any).__fullAppGateScenario = scenarioName
      gateMark(`${scenarioName}:begin`)
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
      const scrollAnchorBefore = count === 6
        ? await window.__fullAppGateScrollTimeline?.(first.id, "up")
        : undefined
      if (count === 6 && (!scrollAnchorBefore || Number(scrollAnchorBefore.maxScroll ?? 0) <= Number(scrollAnchorBefore.clientHeight ?? 0))) {
        throw new Error(`long-session scroll fixture did not create one viewport of history above the fold: ${JSON.stringify(scrollAnchorBefore)}`)
      }
      const promptedEventCountBefore = (snapshot().appliedMessageEvents as Array<Record<string, any>>)
        .filter((event) => event.phase === "v2-apply" && event.type === "session.next.prompted").length
      await window.__fullAppGateControl!.traceStart(scenarioName)
      gateMark(`${scenarioName}:trace-active`)
      const startedBefore = performance.now()
      const prompts = await Promise.all(ids.map((id) => sidecar(`session/${encodeURIComponent(id)}/prompt_async?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "full-app-gate", modelID: "gate-model" }, parts: [{ type: "text", text: `full-app-gate-${id}-cycle-${count}` }] }),
      })))
      const statuses = prompts.map((response) => response.status)
      if (statuses.some((status) => status !== 204)) throw new Error(`session streams were not admitted: ${statuses.join(",")}`)
      const admittedAt = performance.now()
      gateMark(`${scenarioName}:admitted`)
      const release = await originalFetch(`${modelControlURL}gate/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessions: ids.map((id) => ({ id, cycle: count })) }),
      })
      if (!release.ok) throw new Error(`mock model stream release failed (${release.status})`)
      const released = await release.json() as { missing?: string[]; released?: string[]; observations?: Array<{ key?: string; markerFound: boolean; messagesPreview: string }> }
      if (released.missing?.length) throw new Error(`mock model did not observe streams: ${released.missing.join(",")}; expected=${JSON.stringify(ids.map((id) => `${id}:${count}`))}; released=${JSON.stringify(released.released)}; observations=${JSON.stringify(released.observations)}`)
      const releaseCompletedAt = performance.now()
      gateMark(`${scenarioName}:model-released`)
      const uniqueTail = `full-app-gate-tail-${first.id}-cycle-${count}`
      let scrolledView: Record<string, any> | undefined
      if (count === 6) {
        gateMark(`${scenarioName}:scroll-up-begin`)
        await waitFor(() => {
          const state = window.__fullAppGateReadServerSession?.(first.id) as { messages?: Array<{ parts?: Array<{ text?: string }> }> } | undefined
          return state?.messages?.some((message) => message.parts?.some((part) => part.text?.includes(uniqueTail))) ?? false
        }, () => `scrolled session did not receive the selected tail in its message store: ${uniqueTail}`)
        scrolledView = snapshot()
        const beforeAnchor = scrollAnchorBefore?.visibleAnchor as { key?: string; top?: number } | undefined
        const scrolledRenderer = scrolledView.timelineRenderer as { shouldAnchorBottom?: boolean; hasScrollGesture?: boolean } | undefined
        if (!scrolledRenderer || scrolledRenderer.shouldAnchorBottom !== false) {
          throw new Error(`full-app gate did not enter a genuine user-scrolled timeline state: ${JSON.stringify(scrolledRenderer)}`)
        }
        const duringAnchor = (scrolledView.timelineRenderer as { visibleAnchor?: { key?: string; top?: number } } | undefined)?.visibleAnchor
        if (!beforeAnchor?.key || beforeAnchor.key !== duringAnchor?.key || Math.abs((beforeAnchor.top ?? 0) - (duringAnchor?.top ?? 0)) > 16) {
          throw new Error(`user scroll anchor moved while the selected Session streamed: before=${JSON.stringify(beforeAnchor)}; during=${JSON.stringify(duringAnchor)}; scroll=${JSON.stringify(scrollAnchorBefore)}; renderer=${JSON.stringify(scrolledView.timelineRenderer)}`)
        }
        const writesDuringStream = (scrolledView.timelineSizeWrites ?? []) as Array<{ stage?: string; resizeObserverDepth?: number; key?: string; previous?: number; size?: number }>
        const synchronousWrites = writesDuringStream.filter((write) => write.stage === "applied" && (write.resizeObserverDepth ?? 0) > 0 && write.previous !== write.size)
        if (synchronousWrites.length > 0) {
          throw new Error(`virtual row size writes were applied synchronously inside ResizeObserver during user-scroll streaming: ${JSON.stringify(synchronousWrites.slice(-30))}`)
        }
        await window.__fullAppGateScrollTimeline?.(first.id, "bottom")
        gateMark(`${scenarioName}:scroll-bottom-restored`)
      }
      await waitFor(() => document.body.innerText.includes(uniqueTail),
        () => {
          const current = snapshot()
          return `selected detail stream did not render for concurrency ${count}; expected=${uniqueTail}; route=${current.path}; viewport=${JSON.stringify(current.viewport)}; reducerStore=${JSON.stringify(current.reducerStore)}; timelineModel=${JSON.stringify(current.timelineModel)}; timelineRenderer=${JSON.stringify(current.timelineRenderer)}; timelineMarkdown=${JSON.stringify(current.timelineMarkdown)}; appliedMessageEvents=${JSON.stringify(current.appliedMessageEvents)}; bodyTail=${JSON.stringify(current.visibleBodyText.slice(-2400))}; errorDetailsFields=${JSON.stringify(current.errorDetailsFields)}; turns=${JSON.stringify(current.sessionTurns)}; tabs=${JSON.stringify(current.tabState)}; interest=${JSON.stringify(current.streamInterestRequests)}; eventFrames=${JSON.stringify(current.decodedEventFrames.slice(-80))}; historyResponses=${JSON.stringify(current.historyResponses)}; requestCounts=${JSON.stringify(current.requestCounts)}; statuses=${JSON.stringify(current.responseStatuses)}; historyPaths=${JSON.stringify(current.historyPaths)}; errors=${JSON.stringify(current.rendererErrors)}; consoleErrors=${JSON.stringify(current.consoleErrors)}`
        }, 30_000)
      const selectedTailAt = performance.now()
      gateMark(`${scenarioName}:tail-visible`)
      const idle = await waitSessionsIdle(ids)
      const idleAt = performance.now()
      gateMark(`${scenarioName}:idle`)
      const trace = await window.__fullAppGateControl!.traceStop(scenarioName)
      const view = snapshot()
      const appliedEvents = view.appliedMessageEvents as Array<Record<string, any>>
      const newPromptEvents = appliedEvents.filter((event) => event.phase === "v2-apply" && event.type === "session.next.prompted")
      const prompted = newPromptEvents.slice(promptedEventCountBefore).at(-1)
      const reducerStore = view.reducerStore as { messages?: Array<Record<string, any>>; sessionMessages?: Array<Record<string, any>> } | undefined
      const timelineModel = view.timelineModel as { sessionID?: string; messages?: Array<Record<string, any>>; userMessages?: Array<Record<string, any>>; visibleUserMessages?: Array<Record<string, any>> } | undefined
      if (!prompted || !reducerStore || !timelineModel || timelineModel.sessionID !== first.id) {
        throw new Error(`prompt event did not reach the selected store/timeline; concurrency=${count}; reducerStore=${JSON.stringify(reducerStore)}; timelineModel=${JSON.stringify(timelineModel)}; appliedEvents=${JSON.stringify(appliedEvents)}`)
      }
      const userRoot = reducerStore.messages?.find((message) => message.id === prompted.messageID)
      const sourceRoot = reducerStore.sessionMessages?.find((message) => message.id === prompted.messageID)
      const timelineRoot = timelineModel.userMessages?.find((message) => message.id === prompted.messageID)
      const visibleRoot = timelineModel.visibleUserMessages?.find((message) => message.id === prompted.messageID)
      const expectedPromptText = `full-app-gate-${first.id}-cycle-${count}`
      const renderedPromptText = document
        .querySelector<HTMLElement>(`[data-message-id="${prompted.messageID}"] [data-slot='user-message-text']`)
        ?.innerText.trim()
      const renderer = view.timelineRenderer as { timelineRows?: Array<{ tag?: string; key?: string }>; virtualRowKeys?: string[]; listRoot?: { clientHeight?: number } } | undefined
      const userRowMeasuredEmpty = ((view.resizeObserverWarningAttribution ?? []) as Array<{
        recent?: Array<{ entries?: Array<{ timelineKey?: string; height?: number }> }>
      }>).some((warning) =>
        warning.recent?.some((callback) =>
          callback.entries?.some((entry) => entry.timelineKey?.startsWith("user-message:") && entry.height === 0),
        ),
      )
      if (
        userRoot?.role !== "user" || userRoot.provenance?.owner !== "user" ||
        sourceRoot?.type !== "user" || sourceRoot.provenance?.owner !== "user" ||
        timelineRoot?.provenance?.owner !== "user" ||
        visibleRoot?.id !== prompted.messageID ||
        prompted.prompt?.text !== expectedPromptText || renderedPromptText !== expectedPromptText ||
        newPromptEvents.length !== promptedEventCountBefore + 1 ||
        !renderer?.timelineRows?.some((row) => row.tag === "UserMessage" && row.key?.includes(prompted.messageID)) ||
        !renderer?.virtualRowKeys?.length || (renderer.listRoot?.clientHeight ?? 0) <= 0 ||
        userRowMeasuredEmpty ||
        historyPaths.length !== selectedHistoryRequestCount
      ) {
        throw new Error(`prompted root did not project its authoritative user text to the visible virtual timeline without a history reload or zero-height placeholder measurement; concurrency=${count}; userRowMeasuredEmpty=${userRowMeasuredEmpty}; expectedPromptText=${expectedPromptText}; renderedPromptText=${renderedPromptText}; selectedHistoryRequestCount=${selectedHistoryRequestCount}; historyPaths=${JSON.stringify(historyPaths)}; promptedEvents=${JSON.stringify(newPromptEvents)}; appliedEvents=${JSON.stringify(appliedEvents)}; userRoot=${JSON.stringify(userRoot)}; sourceRoot=${JSON.stringify(sourceRoot)}; timelineRoot=${JSON.stringify(timelineRoot)}; visibleRoot=${JSON.stringify(visibleRoot)}; timeline=${JSON.stringify(timelineModel)}; renderer=${JSON.stringify(renderer)}; errorDetailsFields=${JSON.stringify(view.errorDetailsFields)}; bodyTail=${JSON.stringify(view.visibleBodyText.slice(-1600))}; historySeedTrace=${JSON.stringify(historySeedTrace)}`)
      }
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
        trace,
        uniqueTail,
        modelObserved: released.released,
        ...(scrollAnchorBefore ? { userScroll: { before: scrollAnchorBefore, during: scrolledView?.timelineRenderer } } : {}),
        idle,
        view,
      })
    }
    // Reproduce upstream #43982 through the real Electron renderer, sidecar,
    // V1 execution path and mock provider. Keep six reasoning streams live while
    // only one long-history session is visible, then click the production Stop
    // button through Chromium input dispatch and measure its interrupt ACK.
    const reasoningScenario = "reasoning-stop"
    ;(window as any).__fullAppGateScenario = reasoningScenario
    gateMark(`${reasoningScenario}:begin`)
    const reasoningIDs = [first.id]
    for (let index = 1; index < 6; index++) {
      const response = await sidecar(`session?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `full-app-reasoning-background-${index}` }),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`reasoning background session create failed (${response.status}): ${text}`)
      reasoningIDs.push((JSON.parse(text) as { id: string }).id)
    }
    const reasoningCycle = 43982
    const reasoningPrompts = await Promise.all(reasoningIDs.map((id) => sidecar(`session/${encodeURIComponent(id)}/prompt_async?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { providerID: "full-app-gate", modelID: "gate-model" }, parts: [{ type: "text", text: `full-app-gate-${id}-cycle-${reasoningCycle}` }] }),
    })))
    if (reasoningPrompts.some((response) => response.status !== 204)) {
      throw new Error(`reasoning streams were not admitted: ${reasoningPrompts.map((response) => response.status).join(",")}`)
    }
    window.__fullAppGateReactiveWork?.start()
    await window.__fullAppGateControl!.traceStart(reasoningScenario)
    const reasoningStart = await originalFetch(`${modelControlURL}gate/reasoning/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: reasoningIDs.map((id) => ({ id, cycle: reasoningCycle, chunks: 240, chunkChars: 256, intervalMs: 30 })) }),
    })
    if (!reasoningStart.ok) throw new Error(`reasoning fixture failed to start (${reasoningStart.status}): ${await reasoningStart.text()}`)
    const reasoningStarted = await reasoningStart.json() as { started: string[]; at: number }
    if (reasoningStarted.started.length !== 6) throw new Error(`expected six live reasoning streams, got ${JSON.stringify(reasoningStarted)}`)
    const reasoningClientSamples: Array<Record<string, unknown>> = []
    const reasoningSampleTimer = setInterval(() => {
      if (reasoningClientSamples.length >= 80) return
      const live = window.__fullAppGateReadLiveReasoning?.(first.id) as { messageID?: string; parts?: Array<{ id: string; textChars: number; deltaChars?: number }> } | undefined
      const part = live?.parts?.find((candidate) => document.querySelector(`[data-component='reasoning-part'][data-timeline-part-id="${candidate.id}"]`)) ?? live?.parts?.[0]
      const node = part?.id ? document.querySelector<HTMLElement>(`[data-component='reasoning-part'][data-timeline-part-id="${part.id}"]`) : undefined
      reasoningClientSamples.push({
        at: Date.now(), messageID: live?.messageID, partID: part?.id, storeChars: part?.textChars,
        deltaChars: part?.deltaChars, renderedChars: node?.innerText.length ?? 0,
        markdownReady: node?.querySelector<HTMLElement>("[data-component='markdown']")?.dataset.markdownReady,
        markdownCount: node?.querySelectorAll("[data-component='markdown']").length ?? 0,
        documentHidden: document.hidden,
        markdownRect: (() => { const rect = node?.querySelector<HTMLElement>("[data-component='markdown']")?.getBoundingClientRect(); return rect && { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width } })(),
        reasoningRect: (() => { const rect = node?.getBoundingClientRect(); return rect && { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width } })(),
        childHtml: node?.innerHTML.slice(0, 200),
        liveTextNodes: node?.querySelectorAll("[data-markdown-live-text='true']").length ?? 0,
        markdownChars: node?.querySelector<HTMLElement>("[data-component='markdown']")?.innerText.length ?? 0,
        pacedChars: node?.querySelector<HTMLElement>("[data-component='markdown']")?.dataset.fullAppGatePacedChars,
        markdownState: { ...node?.querySelector<HTMLElement>("[data-component='markdown']")?.dataset },
        ancestors: reasoningClientSamples.length < 4 ? (() => {
          const result: unknown[] = []
          for (let ancestor: HTMLElement | null | undefined = node; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor)
            const rect = ancestor.getBoundingClientRect()
            result.push({ tag: ancestor.tagName, component: ancestor.dataset.component, class: ancestor.className,
              top: rect.top, bottom: rect.bottom, height: rect.height, opacity: style.opacity,
              visibility: style.visibility, display: style.display, contentVisibility: style.contentVisibility,
              overflow: style.overflow, hidden: ancestor.getAttribute("aria-hidden") })
          }
          return result
        })() : undefined,
      })
    }, 40)
    const selectedReasoningMarker = `reasoning-${first.id}-chunk-0-`
    const reasoningChunkVisibleAt = await waitFor(() => {
      const node = document.querySelector<HTMLElement>("[data-component='reasoning-part']")
      return node?.innerText.includes(selectedReasoningMarker) ? Date.now() : false
    }, () => {
      const diagnostic = snapshot()
      const messages = (diagnostic.reducerStore as { messages?: Array<{ id?: string; parts?: Array<{ type?: string; text?: string }> }> } | undefined)?.messages ?? []
      const timeline = diagnostic.timelineModel as { messages?: Array<{ id?: string; parts?: Array<{ type?: string; text?: string }> }>; visibleMessages?: Array<{ id?: string }> } | undefined
      return `selected live reasoning delta did not reach a visible reasoning summary: ${selectedReasoningMarker}; settings=${diagnostic.showReasoningSummariesStorage}; reasoningNodes=${document.querySelectorAll("[data-component='reasoning-part']").length}; storeTail=${JSON.stringify(messages.slice(-3).map((message) => ({ id: message.id, parts: message.parts?.map((part) => ({ type: part.type, length: part.text?.length, preview: part.text?.slice(0, 80) })) })))}; timeline=${JSON.stringify(timeline?.messages?.slice(-3).map((message) => ({ id: message.id, parts: message.parts?.map((part) => ({ type: part.type, length: part.text?.length })) })))}; renderer=${JSON.stringify(diagnostic.timelineRenderer)}; decoded=${JSON.stringify((diagnostic.decodedEventFrames as Array<{ type: string; payloadPreview?: string }>).filter((event) => event.type.includes("message.part") || event.payloadPreview?.includes("reasoning")).slice(-12))}; body=${document.body.innerText.slice(-1200)}`
    }, 10_000)
    const reasoningVisibleSnapshot = snapshot()
    const reasoningVisibleMessages = (reasoningVisibleSnapshot.reducerStore as { messages?: Array<{ id?: string; parts?: Array<{ id?: string; type?: string; text?: string; textDeltaLength?: number }> }> } | undefined)?.messages ?? []
    const reasoningVisibleAssistant = reasoningVisibleMessages.at(-1)
    const reasoningVisiblePart = reasoningVisibleAssistant?.parts?.find((part) => part.type === "reasoning")
    const reasoningVisibleDOM = reasoningVisiblePart?.id
      ? document.querySelector<HTMLElement>(`[data-component='reasoning-part'][data-timeline-part-id="${reasoningVisiblePart.id}"]`)
      : document.querySelector<HTMLElement>("[data-component='reasoning-part']")
    const reasoningVisibleClientState = {
      sessionID: reasoningVisibleSnapshot.activeSessionID,
      messageID: reasoningVisibleAssistant?.id,
      partID: reasoningVisiblePart?.id,
      durableChars: reasoningVisiblePart?.text?.length ?? 0,
      deltaChars: reasoningVisiblePart?.textDeltaLength,
      renderedChars: reasoningVisibleDOM?.innerText.length ?? 0,
      rowKeys: (reasoningVisibleSnapshot.timelineRenderer as { timelineRows?: Array<{ key?: string }> } | undefined)?.timelineRows?.slice(-8),
      visibleRows: (reasoningVisibleSnapshot.timelineRenderer as { virtualRowKeys?: string[] } | undefined)?.virtualRowKeys?.slice(-8),
      showReasoningSummariesStorage: reasoningVisibleSnapshot.showReasoningSummariesStorage,
    }
    // The fixture stamps its first chunk at `reasoningStarted.at` (within the
    // same server turn). Click immediately when chunk 0 first reaches the DOM;
    // status diagnostics follow the actual production input event.
    const visibleChunkLagMs = reasoningChunkVisibleAt - reasoningStarted.at
    if (!Number.isFinite(visibleChunkLagMs) || visibleChunkLagMs < 0) throw new Error(`reasoning delta timing was not measurable: ${JSON.stringify({ visibleChunkLagMs, reasoningStarted })}`)
    const stop = document.querySelector<HTMLButtonElement>("button[data-slot='prompt-turn-baton']")
    if (!stop || stop.getAttribute("aria-disabled") === "true") {
      clearInterval(reasoningSampleTimer)
      throw new Error(`production Stop control was unavailable after visible reasoning arrived: ${JSON.stringify({ button: stop?.outerHTML, visibleChunkLagMs, visibleAt: reasoningChunkVisibleAt, client: reasoningVisibleClientState, clientSamples: reasoningClientSamples, clickTime: Date.now() })}`)
    }
    const stopRect = stop.getBoundingClientRect()
    const clickAt = Date.now()
    const ackCountBefore = controlAcks.length
    const clickDispatch = await window.__fullAppGateControl!.clickStop({ x: stopRect.left + stopRect.width / 2, y: stopRect.top + stopRect.height / 2 })
    await waitFor(() => window.__fullAppGateStopClickHandledAt !== undefined,
      () => `Chromium Stop click was not handled by the production DOM: ${JSON.stringify(snapshot().visibleBodyText.slice(-800))}`, 5_000)
    const stopHandlerAt = window.__fullAppGateStopClickHandledAt!
    await waitFor(() => controlAcks.slice(ackCountBefore).some((ack) => /\/(?:abort|interrupt)$/.test(ack.path) && ack.status === 200),
      () => `production Stop click did not receive an HTTP interrupt acknowledgement: ${JSON.stringify(controlAcks.slice(ackCountBefore))}`, 5_000)
    const interruptAck = controlAcks.slice(ackCountBefore).find((ack) => /\/(?:abort|interrupt)$/.test(ack.path) && ack.status === 200)!
    const clickToInterruptAckMs = interruptAck.at - stopHandlerAt
    const reasoningStatusResponse = await originalFetch(`${modelControlURL}gate/reasoning/status`)
    const reasoningStatus = await reasoningStatusResponse.json() as Array<{ sessionID: string; chunkTimes: number[]; chunksWritten: number; closedAt?: number; finishedAt?: number }>
    const selectedRun = reasoningStatus.find((run) => run.sessionID === first.id)
    const backgroundLiveAtStop = reasoningStatus.filter((run) => run.sessionID !== first.id && run.chunksWritten > 0 && run.closedAt === undefined && run.finishedAt === undefined).length
    await waitFor(() => {
      const status = (snapshot().reducerStore as { status?: { type?: string } } | undefined)?.status
      return status?.type !== "busy"
    }, () => `selected reasoning session did not stop after interrupt ACK: ${JSON.stringify(snapshot().reducerStore)}`, 5_000)
    let selectedProviderClosed: number | undefined
    const providerCloseDeadline = performance.now() + 5_000
    while (performance.now() < providerCloseDeadline && selectedProviderClosed === undefined) {
      const response = await originalFetch(`${modelControlURL}gate/reasoning/status`)
      const runs = await response.json() as Array<{ sessionID: string; closedAt?: number; chunksWritten: number }>
      selectedProviderClosed = runs.find((run) => run.sessionID === first.id)?.closedAt
      if (selectedProviderClosed === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    if (selectedProviderClosed === undefined) throw new Error("selected provider reasoning stream did not close after Stop")
    clearInterval(reasoningSampleTimer)
    const reasoningTrace = await window.__fullAppGateControl!.traceStop(reasoningScenario)
    const reactiveWork = window.__fullAppGateReactiveWork?.stop()
    const reasoningStop = {
      runningToolOutput,
      sessionIDs: reasoningIDs,
      startedAt: reasoningStarted.at,
      visibleChunk: 0,
      visibleChunkLagMs,
      clickDispatch,
      stopHandlerLagMs: stopHandlerAt - clickAt,
      clickToInterruptAckMs,
      interruptAck,
      backgroundLiveAtStop,
      selectedProviderClosedMs: Number(selectedProviderClosed) - stopHandlerAt,
      trace: reasoningTrace,
      reactiveWork,
      statusAtClick: reasoningStatus,
      clientSamples: reasoningClientSamples,
      final: snapshot(),
    }
    if (backgroundLiveAtStop !== 5) throw new Error(`reasoning Stop did not compete with five live background streams: ${JSON.stringify(reasoningStop)}`)
    if (visibleChunkLagMs > 750 || reasoningStop.stopHandlerLagMs > 750 || clickToInterruptAckMs > 1_500 || reasoningStop.selectedProviderClosedMs > 1_500) {
      throw new Error(`reasoning streaming/Stop exceeded responsiveness bounds: ${JSON.stringify(reasoningStop)}`)
    }

    // Exercise a real replay-epoch gap through the mounted production session
    // page. Holding only the renderer's event stream leaves ordinary sidecar
    // requests available while the fixture-owned sidecar restarts. Prompt
    // traffic commits durable history while the old cursor is unable to observe
    // events; reopening the stream must therefore trigger page-owned history
    // repair through the active-interest gap hook.
    if (!(window.__fullAppRoute ?? "").endsWith(`/session/${first.id}`)) {
      throw new Error(`replay-gap scenario requires the production detail route to remain mounted: ${window.__fullAppRoute}`)
    }
    const historyBeforeGap = historyResponses.filter((item) => item.path === `/session/${first.id}/message`).length
    const sseOpensBeforeGap = sseOpens
    const rootReadsBeforeGap = Object.values(rootReadsByDirectory).reduce((sum, value) => sum + value, 0)
    const sessionRootReadsBeforeGap = sessionRootReads
    const gapFramesBefore = decodedEventFrames.filter((item) => item.type === "server.stream.gap").length
    const gapCycle = historySeedCycles + 100
    const gapPrompt = `full-app-gate-${first.id}-cycle-${gapCycle}`
    window.__fullAppGateGapRepairCalls = []
    const metadataStarts = () =>
      (requestCounts["GET /config"] ?? 0) + (requestCounts["GET /agent"] ?? 0)
    const metadataCompletions = () =>
      requestTimings.filter((item) => item.method === "GET" && (item.path === "/config" || item.path === "/agent")).length +
      requestFailures.filter((item) => item.method === "GET" && (item.path === "/config" || item.path === "/agent")).length
    let stableMetadataStarts = metadataStarts()
    let stableMetadataSince = performance.now()
    await waitFor(() => {
      const starts = metadataStarts()
      if (starts !== stableMetadataStarts) {
        stableMetadataStarts = starts
        stableMetadataSince = performance.now()
      }
      return metadataCompletions() === starts && performance.now() - stableMetadataSince >= 1_500
    }, () => `config/agent requests were not settled before the controlled sidecar restart; starts=${metadataStarts()}; completions=${metadataCompletions()}`, 15_000)
    window.__fullAppGateHoldEventStream = true
    const gapRestartStartedAt = performance.now()
    controlledSidecarRestartWindow = true
    const gapRestart = await window.__fullAppGateControl!.restartSidecar()
    const gapRestartCompletedAt = performance.now()
    await waitFor(() => (window.__fullAppGateHeldEventStreamCount?.() ?? 0) > 0,
      () => `event SSE reconnect was not held after sidecar restart; requests=${JSON.stringify(requestCounts)}; frames=${JSON.stringify(decodedEventFrames.slice(-20))}`, 15_000)
    const gapAdmission = await sidecar(`session/${encodeURIComponent(first.id)}/prompt_async?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "full-app-gate", modelID: "gate-model" },
        parts: [{ type: "text", text: gapPrompt }],
      }),
    })
    if (gapAdmission.status !== 204) throw new Error(`gap prompt admission failed (${gapAdmission.status})`)
    const gapReleaseResponse = await originalFetch(`${modelControlURL}gate/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [{ id: first.id, cycle: gapCycle }] }),
    })
    if (!gapReleaseResponse.ok) throw new Error(`gap model release endpoint failed (${gapReleaseResponse.status})`)
    const gapRelease = await gapReleaseResponse.json() as { released?: string[]; missing?: string[] }
    if (gapRelease.missing?.length) throw new Error(`gap model stream was not observed: ${gapRelease.missing.join(",")}`)
    // Provider EOF is not the session owner's persistence/cleanup barrier.
    // Keep SSE held until RunState releases the observed provider generation;
    // otherwise this exercises an incidental in-flight race instead of repair
    // of an already-durable transcript. Use the existing Tier 0 status owner,
    // not a diagnostic history hydration that could mask the missing content.
    const gapCompletionStartedAt = performance.now()
    const gapCompletionStatus = await waitSessionsIdle([first.id])
    const gapCompletionWaitMs = performance.now() - gapCompletionStartedAt
    await waitFor(() => (window.__fullAppGateHeldEventStreamCount?.() ?? 0) > 0,
      "renderer event stream was not still held after durable prompt completion", 5_000)
    await window.__fullAppGateReleaseEventStream?.()
    await waitFor(() => decodedEventFrames.filter((item) => item.type === "server.stream.gap").length > gapFramesBefore,
      () => `reconnect did not receive a real replay-epoch gap; eventFrames=${JSON.stringify(decodedEventFrames.slice(-30))}; restart=${JSON.stringify(gapRestart)}`, 15_000)
    await waitFor(() => (window.__fullAppGateGapRepairCalls?.length ?? 0) > 0,
      () => `real server.stream.gap did not invoke active-interest history repair; frames=${JSON.stringify(decodedEventFrames.slice(-30))}`, 5_000)
    const gapRepairSessions = window.__fullAppGateGapRepairCalls?.at(-1) ?? []
    if (!gapRepairSessions.includes(first.id)) throw new Error(`gap repair omitted mounted session ${first.id}: ${JSON.stringify(gapRepairSessions)}`)
    await waitFor(() => historyResponses.filter((item) => item.path === `/session/${first.id}/message`).length > historyBeforeGap,
      () => `active session gap repair did not reread authoritative message history; history=${JSON.stringify(historyResponses.slice(-10))}; repair=${JSON.stringify(window.__fullAppGateGapRepairCalls)}`, 15_000)
    await waitFor(() => document.body.innerText.includes(gapPrompt) && document.body.innerText.includes(`full-app-gate-tail-${first.id}-cycle-${gapCycle}`),
      () => `replay-gap repair did not converge visible history; route=${window.__fullAppRoute}; tail=${JSON.stringify(document.body.innerText.slice(-2200))}; history=${JSON.stringify(historyResponses.slice(-10))}; repairs=${JSON.stringify(window.__fullAppGateGapRepairCalls)}; store=${JSON.stringify((window as any).__fullAppGateReadServerSession?.(first.id)?.messages?.slice(-3))}; events=${JSON.stringify(decodedEventFrames.slice(-10))}`, 15_000)
    // Health polling is intentionally low-frequency. Probe once after the
    // controlled restart so this gate verifies recovered health directly
    // instead of depending on an incidental 30-second poll landing in-window.
    const recoveredHealth = await sidecar("api/health")
    if (!recoveredHealth.ok) throw new Error(`sidecar health did not recover after the controlled restart (${recoveredHealth.status})`)
    await waitFor(() => requestTimings.some((item) => item.method === "GET" && item.path === "/api/health" && item.status >= 200 && item.status < 300 && item.startedAt >= gapRestartCompletedAt),
      () => `sidecar health did not recover after the controlled restart; timings=${JSON.stringify(requestTimings.filter((item) => item.path === "/api/health").slice(-8))}; globalSDKProviders=${JSON.stringify((window as any).__fullAppGateGlobalSDKProviders ?? [])}`, 10_000)
    controlledSidecarRestartWindow = false
    const outageHealthFailures = requestFailures.filter((item) => item.method === "GET" && (item.path === "/api/health" || item.path === "/global/health") && item.at >= gapRestartStartedAt && item.at <= gapRestartCompletedAt)
    const backgroundRestartFailures = requestFailures.filter((item) => item.at >= gapRestartStartedAt && item.at <= gapRestartCompletedAt && item.method === "GET" && (item.path === "/experimental/openrouter-free-usage" || item.path === "/instance/identity"))
    const criticalRestartFailures = requestFailures.filter((item) => item.at >= gapRestartStartedAt && item.at <= gapRestartCompletedAt && !(item.method === "GET" && (item.path === "/api/health" || item.path === "/global/health" || item.path === "/experimental/openrouter-free-usage" || item.path === "/instance/identity")))
    const rootReadsAfterGap = Object.values(rootReadsByDirectory).reduce((sum, value) => sum + value, 0)
    const eventGapRepair = {
      sidecarRestartPID: gapRestart.pid,
      sessionIdleBeforeStreamRelease: gapCompletionStatus[first.id]?.type !== "busy",
      completionWaitMs: gapCompletionWaitMs,
      restartStartedAt: gapRestartStartedAt,
      restartCompletedAt: gapRestartCompletedAt,
      plannedOutageHealthFailures: outageHealthFailures,
      backgroundRestartFailures,
      criticalRestartFailures,
      restartWindowConsoleErrors: consoleErrorRecords.filter((item) => item.at >= gapRestartStartedAt && item.at <= gapRestartCompletedAt),
      healthRecovered: true,
      globalSDKProviders: [...(((window as any).__fullAppGateGlobalSDKProviders ?? []) as unknown[])],
      rootReadDelta: rootReadsAfterGap - rootReadsBeforeGap,
      sessionRootReadDelta: sessionRootReads - sessionRootReadsBeforeGap,
      heldStreamRequests: window.__fullAppGateHeldEventStreamCount?.() ?? 0,
      gapFrames: decodedEventFrames.filter((item) => item.type === "server.stream.gap").length - gapFramesBefore,
      activeSessionIDs: gapRepairSessions,
      historyReads: historyResponses.filter((item) => item.path === `/session/${first.id}/message`).length - historyBeforeGap,
      promptVisible: document.body.innerText.includes(gapPrompt),
      assistantTailVisible: document.body.innerText.includes(`full-app-gate-tail-${first.id}-cycle-${gapCycle}`),
      route: window.__fullAppRoute,
      sseOpensBeforeGap,
      sseOpenDelta: sseOpens - sseOpensBeforeGap,
    }

    const releaseHeld = heldOptional.splice(0)
    window.__fullAppGateOptionalHold = false
    await Promise.all(releaseHeld.map((release) => release()))
    return { cold, coldElapsedMs, coldSinceGateMs, startupTrace: startupTraceResult, newSessionRoute, newSessionMilestones: startupNewSessionMilestones, rowVisibilityMs, locationFailures, visibleBeforeSelect, selected, detailReadyMs, usageScanContention, historySeed: { cycles: historySeedCycles, elapsedMs: historySeedElapsedMs, trace: historySeedTrace, tailTrace: historySeedTailTrace }, scenarios, reasoningStop, eventGapRepair, final: snapshot(), heldOptionalCount, heldOptionalPaths: [...heldOptionalPaths] }
  },
}
