/**
 * Explicit, opt-in real-Electron hover inspector acceptance probe.
 *
 * Operates on an ALREADY RUNNING Electron renderer through its existing CDP
 * endpoint. NEVER launches the desktop, Vite or a backend, and NEVER chooses
 * an arbitrary localhost server. This diagnostic moves the real pointer and
 * keyboard in the selected renderer, so never run during a user's live work.
 *
 *   OPENFORK_HOVER_LIVE_OK=1 \
 *   OPENFORK_HOVER_CDP_URL=http://127.0.0.1:9222 \
 *   bun run benchmarks/tab-hover-electron-cdp.ts
 *
 * The reported latency is an upper-bound including Playwright/CDP command
 * overhead, not a pure input-to-paint Chrome trace. No session history or
 * private titles/URLs are emitted.
 */
import { chromium, expect } from "@playwright/test"

const endpoint = process.env.OPENFORK_HOVER_CDP_URL
if (process.env.OPENFORK_HOVER_LIVE_OK !== "1" || !endpoint) {
  console.error("Skipped: explicitly set OPENFORK_HOVER_LIVE_OK=1 and OPENFORK_HOVER_CDP_URL for an existing Electron CDP endpoint.")
  process.exit(2)
}
const url = new URL(endpoint)
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
  throw Error("Only an explicitly selected local CDP endpoint is permitted.")
}
const browser = await chromium.connectOverCDP(endpoint)
try {
  const renderers = browser.contexts().flatMap((context) => context.pages())
    .filter((page) => page.url().includes("5173"))
  if (renderers.length !== 1) throw Error(`Expected exactly one existing Electron :5173 renderer, found ${renderers.length}`)
  const page = renderers[0]!
  const tabs = page.locator("[data-titlebar-tab-slot] [data-titlebar-tab][data-session-state]:visible")
  const count = await tabs.count()
  if (!count) throw Error("No visible session tabs; visit an existing session without starting a new process.")
  const working = await page.locator("[data-titlebar-tab][data-session-state='working']").count()
  const requiredWorking = Number(process.env.OPENFORK_HOVER_MIN_WORKING ?? 0)
  if (working < requiredWorking)
    throw Error(`Concurrent working-session prerequisite failed: ${working} < ${requiredWorking}`)

  const samples: number[] = []
  const popover = page.locator('[data-component="session-tab-popover"]:visible')
  const iterations = Number(process.env.OPENFORK_HOVER_REPEATS ?? 10)
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100)
    throw Error("OPENFORK_HOVER_REPEATS must be an integer from 1 to 100")
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  const metrics = async () => {
    const response = await cdp.send("Performance.getMetrics")
    return Object.fromEntries(response.metrics
      .filter((entry) => ["JSHeapUsedSize", "Nodes", "TaskDuration"].includes(entry.name))
      .map((entry) => [entry.name, entry.value]))
  }
  const before = await metrics()
  let after: Record<string, number> = {}
  try {
    for (let cycle = 0; cycle < iterations; cycle++) {
      // Choose the same user-visible tab by explicit index, not a random
      // server/session. Never click or navigate the user's active workspace.
      const tab = tabs.nth(cycle % count)
      await page.mouse.move(0, 0)
      await expect(popover).toHaveCount(0)
      await page.evaluate(() => performance.mark("openfork-hover-start"))
      await tab.hover()
      await expect(popover).toHaveCount(1)
      await expect(popover.locator('[data-component="session-preview-card"]')).toBeVisible()
      const elapsed = await page.evaluate(() => {
        const marker = performance.getEntriesByName("openfork-hover-start").at(-1)
        if (!marker) throw Error("Missing hover mark")
        return performance.now() - marker.startTime
      })
      samples.push(elapsed)
      // A portalled interactive inspector must survive crossing the gutter.
      const interactive = popover.locator('[data-component="session-preview-card"][data-interactive]')
      if (await interactive.count()) {
        const bounds = await interactive.boundingBox()
        if (!bounds) throw Error("Visible interactive inspector lacks layout bounds")
        await page.mouse.move(bounds.x + Math.min(20, bounds.width / 2), bounds.y + 10)
        await expect(popover).toHaveCount(1)
        const members = interactive.locator('button[data-slot="member"]')
        if (await members.count() > 1) {
          await members.nth(0).focus()
          await members.nth(0).press("ArrowDown")
          await expect(members.nth(1)).toBeFocused()
          await members.nth(1).press("Home")
          await expect(members.nth(0)).toBeFocused()
        }
      }
      await page.mouse.move(0, 0)
      await expect(popover).toHaveCount(0)
    }
    after = await metrics()
  } finally {
    await cdp.detach()
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!
  const report = {
    iterations, visibleSessionTabs: count, workingSessionTabs: working,
    p50HoverToVisibleUpperBoundMs: +percentile(0.5).toFixed(2),
    p95HoverToVisibleUpperBoundMs: +percentile(0.95).toFixed(2),
    before, after,
  }
  console.log(JSON.stringify(report))
  const budget = Number(process.env.OPENFORK_HOVER_P95_BUDGET_MS ?? 0)
  if (budget > 0 && percentile(0.95) > budget)
    throw Error(`Hover p95 upper bound exceeded configured budget ${budget}ms`)
} finally {
  await browser.close()
}