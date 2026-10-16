import { afterEach, expect, mock, test } from "bun:test"

mock.module("./markdown-large.worker.ts?worker&url", () => ({ default: "large-worker-fixture" }))
const { cancelLargeMarkdown, disposeLargeMarkdownOwner, largeMarkdownRenderSnapshot, renderLargeMarkdown } = await import("./markdown-large-render")
const originalWorker = globalThis.Worker
const instances: FakeWorker[] = []
let holdFinish = false
let finishArrived = Promise.withResolvers<void>()

class FakeWorker {
  onmessage?: (event: { data: unknown }) => void
  onerror?: (event: { message: string }) => void
  held?: { id: number }
  terminated = false
  next = 0
  source = ""
  maxChunk = 0
  constructor() { instances.push(this) }
  terminate() { this.terminated = true }
  postMessage(request: { id: number; type: string; text?: string }) {
    if (request.type === "start") { this.next = 0; this.source = "" }
    if (request.type === "append") { this.source += request.text; this.maxChunk = Math.max(this.maxChunk, request.text?.length ?? 0) }
    if (request.type === "finish" && holdFinish) { this.held = request; finishArrived.resolve(); return }
    const data = request.type === "next"
      ? this.next++ === 0 ? { id: request.id, page: { html: `<p>${this.source}</p>`, openIDs: [] } } : { id: request.id, done: true }
      : { id: request.id }
    queueMicrotask(() => this.onmessage?.({ data }))
  }
}

function setup() {
  instances.length = 0
  holdFinish = false
  finishArrived = Promise.withResolvers<void>()
  globalThis.Worker = FakeWorker as unknown as typeof Worker
}
afterEach(() => {
  disposeLargeMarkdownOwner("fixture")
  globalThis.Worker = originalWorker
})

test("large-body transfer is chunked and cancelled generations cannot affect a replacement worker", async () => {
  setup()
  holdFinish = true
  const stopped = renderLargeMarkdown("fixture:block:0", "a".repeat(300_000), async () => {})
  const rejection = stopped.catch((error) => error)
  await finishArrived.promise
  const old = instances[0]!
  expect(old.maxChunk).toBeLessThanOrEqual(64 * 1024)
  cancelLargeMarkdown("fixture:block:0")
  holdFinish = false
  const pages: string[] = []
  const replacement = renderLargeMarkdown("fixture:block:0", "replacement", async (page) => { pages.push(page.html) })
  old.onmessage?.({ data: { id: old.held!.id, done: true } })
  old.onerror?.({ message: "late failure from retired worker" })
  await replacement
  expect(await rejection).toBeInstanceOf(Error)
  expect(old.terminated).toBe(true)
  expect(pages).toEqual(["<p>replacement</p>"])
  expect(largeMarkdownRenderSnapshot()).toEqual({ queuedJobs: 0, activeJobs: 0, pendingRequests: 0 })
})

test("owner teardown aborts a held DOM page and lets another owner finish", async () => {
  setup()
  const arrived = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const first = renderLargeMarkdown("fixture:block:1", "held", async (_page, signal) => {
    arrived.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { aborted.resolve(); reject(new Error("page aborted")) }, { once: true }))
  }).catch((error) => error)
  await arrived.promise
  const pages: string[] = []
  const next = renderLargeMarkdown("other:block:1", "next", async (page) => { pages.push(page.html) })
  disposeLargeMarkdownOwner("fixture")
  await aborted.promise
  await next
  expect(await first).toBeInstanceOf(Error)
  expect(pages).toEqual(["<p>next</p>"])
  expect(largeMarkdownRenderSnapshot()).toEqual({ queuedJobs: 0, activeJobs: 0, pendingRequests: 0 })
})
