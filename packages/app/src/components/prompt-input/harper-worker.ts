import { harperSpanToUtf16, type HarperProjection, type PromptGrammarIssue } from "./harper-projection"
import { HarperLatestQueue } from "./harper-queue"

type WorkerDiagnostic = {
  start: number
  end: number
  kind: string
  message: string
  suggestions: readonly string[]
}

type Pending = {
  resolve: (value: WorkerDiagnostic[]) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/**
 * Hardened Vite-managed worker boundary. Unlike Harper's general-purpose
 * WorkerLinter, the app controls module-URL bundling, startup errors, request
 * lifetimes and shutdown. This module has no static Harper/WASM dependency.
 */
class HarperWorkerClient {
  private worker: Worker
  private requests = new Map<number, Pending>()
  private queue = new HarperLatestQueue<string, WorkerDiagnostic[]>((text) => this.send(text))
  private nextID = 1
  private closed = false
  private startResolve!: () => void
  private startReject!: (error: Error) => void
  private startTimeout: ReturnType<typeof setTimeout>
  readonly ready: Promise<void>

  constructor() {
    this.ready = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
    })
    this.worker = new Worker(new URL("./harper-dedicated.worker.ts", import.meta.url), { type: "module" })
    this.startTimeout = setTimeout(() => this.fail(new Error("Harper worker startup timed out")), 12_000)
    this.worker.onmessage = (event: MessageEvent<
      { type: "ready" } | { type: "error"; id?: number; message: string } |
      { type: "result"; id: number; diagnostics: WorkerDiagnostic[] }
    >) => {
      const message = event.data
      if (this.closed) return
      if (message.type === "ready") {
        clearTimeout(this.startTimeout)
        this.startResolve()
        return
      }
      if (message.type === "error") {
        if (message.id === undefined) return this.fail(new Error(message.message))
        const request = this.requests.get(message.id)
        if (!request) return
        clearTimeout(request.timeout)
        this.requests.delete(message.id)
        request.reject(new Error(message.message))
        return
      }
      const request = this.requests.get(message.id)
      if (!request) return
      clearTimeout(request.timeout)
      this.requests.delete(message.id)
      request.resolve(message.diagnostics)
    }
    this.worker.onerror = () => this.fail(new Error("Harper worker failed"))
    this.worker.onmessageerror = () => this.fail(new Error("Harper worker message failed"))
  }

  private fail(error: Error) {
    if (this.closed) return
    this.startReject(error)
    this.dispose(error)
  }

  async lint(text: string, owner: symbol, signal?: AbortSignal): Promise<WorkerDiagnostic[]> {
    await this.ready
    if (this.closed) throw new Error("Harper worker is disposed")
    return this.queue.run(owner, text, signal)
  }

  private send(text: string): Promise<WorkerDiagnostic[]> {
    return new Promise((resolve, reject) => {
      const id = this.nextID++
      const timeout = setTimeout(() => this.fail(new Error("Harper lint request timed out")), 12_000)
      this.requests.set(id, { resolve, reject, timeout })
      this.worker.postMessage({ type: "lint", id, text })
    })
  }

  cancelOwner(owner: symbol) {
    this.queue.cancelOwner(owner)
  }

  dispose(error = new Error("Harper disabled")) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.startTimeout)
    this.startReject(error)
    for (const request of this.requests.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    this.requests.clear()
    this.queue.dispose(error)
    this.worker.terminate()
  }
}

let shared: HarperWorkerClient | undefined
let subscribers = 0

export function acquireHarper() {
  const client = shared ??= new HarperWorkerClient()
  // Construction may throw when Workers are blocked by platform/CSP. Do not
  // leak a lease count for a client that was never successfully created.
  subscribers++
  const owner = Symbol("harper-composer")
  let released = false
  return {
    ready: client.ready.then(() => ({
      lint: (text: string, signal?: AbortSignal) => client.lint(text, owner, signal),
    })),
    release() {
      if (released) return
      released = true
      client.cancelOwner(owner)
      subscribers--
      if (subscribers !== 0 || shared !== client) return
      shared = undefined
      client.dispose()
    },
  }
}

export async function lintHarperProjection(
  worker: { lint(text: string, signal?: AbortSignal): Promise<WorkerDiagnostic[]> },
  input: HarperProjection,
  signal?: AbortSignal,
): Promise<PromptGrammarIssue[]> {
  const raw = await worker.lint(input.text, signal)
  const issues: PromptGrammarIssue[] = []
  for (const lint of raw) {
    const location = harperSpanToUtf16(input, lint.start, lint.end)
    if (!location || !location.original.trim()) continue
    const suggestions = [...new Set(lint.suggestions.slice(0, 4)
      .filter((value) => value.length <= 500 && value !== location.original))]
    issues.push({
      id: `${location.start}:${location.end}:${lint.kind}`,
      start: location.start, end: location.end, original: location.original,
      message: lint.message,
      category: /spell|typo/i.test(lint.kind) ? "spelling" : "grammar",
      suggestions,
    })
    if (issues.length >= 32) break
  }
  return issues.sort((a, b) => a.start - b.start || a.end - b.end)
}
