import type { CDPSession, Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { benchmark, expect } from "../benchmark"
import { performanceBackendUrl } from "../performance-ports"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { expectAppVisible } from "../../utils/waits"

const directory = "C:/OpenCode/ModelSelectorPerformance"
const projectID = "proj_model_selector_perf"
const sessionID = "ses_model_selector_perf"
const backendURL = performanceBackendUrl()

type CpuMetrics = {
  task: number
  script: number
  layout: number
  style: number
}

async function cpuMetrics(cdp: CDPSession): Promise<CpuMetrics> {
  const result = await cdp.send("Performance.getMetrics")
  const metrics = new Map((result.metrics as Array<{ name: string; value: number }>).map((entry) => [entry.name, entry.value]))
  return {
    task: (metrics.get("TaskDuration") ?? 0) * 1_000,
    script: (metrics.get("ScriptDuration") ?? 0) * 1_000,
    layout: (metrics.get("LayoutDuration") ?? 0) * 1_000,
    style: (metrics.get("RecalcStyleDuration") ?? 0) * 1_000,
  }
}

function cpuDelta(after: CpuMetrics, before: CpuMetrics): CpuMetrics {
  return {
    task: after.task - before.task,
    script: after.script - before.script,
    layout: after.layout - before.layout,
    style: after.style - before.style,
  }
}

function subtractCpu(value: CpuMetrics, baseline: CpuMetrics): CpuMetrics {
  return {
    task: Math.max(0, value.task - baseline.task),
    script: Math.max(0, value.script - baseline.script),
    layout: Math.max(0, value.layout - baseline.layout),
    style: Math.max(0, value.style - baseline.style),
  }
}

async function settleSearchWindow(page: Page) {
  await page.waitForTimeout(105)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

function summarizeProfile(profile: {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number } }>
  samples?: number[]
  timeDeltas?: number[]
}) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]))
  const totals = new Map<string, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const frame = nodes.get(samples[i]!)
    if (!frame) continue
    const url = frame.url ? frame.url.replace(/^.*\/assets\//, "assets/") : "(internal)"
    const key = `${frame.functionName || "(anonymous)"} @ ${url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
    totals.set(key, (totals.get(key) ?? 0) + (deltas[i] ?? 0) / 1_000)
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([frame, selfMs]) => ({ frame, selfMs: Number(selfMs.toFixed(2)) }))
}

const modelCounts = () =>
  (process.env.MODEL_SELECTOR_BENCH_MODELS ?? "644")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)

const lifecycleCycles = () => Math.max(0, Number(process.env.MODEL_SELECTOR_BENCH_CYCLES ?? 0) || 0)

function providerFixture(count: number) {
  return {
    id: "bench",
    name: "Bench",
    models: Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const id = `model-${index.toString().padStart(4, "0")}`
        return [
          id,
          {
            id,
            name: `Model ${index.toString().padStart(4, "0")}`,
            family: `family-${index % 40}`,
            cost: {
              input: 0.1 + (index % 23) / 10,
              output: 0.2 + (index % 31) / 10,
              cache: {
                read: 0.02 + (index % 11) / 100,
                write: 0,
              },
            },
            limit: { context: 32_000 + (index % 8) * 32_000 },
          },
        ]
      }),
    ),
  }
}

async function openSelector(page: Page) {
  // The composer briefly renders a Suspense fallback with the same visual
  // control before the actual MenuV2 trigger owns it. Wait for the interactive
  // popover trigger so the benchmark measures selector work, not catalog boot.
  const control = page.locator('[data-action="prompt-model"][data-control-type="popover"][aria-haspopup]').last()
  await expect(control).toBeVisible()
  const box = await control.boundingBox()
  if (!box) throw new Error("Model selector trigger has no layout box")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.evaluate(() => {
    const durations: number[] = []
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) durations.push(entry.duration)
    })
    observer.observe({ entryTypes: ["longtask"] })
    ;(window as any).__modelSelectorBench = { start: performance.now(), durations, observer }
  })
  // Kobalte's DropdownMenu opens on pointerdown for a mouse. Use a trusted
  // Playwright mouse event rather than dispatchEvent(): the latter is an
  // untrusted approximation and became flaky across repeated close/open
  // cycles. Release only after the menu has painted, preventing the newly
  // portalled content from intercepting the same synthetic click gesture.
  await page.mouse.down()
  const input = page.locator("input[data-model-selector-search]")
  try {
    await expect(input).toBeVisible()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    return await page.evaluate(() => {
      const state = (window as any).__modelSelectorBench as {
        start: number
        durations: number[]
        observer: PerformanceObserver
      }
      state.observer.disconnect()
      return {
        openMs: performance.now() - state.start,
        longTaskCount: state.durations.length,
        longTaskMaxMs: state.durations.length > 0 ? Math.max(...state.durations) : 0,
        longTaskTotalMs: state.durations.reduce((sum, value) => sum + value, 0),
      }
    })
  } finally {
    await page.mouse.up()
  }
}

async function closeSelector(page: Page) {
  const search = page.locator("input[data-model-selector-search]")
  const control = page.locator('[data-action="prompt-model"][data-control-type="popover"][aria-haspopup]').last()
  await page.keyboard.press("Escape")
  // The menu has an exit phase where content is no longer visible but remains
  // connected. The production dismiss controller waits for disconnection plus
  // two frames before completing close actions, so lifecycle stress must obey
  // that same boundary rather than reopening a half-closed primitive.
  await expect(search).toHaveCount(0)
  await expect(control).toHaveAttribute("aria-expanded", "false")
  // Kobalte's focus scope runs its unmount autofocus/stack cleanup from a
  // setTimeout(0) *after* the menu content disconnects. Waiting only on frames
  // can reopen the menu before that macrotask executes, then the stale scope
  // steals focus/closes the new menu. Cross the timer boundary first, then let
  // the settled closed state paint before the next lifecycle iteration.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  // Give zero-delay focus-scope cleanup and any browser-generated follow-up
  // focus events their own task. This is still far faster than a human can
  // close and deliberately reopen the selector, while avoiding a synthetic
  // reopen inside the primitive's teardown tail.
  await page.waitForTimeout(50)
}

async function openSelectorForLifecycle(page: Page) {
  const control = page.locator('[data-action="prompt-model"][data-control-type="popover"][aria-haspopup]').last()
  const search = page.locator("input[data-model-selector-search]")
  await expect(control).toBeVisible()
  const box = await control.boundingBox()
  if (!box) throw new Error("Model selector trigger has no layout box")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  try {
    await expect(search).toBeVisible()
  } finally {
    await page.mouse.up()
  }
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

benchmark.describe("performance: model selector", () => {
  for (const count of modelCounts()) benchmark(`bounds open/search work and quota request fanout (${count} models)`, async ({ page, report }) => {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Performance.enable")
    const quotaPaths: string[] = []
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith("/quota/")) quotaPaths.push(path)
    })

    await mockOpenCodeServer(page, {
      strictBackendPort: true,
      directory,
      project: {
        id: projectID,
        worktree: directory,
        vcs: "git",
        name: "ModelSelectorPerformance",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        sandboxes: [],
      },
      provider: {
        all: [providerFixture(count)],
        connected: ["bench"],
        default: { providerID: "bench", modelID: "model-0000" },
      },
      sessions: [
        {
          id: sessionID,
          slug: "model-selector-performance",
          projectID,
          directory,
          title: "Model selector performance",
          version: "dev",
          time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        },
      ],
      pageMessages: () => ({ items: [] }),
      fileList: (path) =>
        path ? [] : [{ name: "ModelSelectorPerformance", path: "ModelSelectorPerformance", absolute: directory, type: "directory", ignored: false }],
      findFiles: () => ["ModelSelectorPerformance"],
    })
    await page.addInitScript(
      (server) => {
        localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
        localStorage.setItem("opencode.settings.dat:defaultServerUrl", server)
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({ list: [server], projects: {}, lastProject: {}, recentlyClosed: {} }),
        )
      },
      backendURL,
    )

    // Benchmark the selector on a settled real-session route. The draft route
    // intentionally bootstraps provider/agent state and can replace the
    // composer control while opening, which measures route bootstrap races
    // instead of selector work.
    await page.goto(`/server/${base64Encode(backendURL)}/session/${sessionID}`)
    await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))

    // Let always-mounted composer resources settle so open-induced traffic is
    // distinguishable from baseline shell/composer traffic.
    await page.waitForTimeout(650)
    const quotaBeforeOpen = quotaPaths.length
    const profileColdOpen = process.env.MODEL_SELECTOR_BENCH_PROFILE === "1"
    if (profileColdOpen) {
      await cdp.send("Profiler.enable")
      await cdp.send("Profiler.setSamplingInterval", { interval: 100 })
      await cdp.send("Profiler.start")
    }
    const coldCpuBefore = await cpuMetrics(cdp)
    const cold = await openSelector(page)
    const coldCpu = cpuDelta(await cpuMetrics(cdp), coldCpuBefore)
    if (profileColdOpen) {
      const { profile } = await cdp.send("Profiler.stop")
      console.log("SELECTOR_COLD_CPU_PROFILE", JSON.stringify({ models: count, top: summarizeProfile(profile) }))
      await cdp.send("Profiler.disable")
    }
    const search = page.locator("input[data-model-selector-search]")
    await expect(search).toBeVisible()
    const mountedOptions = await page.locator("[data-option-key]").count()
    await page.waitForTimeout(200)
    const quotaAfterColdOpen = quotaPaths.length

    // TaskDuration is cumulative main-thread CPU, unlike wall time around the
    // intentional 100 ms debounce. Measure an equally long idle window first
    // so unrelated shell timers are visible and can be subtracted explicitly.
    const idleCpuBefore = await cpuMetrics(cdp)
    await settleSearchWindow(page)
    const idleCpu = cpuDelta(await cpuMetrics(cdp), idleCpuBefore)

    const searchCpuBefore = await cpuMetrics(cdp)
    const searchStarted = await page.evaluate(() => performance.now())
    const inputDispatchMs = await search.evaluate((input: HTMLInputElement, target: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      const start = performance.now()
      setter.call(input, target)
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: target.at(-1) }))
      return performance.now() - start
    }, `Model ${(count - 1).toString().padStart(4, "0")}`)
    await settleSearchWindow(page)
    const searchSettledWallMs = (await page.evaluate(() => performance.now())) - searchStarted
    const searchCpuRaw = cpuDelta(await cpuMetrics(cdp), searchCpuBefore)
    const searchCpu = subtractCpu(searchCpuRaw, idleCpu)

    await closeSelector(page)
    const warmCpuBefore = await cpuMetrics(cdp)
    const warm = await openSelector(page)
    const warmCpu = cpuDelta(await cpuMetrics(cdp), warmCpuBefore)
    await page.waitForTimeout(200)
    const quotaAfterWarmOpen = quotaPaths.length

    const cycles = lifecycleCycles()
    let heapBeforeBytes = 0
    let heapMidBytes = 0
    let heapAfterBytes = 0
    let quotaAfterCycles = quotaAfterWarmOpen
    if (cycles > 0) {
      await closeSelector(page)
      await cdp.send("HeapProfiler.enable")
      await cdp.send("HeapProfiler.collectGarbage")
      heapBeforeBytes = (await cdp.send("Runtime.getHeapUsage")).usedSize
      for (let i = 0; i < cycles; i++) {
        try {
          await openSelectorForLifecycle(page)
        } catch (error) {
          const control = page.locator('[data-action="prompt-model"][data-control-type="popover"][aria-haspopup]').last()
          console.log(
            "SELECTOR_LIFECYCLE_FAILURE",
            JSON.stringify({
              cycle: i + 1,
              ariaExpanded: await control.getAttribute("aria-expanded"),
              activeTag: await page.evaluate(() => document.activeElement?.tagName ?? null),
              searchCount: await search.count(),
            }),
          )
          throw error
        }
        await closeSelector(page)
        if (i + 1 === Math.floor(cycles / 2)) {
          await cdp.send("HeapProfiler.collectGarbage")
          heapMidBytes = (await cdp.send("Runtime.getHeapUsage")).usedSize
        }
      }
      await cdp.send("HeapProfiler.collectGarbage")
      heapAfterBytes = (await cdp.send("Runtime.getHeapUsage")).usedSize
      quotaAfterCycles = quotaPaths.length
      await cdp.send("HeapProfiler.disable")
    }

    report(
      {
        coldOpenMs: cold.openMs,
        warmOpenMs: warm.openMs,
        coldLongTaskCount: cold.longTaskCount,
        coldLongTaskMaxMs: cold.longTaskMaxMs,
        coldLongTaskTotalMs: cold.longTaskTotalMs,
        warmLongTaskCount: warm.longTaskCount,
        warmLongTaskMaxMs: warm.longTaskMaxMs,
        warmLongTaskTotalMs: warm.longTaskTotalMs,
        coldTaskCpuMs: coldCpu.task,
        coldScriptCpuMs: coldCpu.script,
        coldLayoutCpuMs: coldCpu.layout,
        coldStyleCpuMs: coldCpu.style,
        warmTaskCpuMs: warmCpu.task,
        warmScriptCpuMs: warmCpu.script,
        warmLayoutCpuMs: warmCpu.layout,
        warmStyleCpuMs: warmCpu.style,
        searchInputDispatchMs: inputDispatchMs,
        searchSettledWallMs,
        searchTaskCpuRawMs: searchCpuRaw.task,
        searchTaskCpuMs: searchCpu.task,
        searchScriptCpuMs: searchCpu.script,
        searchLayoutCpuMs: searchCpu.layout,
        searchStyleCpuMs: searchCpu.style,
        searchIdleTaskCpuMs: idleCpu.task,
        mountedOptions,
        quotaBeforeOpen,
        quotaColdOpenDelta: quotaAfterColdOpen - quotaBeforeOpen,
        quotaWarmOpenDelta: quotaAfterWarmOpen - quotaAfterColdOpen,
        lifecycleCycles: cycles,
        lifecycleHeapBeforeBytes: heapBeforeBytes,
        lifecycleHeapMidBytes: heapMidBytes,
        lifecycleHeapAfterBytes: heapAfterBytes,
        lifecycleHeapDeltaBytes: heapAfterBytes - heapBeforeBytes,
        lifecycleFirstHalfHeapDeltaBytes: heapMidBytes > 0 ? heapMidBytes - heapBeforeBytes : 0,
        lifecycleSecondHalfHeapDeltaBytes: heapMidBytes > 0 ? heapAfterBytes - heapMidBytes : 0,
        quotaLifecycleDelta: quotaAfterCycles - quotaAfterWarmOpen,
        quotaTotal: quotaAfterCycles,
      },
      { models: count },
    )
    await cdp.detach()
  })
})
