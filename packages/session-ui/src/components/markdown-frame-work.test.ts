import { afterEach, expect, test } from "bun:test"
import {
  MARKDOWN_FRAME_WORK_MAX_JOB_BYTES,
  MARKDOWN_FRAME_WORK_FRAME_STEPS,
  MARKDOWN_FRAME_WORK_FRAME_MS,
  cancelMarkdownFrameWork,
  markdownFrameWorkSnapshot,
  reserveMarkdownFrameWork,
  runMarkdownFrameWork,
} from "./markdown-frame-work"

const originalDocument = globalThis.document
const originalFrame = globalThis.requestAnimationFrame
let frames: Array<FrameRequestCallback> = []

function installFrame() {
  frames = []
  Object.assign(globalThis, {
    document: { hidden: false },
    requestAnimationFrame: (callback: FrameRequestCallback) => (frames.push(callback), frames.length),
  })
}

function restoreFrame() {
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: originalDocument })
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: originalFrame,
  })
}

afterEach(restoreFrame)

test("the shared owner batches tiny sanitizers with tail priority and bounded task count", async () => {
  installFrame()
  const runs: string[] = []
  const jobs = ["visible-a", "tail-a", "visible-b", "background"].map((key) =>
    runMarkdownFrameWork({
      key,
      priority: key.startsWith("tail") ? "tail" : key.startsWith("background") ? "background" : "visible",
      bytes: 32,
      current: () => true,
      run: () => runs.push(key),
    }),
  )
  expect(markdownFrameWorkSnapshot().queuedJobs).toBe(4)
  while (frames.length) {
    const before = runs.length
    frames.shift()!(0)
    await Promise.resolve()
    expect(runs.length - before).toBeLessThanOrEqual(MARKDOWN_FRAME_WORK_FRAME_STEPS)
  }
  await Promise.all(jobs)
  expect(runs).toHaveLength(4)
  expect(runs[0]).toBe("tail-a")
  expect(markdownFrameWorkSnapshot().queuedJobs).toBe(0)
})

test("sanitizer batches stop after the CPU budget and retain the next job", async () => {
  installFrame()
  const runs: number[] = []
  const jobs = [1, 2].map((value) => runMarkdownFrameWork({
    key: `cpu-budget:${value}`, priority: "visible", bytes: 32, current: () => true,
    run: () => {
      const start = performance.now()
      while (performance.now() - start <= MARKDOWN_FRAME_WORK_FRAME_MS + 1) {}
      runs.push(value)
    },
  }))
  frames.shift()!(0)
  expect(runs).toEqual([1])
  expect(markdownFrameWorkSnapshot().queuedJobs).toBe(1)
  while (frames.length) frames.shift()!(0)
  await Promise.all(jobs)
  expect(runs).toEqual([1, 2])
})

test("sanitizer batching charges actual input bytes and does not combine two capped jobs", async () => {
  installFrame()
  const runs: number[] = []
  const jobs = [1, 2].map((value) => runMarkdownFrameWork({
    key: `byte-budget:${value}`, priority: "visible", bytes: MARKDOWN_FRAME_WORK_MAX_JOB_BYTES,
    current: () => true, run: () => runs.push(value),
  }))
  frames.shift()!(0)
  expect(runs).toEqual([1])
  while (frames.length) frames.shift()!(0)
  await Promise.all(jobs)
  expect(runs).toEqual([1, 2])
})

test("owner cancellation discards queued sanitizer work and oversized tasks fail closed", async () => {
  installFrame()
  const work = runMarkdownFrameWork({
    key: "owner:session:block:0",
    priority: "background",
    bytes: 32,
    current: () => true,
    run: () => "should not run",
  })
  const settled = work.then(
    () => undefined,
    (error) => error,
  )
  cancelMarkdownFrameWork("owner")
  const error = await settled
  expect(error).toBeInstanceOf(Error)
  while (frames.length) frames.shift()!(0)
  await expect(
    runMarkdownFrameWork({
      key: "oversized",
      priority: "visible",
      bytes: MARKDOWN_FRAME_WORK_MAX_JOB_BYTES + 1,
      current: () => true,
      run: () => 1,
    }),
  ).rejects.toThrow(/per-job byte bound/)
  expect(markdownFrameWorkSnapshot().queuedJobs).toBe(0)
  expect(frames).toHaveLength(0)
})

test("more than 64 rich demands wait behind one bounded owner and eventually drain", async () => {
  installFrame()
  const runs: number[] = []
  const demands = Array.from({ length: 80 }, (_, index) =>
    (async () => {
      const key = `rich-demand:${index}`
      const reservation = await reserveMarkdownFrameWork({ key, bytes: 64, current: () => true })
      await runMarkdownFrameWork(
        {
          key,
          priority: "visible",
          bytes: 64,
          current: () => true,
          run: () => runs.push(index),
        },
        reservation,
      )
    })(),
  )
  let turns = 0
  while (
    (markdownFrameWorkSnapshot().queuedJobs > 0 ||
      markdownFrameWorkSnapshot().reservedJobs > 0 ||
      markdownFrameWorkSnapshot().waitingDemand > 0) &&
    turns++ < 500
  ) {
    if (frames.length) frames.shift()!(0)
    await Promise.resolve()
  }
  await Promise.all(demands)
  expect(runs).toHaveLength(80)
  expect(markdownFrameWorkSnapshot().queuedJobs).toBe(0)
  expect(markdownFrameWorkSnapshot().reservedJobs).toBe(0)
  expect(markdownFrameWorkSnapshot().waitingDemand).toBe(0)
})
