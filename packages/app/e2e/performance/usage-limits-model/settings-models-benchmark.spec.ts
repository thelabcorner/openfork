import type { CDPSession, Page, Route } from "@playwright/test"
import { benchmark, expect } from "../benchmark"
import { performanceBackendUrl } from "../performance-ports"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { expectAppVisible } from "../../utils/waits"

const directory = "C:/OpenCode/SettingsModelsPerformance"
const backendURL = performanceBackendUrl()
const modelCount = () => Math.max(1, Number(process.env.SETTINGS_MODELS_BENCH_MODELS ?? 5_000) || 5_000)

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

function settingsModelsFixture(count: number) {
  const providers = 32
  return Array.from({ length: count }, (_, index) => {
    const providerIndex = index % providers
    return {
      providerID: `bench-provider-${providerIndex.toString().padStart(2, "0")}`,
      providerName: `Bench Provider ${providerIndex.toString().padStart(2, "0")}`,
      modelID: `model-${index.toString().padStart(5, "0")}`,
      name: `Model ${index.toString().padStart(5, "0")}`,
      family: `family-${index % 50}`,
      releaseDate: "2026-09-01",
    }
  })
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

benchmark.describe("performance: settings models", () => {
  benchmark("keeps hidden work and mounted model rows bounded", async ({ page, report }) => {
    const count = modelCount()
    const fixture = settingsModelsFixture(count)
    let modelsRequests = 0

    await mockOpenCodeServer(page, {
      strictBackendPort: true,
      directory,
      provider: {
        all: [],
        connected: [],
        default: { providerID: "", modelID: "" },
      },
      sessions: [],
      pageMessages: () => ({ items: [] }),
    })

    await page.route("**/*", async (route) => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname.endsWith("/provider-settings/models")) {
        modelsRequests += 1
        return json(route, { models: fixture })
      }
      if (pathname === "/pty/shells") return json(route, [])
      return route.fallback()
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

    await page.goto("/settings?tab=general")
    const settings = page.locator('[data-testid="settings-screen"]')
    await expectAppVisible(settings)
    await page.waitForTimeout(250)

    // AGENTS.md invariant: hidden settings UI must not own expensive catalog work.
    expect(modelsRequests).toBe(0)

    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Performance.enable")
    const cpuBefore = await cpuMetrics(cdp)
    const started = await page.evaluate(() => performance.now())

    await settings.locator('[data-slot="tabs-v2-trigger"][data-value="models"]').click()
    const body = settings.locator(".settings-v2-models-virtual")
    await expect(body).toBeVisible()
    await expect(body.locator(".settings-v2-models-virtual-spacer")).toHaveAttribute("data-model-count", String(count))
    await settle(page)

    const openMs = await page.evaluate((start) => performance.now() - start, started)
    const openCpu = cpuDelta(await cpuMetrics(cdp), cpuBefore)
    const mountedInitial = await body.locator(".settings-v2-models-model-row").count()

    expect(modelsRequests).toBe(1)
    expect(mountedInitial).toBeGreaterThan(0)
    expect(mountedInitial).toBeLessThan(100)

    await body.evaluate((node) => {
      const scroll = node.parentElement
      if (scroll) scroll.scrollTop = scroll.scrollHeight
    })
    await settle(page)
    const mountedAfterScroll = await body.locator(".settings-v2-models-model-row").count()
    expect(mountedAfterScroll).toBeGreaterThan(0)
    expect(mountedAfterScroll).toBeLessThan(100)

    const search = settings.locator('.settings-v2-tab-search input[type="search"]')
    const searchCpuBefore = await cpuMetrics(cdp)
    const searchStarted = await page.evaluate(() => performance.now())
    await search.fill("model 049")
    await page.waitForTimeout(90)
    await settle(page)
    const searchMs = await page.evaluate((start) => performance.now() - start, searchStarted)
    const searchCpu = cpuDelta(await cpuMetrics(cdp), searchCpuBefore)
    const mountedAfterSearch = await body.locator(".settings-v2-models-model-row").count()

    expect(mountedAfterSearch).toBeLessThan(100)

    report(
      {
        openMs,
        openCpu,
        searchMs,
        searchCpu,
        modelsRequests,
        mountedInitial,
        mountedAfterScroll,
        mountedAfterSearch,
      },
      { models: count, providers: 32 },
    )
  })
})
