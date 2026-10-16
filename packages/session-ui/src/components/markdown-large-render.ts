import WorkerURL from "./markdown-large.worker.ts?worker&url"
import type { LargeMarkdownFragment } from "./markdown-large-protocol"
import { markdownKeyBelongsToOwner } from "./markdown-worker-protocol"

// One lazy isolated worker owns large-body parsing. Normal selected/tail work
// never shares its transport or CPU lane. Waiting jobs retain model string
// references; only the active owner transfers one bounded chunk at a time.
type Job = {
  key: string
  text: string
  page: (page: LargeMarkdownFragment, signal: AbortSignal) => Promise<void>
  controller: AbortController
  resolve: () => void
  reject: (error: Error) => void
}
type Response = { id: number; error?: string; page?: LargeMarkdownFragment; done?: boolean }
let worker: Worker | undefined
let sequence = 0
let active: Job | undefined
const waiting = new Map<string, Job>()
let pending: { id: number; resolve: (value: Response) => void; reject: (error: Error) => void } | undefined

export class LargeMarkdownCancelledError extends Error {}

function transport() {
  if (worker) return worker
  worker = new Worker(WorkerURL, { type: "module" })
  const instance = worker
  instance.onmessage = (event: MessageEvent<Response>) => {
    if (worker !== instance) return
    if (pending?.id !== event.data.id) return
    const call = pending
    pending = undefined
    if (event.data.error) call.reject(new Error(event.data.error))
    else call.resolve(event.data)
  }
  instance.onerror = (event) => {
    if (worker !== instance) return
    const error = new Error(event.message || "Large Markdown worker failed")
    const stopped = active
    active = undefined
    stopped?.controller.abort()
    stopped?.reject(error)
    pending?.reject(error)
    pending = undefined
    worker?.terminate()
    worker = undefined
    void drain()
  }
  return worker
}

function request(job: Job, type: "start" | "append" | "finish" | "next", text?: string) {
  return new Promise<Response>((resolve, reject) => {
    if (active !== job || job.controller.signal.aborted) {
      reject(new LargeMarkdownCancelledError())
      return
    }
    const id = ++sequence
    pending = { id, resolve, reject }
    try { transport().postMessage({ id, type, text }) } catch (error) {
      pending = undefined
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function drain() {
  if (active) return
  const job = waiting.values().next().value as Job | undefined
  if (!job) return
  waiting.delete(job.key)
  active = job
  try {
    await request(job, "start")
    for (let offset = 0; offset < job.text.length; offset += 64 * 1024) {
      if (active !== job) throw new LargeMarkdownCancelledError()
      await request(job, "append", job.text.slice(offset, offset + 64 * 1024))
    }
    await request(job, "finish")
    while (active === job) {
      const result = await request(job, "next")
      if (active !== job) throw new LargeMarkdownCancelledError()
      if (result.done) break
      if (result.page) await job.page(result.page, job.controller.signal)
    }
    if (active === job) job.resolve()
  } catch (error) {
    job.reject(error instanceof Error ? error : new Error(String(error)))
  } finally {
    if (active === job) active = undefined
    void drain()
  }
}

export function renderLargeMarkdown(key: string, text: string, page: Job["page"]) {
  cancelLargeMarkdown(key)
  const result = new Promise<void>((resolve, reject) => waiting.set(key, { key, text, page, controller: new AbortController(), resolve, reject }))
  void drain()
  return result
}

export function cancelLargeMarkdown(key: string) {
  const queued = waiting.get(key)
  if (queued) {
    waiting.delete(key)
    queued.controller.abort()
    queued.reject(new LargeMarkdownCancelledError())
  }
  if (active?.key !== key) return
  const stopped = active
  active = undefined
  stopped.controller.abort()
  // A synchronous parser cannot process a cancellation message while running.
  // Termination releases that worker and its entire source/AST lifetime.
  worker?.terminate()
  worker = undefined
  pending?.reject(new LargeMarkdownCancelledError())
  pending = undefined
  stopped.reject(new LargeMarkdownCancelledError())
}

export function disposeLargeMarkdownOwner(owner: string) {
  for (const key of [...waiting.keys(), ...(active ? [active.key] : [])])
    if (markdownKeyBelongsToOwner(owner, key)) cancelLargeMarkdown(key)
}

export function largeMarkdownRenderSnapshot() {
  return { queuedJobs: waiting.size, activeJobs: active ? 1 : 0, pendingRequests: pending ? 1 : 0 }
}
