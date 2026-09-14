import type { Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { benchmark, expect } from "../benchmark"
import { performanceBackendUrl } from "../performance-ports"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { expectAppVisible } from "../../utils/waits"

const directory = "C:/OpenCode/ModelSelectorPerformance"
const projectID = "proj_model_selector_perf"
const sessionID = "ses_model_selector_perf"
const backendURL = performanceBackendUrl()

const modelCounts = () =>
  (process.env.MODEL_SELECTOR_BENCH_MODELS ?? "644")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)

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
  await page.evaluate(() => {
    const durations: number[] = []
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) durations.push(entry.duration)
    })
    observer.observe({ entryTypes: ["longtask"] })
    ;(window as any).__modelSelectorBench = { start: performance.now(), durations, observer }
  })
  // Kobalte's DropdownMenu opens on pointerdown for a mouse (not on click).
  // Dispatch that exact production opening event so the measurement ends at
  // first paint instead of letting Playwright's later pointerup/click sequence
  // race newly-portalled content under the synthetic pointer.
  await control.dispatchEvent("pointerdown", { pointerType: "mouse", button: 0, isPrimary: true })
  const input = page.locator("input[data-model-selector-search]")
  await expect(input).toBeVisible()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  return page.evaluate(() => {
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
}

benchmark.describe("performance: model selector", () => {
  for (const count of modelCounts()) benchmark(`bounds open/search work and quota request fanout (${count} models)`, async ({ page, report }) => {
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
    const cold = await openSelector(page)
    const search = page.locator("input[data-model-selector-search]")
    await expect(search).toBeVisible()
    const mountedOptions = await page.locator("[data-option-key]").count()
    await page.waitForTimeout(200)
    const quotaAfterColdOpen = quotaPaths.length

    const searchPerf = await search.evaluate(async (input: HTMLInputElement, target: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      const start = performance.now()
      setter.call(input, target)
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: target.at(-1) }))
      const inputDispatchMs = performance.now() - start
      // Search intentionally debounces 100 ms. Measure application work after
      // the debounce boundary, not the product decision to debounce typing.
      await new Promise<void>((resolve) => setTimeout(resolve, 105))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return { inputDispatchMs, postDebounceMs: performance.now() - start - 105 }
    }, `Model ${(count - 1).toString().padStart(4, "0")}`)

    await page.keyboard.press("Escape")
    await expect(search).not.toBeVisible()
    const warm = await openSelector(page)
    await page.waitForTimeout(200)
    const quotaAfterWarmOpen = quotaPaths.length

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
        searchInputDispatchMs: searchPerf.inputDispatchMs,
        searchPostDebounceMs: searchPerf.postDebounceMs,
        mountedOptions,
        quotaBeforeOpen,
        quotaColdOpenDelta: quotaAfterColdOpen - quotaBeforeOpen,
        quotaWarmOpenDelta: quotaAfterWarmOpen - quotaAfterColdOpen,
        quotaTotal: quotaAfterWarmOpen,
      },
      { models: count },
    )
  })
})
