import type { Page } from "@playwright/test"
import { benchmark, expect } from "../benchmark"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { expectAppVisible } from "../../utils/waits"

const directory = "C:/OpenCode/ModelSelectorPerformance"

const modelCount = () => Number(process.env.MODEL_SELECTOR_BENCH_MODELS ?? 644)

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
              cache_read: 0.02 + (index % 11) / 100,
            },
            limit: { context: 32_000 + (index % 8) * 32_000 },
          },
        ]
      }),
    ),
  }
}

async function openSelectorMs(page: Page) {
  // The composer briefly renders a Suspense fallback with the same visual
  // control before the actual MenuV2 trigger owns it. Wait for the interactive
  // popover trigger so the benchmark measures selector work, not catalog boot.
  const control = page.locator('[data-action="prompt-model"][data-control-type="popover"][aria-haspopup]').last()
  await expect(control).toBeVisible()
  await page.evaluate(() => ((window as any).__modelSelectorBenchStart = performance.now()))
  await control.click()
  const input = page.locator("input[data-model-selector-search]")
  await expect(input).toBeVisible()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  return page.evaluate(() => performance.now() - (window as any).__modelSelectorBenchStart)
}

benchmark.describe("performance: model selector", () => {
  benchmark("bounds open/search work and quota request fanout", async ({ page, report }) => {
    const count = modelCount()
    const quotaPaths: string[] = []
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith("/quota/")) quotaPaths.push(path)
    })

    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: "proj_model_selector_perf",
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
      sessions: [],
      pageMessages: () => ({ items: [] }),
      fileList: (path) =>
        path ? [] : [{ name: "ModelSelectorPerformance", path: "ModelSelectorPerformance", absolute: directory, type: "directory", ignored: false }],
      findFiles: () => ["ModelSelectorPerformance"],
    })
    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [] } }))
    })

    await page.goto("/")
    const addProject = page.locator('[data-action="home-add-project-row"]')
    await expectAppVisible(addProject)
    await addProject.click()
    await page.locator("[data-directory-path]").click()
    await page.locator('[data-action="home-new-session"]').click()
    await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))

    // Let always-mounted composer resources settle so open-induced traffic is
    // distinguishable from baseline shell/composer traffic.
    await page.waitForTimeout(650)
    const quotaBeforeOpen = quotaPaths.length
    const coldOpenMs = await openSelectorMs(page)
    const search = page.locator("input[data-model-selector-search]")
    await expect(search).toBeVisible()
    const mountedOptions = await page.locator("[data-option-key]").count()
    await page.waitForTimeout(200)
    const quotaAfterColdOpen = quotaPaths.length

    const searchMs = await search.evaluate(async (input: HTMLInputElement, target: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      const start = performance.now()
      setter.call(input, target)
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: target.at(-1) }))
      // Search intentionally debounces 100 ms. Measure application work after
      // the debounce boundary, not the product decision to debounce typing.
      await new Promise<void>((resolve) => setTimeout(resolve, 105))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return performance.now() - start - 105
    }, `Model ${(count - 1).toString().padStart(4, "0")}`)

    await page.keyboard.press("Escape")
    await expect(search).not.toBeVisible()
    const warmOpenMs = await openSelectorMs(page)
    await page.waitForTimeout(200)
    const quotaAfterWarmOpen = quotaPaths.length

    report(
      {
        coldOpenMs,
        warmOpenMs,
        searchPostDebounceMs: searchMs,
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
