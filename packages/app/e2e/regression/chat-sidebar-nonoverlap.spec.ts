import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/SidebarGeometry"
const projectID = "project_sidebar_geometry"
const now = 1_796_200_000_000
const sessions = Array.from({ length: 30 }, (_, index) => ({
  id: `ses_sidebar_geometry_${String(index).padStart(3, "0")}`,
  slug: `geometry-${index}`,
  projectID,
  directory,
  title: `Geometry session ${String(index).padStart(3, "0")}`,
  version: "dev",
  time: { created: now - index * 1000, updated: now - index * 1000 },
}))

type RowBox = {
  index: number
  type: string
  sticky: boolean
  top: number
  bottom: number
  height: number
  childBottom: number
}

async function assertSidebarGeometry(page: import("@playwright/test").Page) {
  const rows = await page.locator("#chat-sidebar-pane [data-chat-sidebar-virtual-block]").evaluateAll((elements) =>
    elements.map((element) => {
      const block = element as HTMLElement
      const box = block.getBoundingClientRect()
      const content = block.firstElementChild?.getBoundingClientRect()
      return {
        index: Number(block.dataset.index),
        type: block.dataset.kind ?? "",
        sticky: block.hasAttribute("data-sticky"),
        top: box.top,
        bottom: box.bottom,
        height: box.height,
        childBottom: content?.bottom ?? box.bottom,
      }
    }),
  )
  const ordered = rows.filter((row) => !row.sticky).sort((a, b) => a.index - b.index)
  expect(ordered.filter((row) => row.type === "session").length).toBeGreaterThanOrEqual(4)
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!
    const next = ordered[i]!
    expect(next.top, `block ${next.type}#${next.index} overlaps ${prev.type}#${prev.index}`).toBeGreaterThanOrEqual(prev.bottom - 1)
  }
  for (const row of ordered) {
    if (!["session", "cluster-member", "cluster-head", "more", "less"].includes(row.type)) continue
    expect(row.height, `row #${row.index} must reserve its fixed geometry`).toBeGreaterThanOrEqual(22)
    expect(row.childBottom, `row #${row.index} must fit its own slot`).toBeLessThanOrEqual(row.bottom + 1)
  }
  return rows
}

test("chat sidebar rows never overlap during initial hydration, density changes or scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 740 })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID, worktree: directory, vcs: "git",
      name: "sidebar-geometry", time: { created: now - 100_000, updated: now }, sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions,
    pageMessages: () => ({ items: [] }),
    strictBackendPort: true,
  })
  await page.route("**/global/session/roots**", async (route) => {
    const url = new URL(route.request().url())
    const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 50))
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessions.slice(0, limit)),
      headers: { "access-control-allow-origin": "*" },
    })
  })
  await page.addInitScript(({ directory, server }) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("opencode.settings.dat:defaultServerUrl", server)
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({
      projects: { [server]: [{ worktree: directory, expanded: true }] },
      lastProject: { [server]: directory },
      list: [server],
    }))
  }, { directory, server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}` })
  await page.goto("/")
  const toggle = page.locator('button[aria-controls="chat-sidebar-pane"]')
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  const sidebar = page.locator("#chat-sidebar-pane")
  await expect(sidebar).toBeVisible()
  // Never mistake an already-running preview built from older source for
  // verification of the fixed-slot virtual layout.
  await expect(sidebar.locator('[data-slot="tree"]')).toHaveAttribute("data-virtual-layout", "fixed-slots")
  await expect(sidebar.locator('[data-kind="session"]').first()).toBeVisible()
  await assertSidebarGeometry(page)
  // The dense row sizing contract must survive a live density change without
  // retaining stale measurements by session key.
  await sidebar.locator('[data-slot="tool"][aria-label]').last().click()
  const compact = page.getByRole("menuitemradio", { name: /compact/i })
  await expect(compact).toBeVisible()
  await compact.click()
  await expect(sidebar.locator('[data-slot="row"][data-density="compact"]').first()).toBeVisible()
  await assertSidebarGeometry(page)
  // Kobalte's radio selection can leave its modal portal open. Close it
  // explicitly before clicking the same trigger for the next density.
  await page.keyboard.press("Escape")
  await sidebar.locator('[data-slot="tool"][aria-label]').last().click()
  const detailed = page.getByRole("menuitemradio", { name: /detailed/i })
  await expect(detailed).toBeVisible()
  await detailed.click()
  await expect(sidebar.locator('[data-slot="row"][data-density="detailed"]').first()).toBeVisible()
  await assertSidebarGeometry(page)
  await page.keyboard.press("Escape")
  // A larger Recent section previously placed Archived over the last visible
  // session rows. Verify expansion also preserves order and exact geometry.
  const beforeExpansion = await sidebar.locator('[data-kind="session"]').count()
  await sidebar.locator('[data-slot="more"]').first().click()
  await expect.poll(async () => sidebar.locator('[data-kind="session"]').count()).toBeGreaterThan(beforeExpansion)
  await assertSidebarGeometry(page)
  // The normal viewport fits all initially loaded recent rows. Shrink it to
  // exercise actual scroll and sticky-header movement rather than asserting
  // that a non-scrollable viewport should move.
  await page.setViewportSize({ width: 1200, height: 420 })
  const viewport = sidebar.locator('[data-slot="tree-scroll"] .scroll-view__viewport')
  await viewport.evaluate((element) => {
    element.scrollTop = 200
    element.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  await expect.poll(async () => (await viewport.evaluate((element) => element.scrollTop))).toBeGreaterThan(0)
  await assertSidebarGeometry(page)
  const stickyPositions = await sidebar.locator('[data-chat-sidebar-virtual-block][data-sticky]').evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).position),
  )
  expect(stickyPositions.length).toBeGreaterThan(0)
  expect(stickyPositions).toEqual(stickyPositions.map(() => "absolute"))
})
