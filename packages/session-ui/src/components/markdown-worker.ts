import MarkdownWorkerUrl from "./markdown.worker.ts?worker&url"
import {
  applyMarkdownWorkerResponse,
  shouldReleaseMarkdownWorkerState,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
  type MarkdownWorkerState,
} from "./markdown-worker-protocol"
import { createWorkerTransport } from "./markdown-worker-transport"
import type { Projection } from "./markdown-stream"

type HighlightPending = {
  key: string
  complete: boolean
  resolve: (state: MarkdownWorkerState) => void
  reject: (error: Error) => void
}

type ProjectPending = {
  key: string
  resolve: (projection: Projection) => void
  reject: (error: Error) => void
}

type ParsePending = {
  key: string
  resolve: (html: string) => void
  reject: (error: Error) => void
}

let worker: Worker | undefined
let disabled: Error | undefined
let nextID = 0
const pending = new Map<number, HighlightPending>()
const projects = new Map<number, ProjectPending>()
const parses = new Map<number, ParsePending>()
const latestParse = new Map<string, number>()
const states = new Map<string, MarkdownWorkerState>()
const keys = new Set<string>()
const latest = new Map<string, number>()
const stateSizes = new Map<string, number>()
let stateBytesTotal = 0
const MAX_STATE_BYTES = 32 * 1024 * 1024
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
const transport = createWorkerTransport<Extract<MarkdownWorkerRequest, { type: "highlight" }>>({
  post: (request) => worker!.postMessage(request),
  supersede: (request) => {
    const result = pending.get(request.id)
    if (!result) return
    pending.delete(request.id)
    result.reject(new MarkdownWorkerSupersededError())
  },
})
const projectTransport = createWorkerTransport<Extract<MarkdownWorkerRequest, { type: "project" }>>({
  post: (request) => worker!.postMessage(request),
  supersede: (request) => {
    const result = projects.get(request.id)
    if (!result) return
    projects.delete(request.id)
    result.reject(new MarkdownWorkerSupersededError())
  },
})
const parseTransport = createWorkerTransport<Extract<MarkdownWorkerRequest, { type: "parse" }>>({
  post: (request) => worker!.postMessage(request),
  supersede: (request) => {
    if (latestParse.get(request.key) === request.id) latestParse.delete(request.key)
    const result = parses.get(request.id)
    if (!result) return
    parses.delete(request.id)
    result.reject(new MarkdownWorkerSupersededError())
  },
})

export function parseMarkdown(text: string, key = `parse:${text.length}:${text.slice(0, 32)}`) {
  const instance = getWorker()
  const id = ++nextID
  return new Promise<string>((resolve, reject) => {
    const previous = latestParse.get(key)
    if (previous !== undefined) {
      const pending = parses.get(previous)
      if (pending) {
        parses.delete(previous)
        pending.reject(new MarkdownWorkerSupersededError())
      }
    }
    latestParse.set(key, id)
    parses.set(id, { key, resolve, reject })
    parseTransport.send({ type: "parse", id, key, text })
  })
}

export function projectMarkdown(key: string, text: string, live: boolean) {
  getWorker()
  const id = ++nextID
  return new Promise<Projection>((resolve, reject) => {
    projects.set(id, { key, resolve, reject })
    projectTransport.send({ type: "project", id, key, text, live })
  })
}

export function disposeMarkdownProjection(key: string) {
  parseTransport.dispose(key)
  parses.forEach((request, id) => {
    if (request.key !== key) return
    parses.delete(id)
    request.reject(new MarkdownWorkerDisposedError())
  })
  latestParse.delete(key)
  projectTransport.dispose(key)
  projects.forEach((request, id) => {
    if (request.key !== key) return
    projects.delete(id)
    request.reject(new MarkdownWorkerDisposedError())
  })
  worker?.postMessage({ type: "dispose", key } satisfies MarkdownWorkerRequest)
}

export function highlightStreamingCode(key: string, text: string, language: string, complete = false) {
  const instance = getWorker()
  const id = ++nextID
  latest.set(key, id)
  keys.delete(key)
  keys.add(key)
  if (keys.size > 200) disposeStreamingCode(keys.values().next().value!)
  return new Promise<MarkdownWorkerState>((resolve, reject) => {
    pending.set(id, { key, complete, resolve, reject })
    transport.send({ type: "highlight", id, key, text, language, complete })
  })
}

export function disposeStreamingCode(key: string) {
  keys.delete(key)
  latest.delete(key)
  deleteState(key)
  transport.dispose(key)
  pending.forEach((request, id) => {
    if (request.key !== key) return
    pending.delete(id)
    request.reject(new MarkdownWorkerDisposedError())
  })
  worker?.postMessage({ type: "dispose", key } satisfies MarkdownWorkerRequest)
}

export class MarkdownWorkerDisposedError extends Error {}
export class MarkdownWorkerSupersededError extends Error {}
export class MarkdownWorkerUnavailableError extends Error {}

function getWorker() {
  if (worker) return worker
  if (disabled) throw new MarkdownWorkerUnavailableError(disabled.message)
  try {
    worker = new Worker(MarkdownWorkerUrl, { type: "module" })
  } catch (error) {
    disabled = error instanceof Error ? error : new Error(String(error))
    throw new MarkdownWorkerUnavailableError(disabled.message)
  }
  worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => {
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
      result.resolve(event.data.projection)
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
    pending.clear()
    projects.clear()
    parses.clear()
    latestParse.clear()
    states.clear()
    stateSizes.clear()
    stateBytesTotal = 0
    keys.clear()
    latest.clear()
    worker?.terminate()
    worker = undefined
  }
  worker.onerror = (event) => fail(event.message || "Markdown highlighting worker failed")
  worker.onmessageerror = () => fail("Markdown worker response failed")
  return worker
}
