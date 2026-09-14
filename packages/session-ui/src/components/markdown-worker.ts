import MarkdownWorkerUrl from "./markdown.worker.ts?worker&url"
import {
  applyMarkdownWorkerResponse,
  applyMarkdownProjectionPatch,
  markdownHighlightRequest,
  markdownParseRequest,
  shouldReleaseMarkdownWorkerState,
  type HostMarkdownHighlightRequest,
  type HostMarkdownParseRequest,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
  type MarkdownWorkerState,
} from "./markdown-worker-protocol"
import { createWorkerTransport } from "./markdown-worker-transport"
import type { Projection } from "./markdown-stream"
import { markdownTraceEnabled, traceMarkdown } from "./markdown-trace"
import { hasTextPrefix } from "./text-prefix"

type HighlightPending = {
  key: string
  text: string
  language: string
  complete: boolean
  resolve: (state: MarkdownWorkerState) => void
  reject: (error: Error) => void
}

type ProjectPending = {
  key: string
  text: string
  live: boolean
  resolve: (projection: HostMarkdownProjection) => void
  reject: (error: Error) => void
}

export type HostMarkdownProjection = Projection & {
  /**
   * Exact worker-proven changed suffix relative to `fromText`. Consumers may
   * keep every block before `keep` completely inert when they still render that
   * predecessor. This is transition metadata only; it deliberately does not
   * retain the predecessor Projection object.
   */
  change?: { fromText?: string; keep: number }
}

type HostProjectRequest = { type: "project"; id: number; key: string; text: string; live: boolean }

type ParsePending = {
  key: string
  text: string
  resolve: (html: string) => void
  reject: (error: Error) => void
}

export const MARKDOWN_WORKER_LANES = 2
let workers: Worker[] | undefined
let disabled: Error | undefined
let nextID = 0
const pending = new Map<number, HighlightPending>()
const projects = new Map<number, ProjectPending>()
// Host-side projection references mirror worker state without duplicating
// strings. They are released with the component key and let project responses
// carry only a changed block suffix.
const hostProjections = new Map<string, HostMarkdownProjection>()
const parses = new Map<number, ParsePending>()
const latestParse = new Map<string, number>()
// Last parse source acknowledged successfully by the worker. The transport
// uses it only to derive append suffixes; worker eviction is repaired by an
// explicit parse-miss/full-reset handshake.
const hostParseSources = new Map<string, string>()
const states = new Map<string, MarkdownWorkerState>()
// Last source the worker successfully acknowledged for each live code stream.
// Values are existing JS strings, not copies; the bounded key set below owns
// their lifetime. This lets the transport send only append suffixes.
const hostHighlightSources = new Map<string, { text: string; language: string }>()
const keys = new Set<string>()
const latest = new Map<string, number>()
const stateSizes = new Map<string, number>()
let stateBytesTotal = 0
const MAX_STATE_BYTES = 32 * 1024 * 1024
// Each Worker is serial for a parse lane. Permit one active parse per Worker,
// not multiple hidden jobs inside one Worker. This isolates a pathological
// multi-hundred-millisecond Markdown parse from an unrelated session/key.
export const MARKDOWN_PARSE_MAX_ACTIVE = MARKDOWN_WORKER_LANES
const workerStarted = new Map<
  number,
  { kind: "parse" | "project" | "highlight"; chars: number; started: number; posted?: number }
>()

function traceWorkerStart(kind: "parse" | "project" | "highlight", id: number, chars: number) {
  if (!markdownTraceEnabled()) return
  workerStarted.set(id, { kind, chars, started: performance.now() })
}

function traceWorkerPosted(id: number) {
  const request = workerStarted.get(id)
  if (request) request.posted = performance.now()
}

function traceWorkerFinish(
  id: number,
  status: "ok" | "superseded" | "error" | "disposed",
  workerMs?: number,
  workerQueueMs?: number,
  incremental?: boolean,
) {
  const request = workerStarted.get(id)
  if (!request) return
  workerStarted.delete(id)
  const finished = performance.now()
  const dispatchWaitMs = request.posted === undefined ? finished - request.started : request.posted - request.started
  const responseWaitMs = request.posted === undefined ? 0 : finished - request.posted
  traceMarkdown({
    phase: "worker",
    kind: request.kind,
    status,
    ms: finished - request.started,
    chars: request.chars,
    workerMs,
    workerQueueMs,
    dispatchWaitMs,
    responseWaitMs,
    incremental,
  })
}

function stateBytes(state: MarkdownWorkerState) {
  return (
    state.stable.reduce((total, token) => total + token[0].length * 2 + token[1].length * 2, 0) +
    state.unstable.reduce((total, token) => total + token[0].length * 2 + token[1].length * 2, 0)
  )
}
function deleteState(key: string) {
  states.delete(key)
  stateBytesTotal -= stateSizes.get(key) ?? 0
  stateSizes.delete(key)
}

export function markdownWorkerLane(key: string) {
  // FNV-1a gives stable affinity without retaining an ever-growing key->lane
  // map. Projection/highlight state for one key therefore always stays in the
  // same Worker, while unrelated sessions distribute predictably across lanes.
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % MARKDOWN_WORKER_LANES
}

function postToWorker(request: MarkdownWorkerRequest) {
  getWorkers()[markdownWorkerLane(request.key)].postMessage(request)
}

const laneOptions = {
  maxActive: MARKDOWN_WORKER_LANES,
  maxActivePerLane: 1,
  laneOf: (request: { key: string }) => markdownWorkerLane(request.key),
}
const transport = createWorkerTransport<HostMarkdownHighlightRequest>({
  ...laneOptions,
  post: (request) => {
    traceWorkerPosted(request.id)
    postToWorker(markdownHighlightRequest(request, hostHighlightSources.get(request.key)))
  },
  supersede: (request) => {
    traceWorkerFinish(request.id, "superseded")
    const result = pending.get(request.id)
    if (!result) return
    pending.delete(request.id)
    result.reject(new MarkdownWorkerSupersededError())
  },
})
const projectTransport = createWorkerTransport<HostProjectRequest>({
  ...laneOptions,
  post: (request) => {
    traceWorkerPosted(request.id)
    const previous = hostProjections.get(request.key)
    if (previous && hasTextPrefix(request.text, previous.text)) {
      postToWorker({
        type: "project",
        id: request.id,
        key: request.key,
        live: request.live,
        baseLength: previous.text.length,
        append: request.text.slice(previous.text.length),
      })
      return
    }
    postToWorker({
      type: "project",
      id: request.id,
      key: request.key,
      live: request.live,
      text: request.text,
      reset: true,
    })
  },
  supersede: (request) => {
    traceWorkerFinish(request.id, "superseded")
    const result = projects.get(request.id)
    if (!result) return
    projects.delete(request.id)
    result.reject(new MarkdownWorkerSupersededError())
  },
})
const parseTransport = createWorkerTransport<HostMarkdownParseRequest>({
  ...laneOptions,
  maxActive: MARKDOWN_PARSE_MAX_ACTIVE,
  post: (request) => {
    traceWorkerPosted(request.id)
    postToWorker(markdownParseRequest(request, hostParseSources.get(request.key)))
  },
  supersede: (request) => {
    traceWorkerFinish(request.id, "superseded")
    if (latestParse.get(request.key) === request.id) latestParse.delete(request.key)
    const result = parses.get(request.id)
    if (!result) return
    parses.delete(request.id)
    result.reject(new MarkdownWorkerSupersededError())
  },
})

export function parseMarkdown(text: string, key = `parse:${text.length}:${text.slice(0, 32)}`) {
  getWorkers()
  const id = ++nextID
  return new Promise<string>((resolve, reject) => {
    const previous = latestParse.get(key)
    if (previous !== undefined) {
      const pending = parses.get(previous)
      if (pending) {
        parses.delete(previous)
        traceWorkerFinish(previous, "superseded")
        pending.reject(new MarkdownWorkerSupersededError())
      }
    }
    latestParse.set(key, id)
    parses.set(id, { key, text, resolve, reject })
    traceWorkerStart("parse", id, text.length)
    parseTransport.send({ type: "parse", id, key, text })
  })
}

export function projectMarkdown(key: string, text: string, live: boolean) {
  getWorkers()
  const id = ++nextID
  return new Promise<HostMarkdownProjection>((resolve, reject) => {
    projects.set(id, { key, text, live, resolve, reject })
    traceWorkerStart("project", id, text.length)
    projectTransport.send({ type: "project", id, key, text, live })
  })
}

export function disposeMarkdownProjection(key: string) {
  parseTransport.dispose(key)
  parses.forEach((request, id) => {
    if (request.key !== key) return
    parses.delete(id)
    traceWorkerFinish(id, "disposed")
    request.reject(new MarkdownWorkerDisposedError())
  })
  latestParse.delete(key)
  hostParseSources.delete(key)
  projectTransport.dispose(key)
  hostProjections.delete(key)
  projects.forEach((request, id) => {
    if (request.key !== key) return
    projects.delete(id)
    traceWorkerFinish(id, "disposed")
    request.reject(new MarkdownWorkerDisposedError())
  })
  workers?.[markdownWorkerLane(key)]?.postMessage({ type: "dispose", key } satisfies MarkdownWorkerRequest)
}

export function highlightStreamingCode(key: string, text: string, language: string, complete = false) {
  getWorkers()
  const id = ++nextID
  latest.set(key, id)
  keys.delete(key)
  keys.add(key)
  if (keys.size > 200) disposeStreamingCode(keys.values().next().value!)
  return new Promise<MarkdownWorkerState>((resolve, reject) => {
    pending.set(id, { key, text, language, complete, resolve, reject })
    traceWorkerStart("highlight", id, text.length)
    transport.send({ type: "highlight", id, key, text, language, complete })
  })
}

export function disposeStreamingCode(key: string) {
  keys.delete(key)
  latest.delete(key)
  hostHighlightSources.delete(key)
  deleteState(key)
  transport.dispose(key)
  pending.forEach((request, id) => {
    if (request.key !== key) return
    pending.delete(id)
    traceWorkerFinish(id, "disposed")
    request.reject(new MarkdownWorkerDisposedError())
  })
  workers?.[markdownWorkerLane(key)]?.postMessage({ type: "dispose", key } satisfies MarkdownWorkerRequest)
}

export class MarkdownWorkerDisposedError extends Error {}
export class MarkdownWorkerSupersededError extends Error {}
export class MarkdownWorkerUnavailableError extends Error {}

function getWorkers() {
  if (workers) return workers
  if (disabled) throw new MarkdownWorkerUnavailableError(disabled.message)
  try {
    workers = Array.from({ length: MARKDOWN_WORKER_LANES }, () => new Worker(MarkdownWorkerUrl, { type: "module" }))
  } catch (error) {
    disabled = error instanceof Error ? error : new Error(String(error))
    throw new MarkdownWorkerUnavailableError(disabled.message)
  }
  const onMessage = (event: MessageEvent<MarkdownWorkerResponse>) => {
    if (event.data.type === "parse-miss") {
      const result = parses.get(event.data.id)
      if (!result) {
        parseTransport.complete(event.data.key, event.data.id)
        return
      }
      // Keep the lane occupied while repairing worker cache eviction. A queued
      // newer parse for this key stays on the host where it remains supersedable.
      postToWorker({
        type: "parse",
        id: event.data.id,
        key: event.data.key,
        text: result.text,
        reset: true,
      })
      return
    }
    if (event.data.type === "project-miss") {
      const result = projects.get(event.data.id)
      if (!result) {
        projectTransport.complete(event.data.key, event.data.id)
        return
      }
      // The worker can evict a retained projection independently under its byte
      // budget. Retry the same active request as an explicit reset while keeping
      // its transport lane occupied; queued newer work remains supersedable.
      postToWorker({
        type: "project",
        id: event.data.id,
        key: event.data.key,
        live: result.live,
        text: result.text,
        reset: true,
      })
      return
    }
    if (event.data.type === "highlight-miss") {
      const result = pending.get(event.data.id)
      if (!result) {
        transport.complete(event.data.key, event.data.id)
        return
      }
      // The worker can evict a tokenizer stream while the host still remembers
      // the acknowledged source. Retry this exact active request as one full
      // reset; do not release the lane, so a queued newer request remains
      // supersedable and cannot overtake the repair.
      postToWorker({
        type: "highlight",
        id: event.data.id,
        key: event.data.key,
        text: result.text,
        language: result.language,
        complete: result.complete,
        reset: true,
      })
      return
    }
    traceWorkerFinish(
      event.data.id,
      event.data.type === "error" ? "error" : event.data.type === "superseded" ? "superseded" : "ok",
      "workerMs" in event.data ? event.data.workerMs : undefined,
      "workerQueueMs" in event.data ? event.data.workerQueueMs : undefined,
      "incremental" in event.data ? event.data.incremental : undefined,
    )
    if (event.data.type === "parse") {
      const result = parses.get(event.data.id)
      if (!result) {
        // The caller may have superseded or disposed this active request while
        // the worker was still parsing it. Release the keyed transport slot or
        // the newer parse for the same key would remain queued forever.
        parseTransport.complete(event.data.key, event.data.id)
        return
      }
      parses.delete(event.data.id)
      if (latestParse.get(result.key) !== event.data.id) {
        parseTransport.complete(result.key, event.data.id)
        result.reject(new MarkdownWorkerSupersededError())
        return
      }
      latestParse.delete(result.key)
      hostParseSources.set(result.key, result.text)
      result.resolve(event.data.html)
      parseTransport.complete(event.data.key, event.data.id)
      return
    }
    if (event.data.type === "project") {
      const result = projects.get(event.data.id)
      if (!result) {
        projectTransport.complete(event.data.key, event.data.id)
        return
      }
      projects.delete(event.data.id)
      const previous = hostProjections.get(result.key)
      const base = applyMarkdownProjectionPatch(previous, result.text, event.data.patch)
      const projection: HostMarkdownProjection = {
        ...base,
        change: { fromText: previous?.text, keep: event.data.patch.keep },
      }
      hostProjections.set(result.key, projection)
      result.resolve(projection)
      projectTransport.complete(event.data.key, event.data.id)
      return
    }
    if (event.data.type === "error") {
      const parsed = parses.get(event.data.id)
      if (parsed) {
        parses.delete(event.data.id)
        if (latestParse.get(parsed.key) === event.data.id) latestParse.delete(parsed.key)
        parsed.reject(new Error(event.data.message))
        parseTransport.complete(parsed.key, event.data.id)
        return
      }
      if (event.data.key) parseTransport.complete(event.data.key, event.data.id)
      const projected = projects.get(event.data.id)
      if (projected) {
        projects.delete(event.data.id)
        projected.reject(new Error(event.data.message))
        projectTransport.complete(projected.key, event.data.id)
        return
      }
    }
    if (event.data.type === "superseded") {
      const parsed = parses.get(event.data.id)
      if (parsed) {
        parses.delete(event.data.id)
        if (latestParse.get(parsed.key) === event.data.id) latestParse.delete(parsed.key)
        parsed.reject(new MarkdownWorkerSupersededError())
        parseTransport.complete(parsed.key, event.data.id)
        return
      }
      parseTransport.complete(event.data.key, event.data.id)
      const projected = projects.get(event.data.id)
      if (projected) {
        projects.delete(event.data.id)
        projected.reject(new MarkdownWorkerSupersededError())
        projectTransport.complete(projected.key, event.data.id)
        return
      }
    }
    const key = event.data.key
    if (!key) return
    const result = pending.get(event.data.id)
    if (!result) {
      transport.complete(key, event.data.id)
      return
    }
    pending.delete(event.data.id)
    if (!keys.has(key)) {
      result.reject(new MarkdownWorkerDisposedError())
      transport.complete(key, event.data.id)
      return
    }
    if (event.data.type === "superseded") {
      result.reject(new MarkdownWorkerSupersededError())
      transport.complete(key, event.data.id)
      return
    }
    if (event.data.type === "error") {
      result.reject(new Error(event.data.message))
      transport.complete(key, event.data.id)
      return
    }
    if (result.complete) hostHighlightSources.delete(key)
    else hostHighlightSources.set(key, { text: result.text, language: result.language })
    const state = applyMarkdownWorkerResponse(states.get(key), event.data)
    if (shouldReleaseMarkdownWorkerState(result.complete, latest.get(key), event.data.id)) {
      deleteState(key)
      keys.delete(key)
      latest.delete(key)
    } else {
      deleteState(key)
      const size = stateBytes(state)
      if (size <= MAX_STATE_BYTES) {
        states.set(key, state)
        stateSizes.set(key, size)
        stateBytesTotal += size
        while (stateBytesTotal > MAX_STATE_BYTES) {
          const oldest = states.keys().next().value
          if (oldest === undefined) break
          deleteState(oldest)
        }
      } else {
        // A single jumbo code block is cheaper to restart than to retain
        // indefinitely in the renderer. The next update will rehydrate it
        // through the worker's bounded stream cache.
        keys.delete(key)
        latest.delete(key)
      }
    }
    result.resolve(state)
    transport.complete(key, event.data.id)
  }
  const fail = (message: string) => {
    const error = new Error(message)
    disabled = error
    transport.reset()
    parseTransport.reset()
    projectTransport.reset()
    pending.forEach((request) => request.reject(error))
    projects.forEach((request) => request.reject(error))
    parses.forEach((request) => request.reject(error))
    workerStarted.forEach((_, id) => traceWorkerFinish(id, "error"))
    pending.clear()
    projects.clear()
    parses.clear()
    workerStarted.clear()
    latestParse.clear()
    hostParseSources.clear()
    states.clear()
    hostHighlightSources.clear()
    stateSizes.clear()
    stateBytesTotal = 0
    keys.clear()
    latest.clear()
    workers?.forEach((worker) => worker.terminate())
    workers = undefined
  }
  for (const worker of workers) {
    worker.onmessage = onMessage
    worker.onerror = (event) => fail(event.message || "Markdown highlighting worker failed")
    worker.onmessageerror = () => fail("Markdown worker response failed")
  }
  return workers
}
