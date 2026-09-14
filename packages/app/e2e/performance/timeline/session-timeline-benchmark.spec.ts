import type { Page } from "@playwright/test"
import { benchmark, benchmarkDiagnostics, expect } from "../benchmark"
import {
  buildInitialStreamEvent,
  buildStreamDeltaEvents,
  setupTimelineBenchmark,
  textPartID,
} from "./session-timeline-benchmark.fixture"
import { startTimelineProfile } from "./session-timeline-profile"
import { createReviewDiffs } from "./timeline-test-helpers"
import {
  collectTimelineStreamMetrics,
  installTimelineStreamProbe,
  startTimelineStreamProbe,
} from "./session-timeline-stream-probe"

type TimelineStreamOptions = {
  newLayoutDesigns?: boolean
  reviewDiffs?: boolean
}

benchmark.describe("performance: session timeline streaming", () => {
  benchmark("streams assistant text without remounting or oscillating", async ({ page, report }) => {
    benchmark.setTimeout(Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000) + 60_000)
    const result = await runTimelineStreamBenchmark(page, {})
    report(result.metrics, result.context)
    expect(result.metrics.completed, result.metrics.completionError).toBe(true)
  })

  benchmark("streams assistant text in v2 with review pane closed", async ({ page, report }) => {
    benchmark.setTimeout(Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000) + 60_000)
    const result = await runTimelineStreamBenchmark(page, { newLayoutDesigns: true })
    report(result.metrics, result.context)
    expect(result.metrics.completed, result.metrics.completionError).toBe(true)
  })

  benchmark("streams assistant text in v2 with review diffs and pane closed", async ({ page, report }) => {
    benchmark.setTimeout(Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000) + 60_000)
    const result = await runTimelineStreamBenchmark(page, { newLayoutDesigns: true, reviewDiffs: true })
    report(result.metrics, result.context)
    expect(result.metrics.completed, result.metrics.completionError).toBe(true)
  })
})

async function runTimelineStreamBenchmark(page: Page, options: TimelineStreamOptions) {
  const completionTimeoutMs = Number(process.env.TIMELINE_COMPLETION_TIMEOUT_MS ?? 420_000)
  const cpuThrottle = Number(process.env.TIMELINE_CPU_THROTTLE ?? 30)
  const deltaCount = Number(process.env.TIMELINE_DELTA_COUNT ?? 160)
  const historyTurns = Number(process.env.TIMELINE_HISTORY_TURNS ?? 320)
  const eventBatch = Number(process.env.TIMELINE_EVENT_BATCH ?? 1)
  const minimal = process.env.TIMELINE_MINIMAL === "1"
  const profileCPU = process.env.TIMELINE_CPU_PROFILE === "1"
  const visualSetting = process.env.TIMELINE_VISUAL_PROFILE
  const profileVisual = !minimal && (visualSetting === "1" || (visualSetting !== "0" && profileCPU))
  const diffs = options.reviewDiffs ? createReviewDiffs() : undefined
  const fixture = await setupTimelineBenchmark(page, {
    historyTurns,
    eventBatch,
    newLayoutDesigns: options.newLayoutDesigns,
    turnDiffs: options.reviewDiffs ? diffs : undefined,
  })

  fixture.transport.enqueue(buildInitialStreamEvent(deltaCount))
  const contentStart = performance.now()
  await expect(fixture.text).toBeVisible()
  await expect(fixture.text).toContainText("Implementation plan")
  const initialContentObservedMs = performance.now() - contentStart
  await fixture.scrollToBottom()
  await fixture.waitForStableGeometry()

  const profile = await startTimelineProfile(page, { cpuThrottle, profileCPU })
  await installTimelineStreamProbe(page, { textPartID, finalIndex: deltaCount, profileVisual, minimal })
  const deltas = buildStreamDeltaEvents(deltaCount)
  await startTimelineStreamProbe(page)
  fixture.transport.enqueue(deltas)

  let completed = false
  let completionError: string | undefined
  try {
    await page.waitForFunction(
      (finalIndex) =>
        (
          window as Window & {
            __timelineStreamBenchmark?: { applied: { index: number }[] }
          }
        ).__timelineStreamBenchmark?.applied.some((value) => value.index === finalIndex),
      deltaCount,
      { timeout: completionTimeoutMs },
    )
    await expect(fixture.text).toContainText("benchmark-complete")
    await expect(fixture.text).toContainText("Streaming")
    await fixture.waitForStableGeometry()
    completed = true
  } catch (error) {
    completionError = error instanceof Error ? error.message : String(error)
  }
  const metrics = await collectTimelineStreamMetrics(page, {
    textPartID,
    finalIndex: deltaCount,
    navigations: benchmarkDiagnostics(page).navigations,
  })
  const phaseTrace = await collectPhaseTraceSummary(page)
  const delivered = deltas.length - fixture.transport.pendingCount()
  await profile.stop()

  const result = {
    metrics: {
      completed,
      completionError,
      endToEndInitialContentObservedMs: initialContentObservedMs,
      ...metrics,
      phaseTrace,
      deliveredDeltas: delivered,
      pendingDeltas: fixture.transport.pendingCount(),
    },
    context: {
      cpuThrottle,
      profileCPU,
      profileVisual,
      minimal,
      queuedDeltas: deltas.length,
      historyTurns,
      eventBatch,
      newLayoutDesigns: options.newLayoutDesigns === true,
      reviewDiffs: diffs?.length ?? 0,
    },
  }

  await profile.reset()
  return result
}

async function collectPhaseTraceSummary(page: Page) {
  return page.evaluate(() => {
    type Markdown = {
      effects: number
      effectMs: number
      effectMaxMs: number
      blocks: number
      blockMs: number
      blockMaxMs: number
      sanitizeCalls: number
      sanitizeMs: number
      sanitizeMaxMs: number
      innerHTMLMs: number
      decorateMs: number
      morphMs: number
      codeMs: number
      workerRequests: number
      workerMs: number
      workerComputeMs: number
      workerInternalQueueMs: number
      workerQueueMs: number
      workerDispatchWaitMs: number
      workerResponseWaitMs: number
      workerMaxMs: number
      workerSuperseded: number
      workerErrors: number
      workerByKind: Record<string, number>
      parseIncremental: number
      parseFull: number
      parseUnknown: number
    }
    type Window = {
      frames: number
      deltas: number
      dispatchMs: number
      applyV2Ms: number
      applyMs: number
      projectionMs: number
      projectionRuns: number
      projectionTurns: number
      rowsBuilt: number
      rowsMs: number
      slowRows: number
      frameMaxMs: number
      frameStalls: number
      markdown: Markdown
    }
    type Snapshot = { windows: Window[]; current: Window; recent: Array<Record<string, unknown>> }
    const snap = (window as Window & { __opencodePhaseTrace?: () => Snapshot }).__opencodePhaseTrace?.()
    if (!snap) return null
    const windows = [...snap.windows, snap.current]
    const sum = (pick: (value: Window) => number) => windows.reduce((total, value) => total + pick(value), 0)
    const max = (pick: (value: Window) => number) => Math.max(0, ...windows.map(pick))
    const workerByKind: Record<string, number> = {}
    for (const value of windows) {
      for (const [kind, count] of Object.entries(value.markdown.workerByKind)) {
        workerByKind[kind] = (workerByKind[kind] ?? 0) + count
      }
    }
    return {
      frames: sum((value) => value.frames),
      deltas: sum((value) => value.deltas),
      dispatchMs: sum((value) => value.dispatchMs),
      applyV2Ms: sum((value) => value.applyV2Ms),
      applyMs: sum((value) => value.applyMs),
      projectionMs: sum((value) => value.projectionMs),
      projectionRuns: sum((value) => value.projectionRuns),
      projectionTurnsMax: max((value) => value.projectionTurns),
      rowsBuilt: sum((value) => value.rowsBuilt),
      rowsMs: sum((value) => value.rowsMs),
      slowRows: sum((value) => value.slowRows),
      frameMaxMs: max((value) => value.frameMaxMs),
      frameStalls: sum((value) => value.frameStalls),
      markdown: {
        effects: sum((value) => value.markdown.effects),
        effectMs: sum((value) => value.markdown.effectMs),
        effectMaxMs: max((value) => value.markdown.effectMaxMs),
        blocks: sum((value) => value.markdown.blocks),
        blockMs: sum((value) => value.markdown.blockMs),
        blockMaxMs: max((value) => value.markdown.blockMaxMs),
        sanitizeCalls: sum((value) => value.markdown.sanitizeCalls),
        sanitizeMs: sum((value) => value.markdown.sanitizeMs),
        sanitizeMaxMs: max((value) => value.markdown.sanitizeMaxMs),
        innerHTMLMs: sum((value) => value.markdown.innerHTMLMs),
        decorateMs: sum((value) => value.markdown.decorateMs),
        morphMs: sum((value) => value.markdown.morphMs),
        codeMs: sum((value) => value.markdown.codeMs),
        workerRequests: sum((value) => value.markdown.workerRequests),
        workerMs: sum((value) => value.markdown.workerMs),
        workerComputeMs: sum((value) => value.markdown.workerComputeMs),
        workerInternalQueueMs: sum((value) => value.markdown.workerInternalQueueMs),
        workerQueueMs: sum((value) => value.markdown.workerQueueMs),
        workerDispatchWaitMs: sum((value) => value.markdown.workerDispatchWaitMs),
        workerResponseWaitMs: sum((value) => value.markdown.workerResponseWaitMs),
        workerMaxMs: max((value) => value.markdown.workerMaxMs),
        workerSuperseded: sum((value) => value.markdown.workerSuperseded),
        workerErrors: sum((value) => value.markdown.workerErrors),
        parseIncremental: sum((value) => value.markdown.parseIncremental),
        parseFull: sum((value) => value.markdown.parseFull),
        parseUnknown: sum((value) => value.markdown.parseUnknown),
        workerByKind,
      },
      slowEvents: snap.recent.slice(-20),
    }
  })
}
