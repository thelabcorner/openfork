import type { Page, Route } from "@playwright/test"
import { benchmark, expect } from "../benchmark"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { expectAppVisible } from "../../utils/waits"

const directory = "C:/OpenCode/LimitsPerformance"

const providerCount = () => Number(process.env.LIMITS_BENCH_PROVIDERS ?? 50)
const windowsPerProvider = () => Number(process.env.LIMITS_BENCH_WINDOWS ?? 6)

function windowFixture(index: number, cadence: number) {
  const seconds = cadence % 3 === 0 ? 18_000 : cadence % 3 === 1 ? 604_800 : 2_592_000
  const remaining = Math.max(1, 100 - ((index * 7 + cadence * 11) % 95))
  return {
    usedPercent: 100 - remaining,
    remainingPercent: remaining,
    windowSeconds: seconds,
    resetAt: Date.now() + seconds * 1_000,
    resetAfterSeconds: seconds,
    valueLabel: null,
  }
}

function providerDefinitions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    providerId: `bench-${index.toString().padStart(3, "0")}`,
    providerName: `Provider ${index.toString().padStart(3, "0")}`,
    configured: true,
  }))
}

function providerResult(providerId: string, providerName: string, windows: number) {
  return {
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: {
      windows: Object.fromEntries(
        Array.from({ length: windows }, (_, cadence) => [
          cadence === 0 ? "5h" : cadence === 1 ? "weekly" : cadence === 2 ? "monthly" : `window-${cadence}`,
          windowFixture(Number(providerId.match(/\d+$/)?.[0] ?? 0), cadence),
        ]),
      ),
    },
    fetchedAt: Date.now(),
    nextRefreshAt: Date.now() + 60_000,
  }
}

async function createSession(page: Page) {
  await page.goto("/")
  const addProject = page.locator('[data-action="home-add-project-row"]')
  await expectAppVisible(addProject)
  await addProject.click()
  await page.locator("[data-directory-path]").click()
  await page.locator('[data-action="home-new-session"]').click()
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
}

benchmark.describe("performance: limits pane", () => {
  benchmark("bounds provider rendering, countdown work, and quota request fanout", async ({ page, report }) => {
    const providers = providerDefinitions(providerCount())
    const windowCount = windowsPerProvider()
    let providerListRequests = 0
    let quotaRequests = 0

    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: "proj_limits_perf",
        worktree: directory,
        vcs: "git",
        name: "LimitsPerformance",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        sandboxes: [],
      },
      provider: {
        all: [
          {
            id: "bench",
            name: "Bench",
            models: {
              "model-0000": {
                id: "model-0000",
                name: "Model 0000",
                cost: { input: 1, output: 1 },
                limit: { context: 200_000 },
              },
            },
          },
        ],
        connected: ["bench"],
        default: { providerID: "bench", modelID: "model-0000" },
      },
      sessions: [],
      pageMessages: () => ({ items: [] }),
      fileList: (path) =>
        path ? [] : [{ name: "LimitsPerformance", path: "LimitsPerformance", absolute: directory, type: "directory", ignored: false }],
      findFiles: () => ["LimitsPerformance"],
    })

    // Registered after the generic mock route so these quota-specific handlers
    // take precedence. The app also injects Claude + Zen; return the same generic
    // fixture shape for those two so the stress case stays deterministic.
    await page.route("http://127.0.0.1:4096/quota/*", async (route: Route) => {
      const path = new URL(route.request().url()).pathname
      if (path === "/quota/providers") return route.fallback()
      quotaRequests += 1
      const id = decodeURIComponent(path.slice("/quota/".length))
      const match = providers.find((provider) => provider.providerId === id)
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(providerResult(id, match?.providerName ?? id, windowCount)),
      })
    })
    await page.route("http://127.0.0.1:4096/quota/providers", async (route: Route) => {
      providerListRequests += 1
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers }) })
    })

    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [] } }))
      localStorage.removeItem("opencode.limits.cache.v2")
    })

    await createSession(page)

    // Let the always-mounted composer arc establish the shared snapshot first.
    await page.waitForTimeout(300)
    const providerRequestsBeforeOpen = providerListRequests
    const quotaRequestsBeforeOpen = quotaRequests

    // Use the composer usage arc as the canonical production entrypoint. The
    // synthetic new-session fixture intentionally omits some titlebar actions,
    // and command registration is route/chrome dependent; the arc is always
    // mounted with the composer and calls the exact same
    // `sessionContext.selectTab("limits")` state transition as the header.
    const limitsControl = page.locator('[data-action="prompt-usage"]')
    await expect(limitsControl).toBeVisible()
    const openStarted = await page.evaluate(() => performance.now())
    await limitsControl.click()
    const panel = page.locator("[data-context-panel]")
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-limits-provider="bench-000"]')).toBeVisible()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const openMs = (await page.evaluate(() => performance.now())) - openStarted

    const mountedProviders = await panel.locator("[data-limits-provider]").count()
    const panelNodes = await panel.evaluate((node) => node.querySelectorAll("*").length)
    const providerListOpenDelta = providerListRequests - providerRequestsBeforeOpen
    const quotaOpenDelta = quotaRequests - quotaRequestsBeforeOpen

    // Visible tick cost: observe the pane for just over one second and count
    // DOM character-data changes caused by countdown text. Structural children
    // should remain stable; this is deliberately a renderer-level invariant.
    const limitsBody = panel.locator('[data-limits-provider="bench-000"]').locator("xpath=ancestor::*[@aria-hidden][1]")
    const visibleMutations = await limitsBody.evaluate(async (node) => {
      let characterData = 0
      let childList = 0
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "characterData") characterData += 1
          if (record.type === "childList") childList += 1
        }
      })
      observer.observe(node, { subtree: true, characterData: true, childList: true })
      await new Promise((resolve) => setTimeout(resolve, 1_150))
      observer.disconnect()
      return { characterData, childList }
    })

    // Move away from Limits without unmounting it. Its local display clock and
    // transport should go idle while Context is active.
    await panel.getByRole("tab", { name: /context/i }).click()
    await expect(panel.getByRole("tab", { name: /context/i })).toHaveAttribute("aria-selected", "true")
    const requestsBeforeHidden = { providers: providerListRequests, quotas: quotaRequests }
    const hiddenMutations = await limitsBody.evaluate(async (node) => {
      let characterData = 0
      let childList = 0
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "characterData") characterData += 1
          if (record.type === "childList") childList += 1
        }
      })
      observer.observe(node, { subtree: true, characterData: true, childList: true })
      await new Promise((resolve) => setTimeout(resolve, 1_150))
      observer.disconnect()
      return { characterData, childList }
    })

    report(
      {
        openMs,
        mountedProviders,
        panelNodes,
        providerListRequests,
        quotaRequests,
        providerListOpenDelta,
        quotaOpenDelta,
        visibleCharacterMutations: visibleMutations.characterData,
        visibleChildListMutations: visibleMutations.childList,
        hiddenCharacterMutations: hiddenMutations.characterData,
        hiddenChildListMutations: hiddenMutations.childList,
        hiddenProviderRequestDelta: providerListRequests - requestsBeforeHidden.providers,
        hiddenQuotaRequestDelta: quotaRequests - requestsBeforeHidden.quotas,
      },
      { providers: providers.length, windowsPerProvider: windowCount },
    )

    expect(providerListOpenDelta).toBe(0)
    expect(quotaOpenDelta).toBe(0)
    expect(hiddenMutations.characterData).toBe(0)
    expect(hiddenMutations.childList).toBe(0)
    expect(providerListRequests - requestsBeforeHidden.providers).toBe(0)
    expect(quotaRequests - requestsBeforeHidden.quotas).toBe(0)
  })
})
