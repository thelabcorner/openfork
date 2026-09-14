import type { Page, Route } from "@playwright/test"
import { benchmark, expect } from "../benchmark"
import { mockOpenCodeServer } from "../../utils/mock-server"

const directory = "C:/OpenCode/UsagePerformance"
const DAY = 24 * 60 * 60 * 1000

type Scale = {
  models: number
  maintenanceModels: number
  periods: number
}

const scaleFromEnv = (): Scale => ({
  models: Number(process.env.USAGE_BENCH_MODELS ?? 1_000),
  maintenanceModels: Number(process.env.USAGE_BENCH_MAINTENANCE_MODELS ?? 1_000),
  periods: Number(process.env.USAGE_BENCH_PERIODS ?? 400),
})

const tokens = (seed: number) => ({
  input: 12_000 + seed,
  cacheRead: 24_000 + seed * 2,
  cacheWrite: 1_000,
  output: 4_000 + seed,
  reasoning: 500,
})

function buildFixture(scale: Scale) {
  const now = 1_789_000_000_000
  const catalogModels = Object.fromEntries(
    Array.from({ length: scale.models }, (_, index) => {
      const id = `model-${index.toString().padStart(4, "0")}`
      return [
        id,
        {
          id,
          name: `Model ${index.toString().padStart(4, "0")}`,
          family: `family-${index % 50}`,
          cost: { input: 0.5 + (index % 20) / 10, output: 1 + (index % 30) / 10 },
          limit: { context: 200_000 },
        },
      ]
    }),
  )
  const models = Array.from({ length: scale.models }, (_, index) => {
    const id = `model-${index.toString().padStart(4, "0")}`
    const t = tokens(index)
    return {
      providerID: "bench",
      modelID: id,
      variant: null,
      messages: 5 + (index % 100),
      cost: index % 5 === 0 ? 0 : 0.05 + index / 10_000,
      estimatedCost: 0,
      unpricedRecords: 0,
      tokens: t,
      share: 1 / Math.max(1, scale.models),
      cacheSavings: t.cacheRead / 1_000_000,
      durationMs: 20_000 + index,
      durationRecords: 5,
    }
  })
  const periods = Array.from({ length: scale.periods }, (_, index) => ({
    start: now - (scale.periods - index) * DAY,
    cost: 1 + (index % 17),
    tokens: 100_000 + index * 100,
    messages: 10 + (index % 40),
  }))
  const days = periods.slice(-120).map((period, index) => ({ ...period, sessions: 1 + (index % 8) }))
  const countBucket = (index: number) => ({ cost: 1 + (index % 5), tokens: 10_000 + index * 10, messages: index % 20 })
  const sessions = Array.from({ length: 50 }, (_, index) => ({
    sessionID: `ses-${index}`,
    title: `Session ${index}`,
    projectID: `project-${index % 20}`,
    projectName: `Project ${index % 20}`,
    messages: 20 + index,
    cost: 1 + index / 10,
    tokens: 100_000 + index * 1_000,
    models: 1 + (index % 10),
    start: now - index * DAY,
    end: now - index * DAY + 60_000,
  }))
  const maintenanceModels = Array.from({ length: scale.maintenanceModels }, (_, index) => ({
    agent: index % 2 === 0 ? "summary" : "compaction",
    providerID: "bench",
    modelID: `model-${(index % Math.max(1, scale.models)).toString().padStart(4, "0")}`,
    variant: null,
    requests: 1 + (index % 10),
    cost: index / 10_000,
    estimatedCost: 0,
    totalTokens: 20_000 + index,
  }))
  const summary = {
    since: now - scale.periods * DAY,
    until: now,
    resolution: "day",
    projectID: null,
    totals: {
      sessions: 50,
      messages: models.reduce((sum, model) => sum + model.messages, 0),
      cost: models.reduce((sum, model) => sum + model.cost, 0),
      estimatedCost: 0,
      pricedRecords: scale.models,
      unpricedRecords: 0,
      tokens: tokens(scale.models),
      durationMs: 4_000_000,
      durationRecords: scale.models,
      ttftMs: 100_000,
      ttftRecords: scale.models,
    },
    rates: {
      tokensPerSecond: 120,
      avgTokensPerTurn: 12_000,
      avgCostPerTurn: 0.02,
      cacheHitRate: 0.66,
      cacheSavings: 12,
      cacheSavingsCoverage: 1,
    },
    mostUsedModel: models[0]
      ? { providerID: "bench", modelID: models[0].modelID, variant: null, messages: models[0].messages, cost: models[0].cost, share: 0.1 }
      : null,
    providers: [
      {
        providerID: "bench",
        messages: 10_000,
        sessions: 50,
        cost: 100,
        estimatedCost: 0,
        unpricedRecords: 0,
        tokens: tokens(1),
        share: 1,
        durationMs: 4_000_000,
        durationRecords: scale.models,
      },
    ],
    models,
    variants: [{ variant: null, messages: 10_000, cost: 100, share: 1 }],
    projects: Array.from({ length: 20 }, (_, index) => ({
      projectID: `project-${index}`,
      name: `Project ${index}`,
      sessions: 3,
      messages: 500,
      cost: 5,
      tokens: 500_000,
    })),
    periods,
    days,
    dow: Array.from({ length: 7 }, (_, index) => countBucket(index)),
    hours: Array.from({ length: 24 }, (_, index) => countBucket(index)),
    punchcard: Array.from({ length: 168 }, (_, index) => countBucket(index)),
    providerSeries: [],
    modelSeries: [],
    sessions,
    pricing: { coverage: 1, mode: "recorded" },
    maintenance: {
      totals: {
        requests: scale.maintenanceModels,
        sessions: 20,
        cost: 25,
        estimatedCost: 0,
        pricedRecords: scale.maintenanceModels,
        estimatedRecords: 0,
        unpricedRecords: 0,
        tokens: tokens(2),
        totalTokens: 2_000_000,
        durationMs: 1_000_000,
        durationRecords: scale.maintenanceModels,
      },
      agents: [
        { agent: "summary", requests: 500, sessions: 20, models: 500, cost: 12, estimatedCost: 0, totalTokens: 1_000_000, tokenShare: 0.5, costShare: 0.5 },
        { agent: "compaction", requests: 500, sessions: 20, models: 500, cost: 13, estimatedCost: 0, totalTokens: 1_000_000, tokenShare: 0.5, costShare: 0.5 },
      ],
      models: maintenanceModels,
      periods,
    },
  }
  return { catalogModels, summary }
}

async function measureTab(page: Page, value: string) {
  return page.locator(`[data-slot="tabs-v2-trigger"][data-value="${value}"]`).evaluate(async (button: HTMLElement) => {
    const start = performance.now()
    button.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    return performance.now() - start
  })
}

benchmark.describe("performance: usage page", () => {
  benchmark("keeps large usage datasets bounded and tab-local", async ({ page, report }) => {
    const scale = scaleFromEnv()
    const fixture = buildFixture(scale)
    let usageRequests = 0

    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: "proj_usage_perf",
        worktree: directory,
        vcs: "git",
        name: "Usage Performance",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        sandboxes: [],
      },
      provider: {
        all: [{ id: "bench", name: "Bench", models: fixture.catalogModels }],
        connected: ["bench"],
        default: { providerID: "bench", modelID: "model-0000" },
      },
      sessions: [],
      pageMessages: () => ({ items: [] }),
      fileList: () => [],
      findFiles: () => [],
    })
    await page.route("**/usage/summary**", async (route: Route) => {
      if (new URL(route.request().url()).pathname !== "/usage/summary") return route.fallback()
      usageRequests += 1
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture.summary) })
    })
    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    })

    const started = performance.now()
    await page.goto("/usage")
    const dashboard = page.locator('[data-component="usage-dashboard"]')
    await expect(dashboard).toBeVisible()
    await expect(page.locator('[data-slot="tabs-v2-trigger"][data-value="overview"]')).toBeVisible()
    const initialVisibleMs = performance.now() - started

    const activeContent = () => page.locator('[data-slot="tabs-v2-content"]')
    const overviewNodes = await activeContent().evaluate((node) => node.querySelectorAll("*").length)
    const modelsSwitchMs = await measureTab(page, "models")
    const modelsContent = activeContent()
    await expect(modelsContent).toBeVisible()
    const modelsNodes = await modelsContent.evaluate((node) => node.querySelectorAll("*").length)

    const searchMs = await modelsContent.locator("input").evaluate(async (input: HTMLInputElement) => {
      const start = performance.now()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(input, "model-0999")
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "9" }))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return performance.now() - start
    })
    const searchNodes = await modelsContent.evaluate((node) => node.querySelectorAll("*").length)

    const activitySwitchMs = await measureTab(page, "activity")
    const maintenanceSwitchMs = await measureTab(page, "maintenance")
    const maintenanceContent = activeContent()
    await expect(maintenanceContent).toBeVisible()
    const maintenanceNodes = await maintenanceContent.evaluate((node) => node.querySelectorAll("*").length)

    // Revisit already-exercised tabs separately from their first mount. This
    // distinguishes cold tab construction from the steady-state navigation
    // budget the user feels after moving around the dashboard.
    const warmModelsSwitchMs = await measureTab(page, "models")
    const warmActivitySwitchMs = await measureTab(page, "activity")
    const warmMaintenanceSwitchMs = await measureTab(page, "maintenance")

    report(
      {
        initialVisibleMs,
        modelsSwitchMs,
        activitySwitchMs,
        maintenanceSwitchMs,
        warmModelsSwitchMs,
        warmActivitySwitchMs,
        warmMaintenanceSwitchMs,
        searchMs,
        overviewNodes,
        modelsNodes,
        searchNodes,
        maintenanceNodes,
        usageRequests,
      },
      scale,
    )

    expect(usageRequests).toBe(1)
  })
})
