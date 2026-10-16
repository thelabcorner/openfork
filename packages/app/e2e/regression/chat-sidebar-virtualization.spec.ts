import { expect, test, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const worktree = "C:/OpenCode/SidebarVirtualizationProject"
const projectID = "project_sidebar_virtualization"
const startedAt = 1_796_200_000_000
const rootCount = 80
const previewChildCount = 80

const rootSessions = Array.from({ length: rootCount }, (_, index) => ({
  id: `ses_virtual_${String(index).padStart(3, "0")}`,
  slug: `virtual-${index}`,
  projectID,
  directory: worktree,
  title: `Virtual session ${String(index).padStart(3, "0")}`,
  version: "dev",
  time: { created: startedAt - index * 1_000, updated: startedAt - index * 1_000 },
}))

const previewAnchor = rootSessions[0]!
const group = {
  id: "grp_sidebar_virtualization",
  name: "Inspector stress group",
  position: 0,
  kind: "subagent",
  anchorSessionID: previewAnchor.id,
  time: { created: startedAt, updated: startedAt },
}

const previewMembers = [
  {
    ...previewAnchor,
    locked: false,
    origin: "user",
    position: 0,
    timeAdded: startedAt,
  },
  ...Array.from({ length: previewChildCount }, (_, index) => ({
    id: `ses_virtual_child_${String(index).padStart(3, "0")}`,
    title: `Inspector child ${String(index).padStart(3, "0")}`,
    slug: `virtual-child-${index}`,
    projectID,
    directory: worktree,
    parentID: previewAnchor.id,
    version: "dev",
    time: { created: startedAt + index + 1, updated: startedAt + index + 1 },
    locked: false,
    origin: "auto_subagent",
    position: index + 1,
    timeAdded: startedAt + index + 1,
  })),
]

test("chat sidebar and rich hover inspector keep DOM work viewport-bounded", async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 600 })

  const project = {
    id: projectID,
    worktree,
    vcs: "git",
    name: "sidebar-virtualization-project",
    time: { created: startedAt - 100_000, updated: startedAt },
    sandboxes: [],
  }

  await mockOpenCodeServer(page, {
    directory: worktree,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: rootSessions,
    pageMessages: () => ({ items: [] }),
    strictBackendPort: true,
  })

  await page.route("**/global/session/roots**", async (route) => {
    const url = new URL(route.request().url())
    const scopedProject = url.searchParams.get("projectID")
    const scopedDirectory = url.searchParams.get("directory")
    const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 50))
    const rows = rootSessions
      .filter((session) => (scopedProject ? session.projectID === scopedProject : session.directory === scopedDirectory))
      .slice(0, limit)
    await json(route, rows)
  })

  let groupListRequests = 0
  let groupDetailRequests = 0
  await page.route("**/session-group**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback()
      return
    }
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/session-group/details")) {
      groupDetailRequests++
      await json(route, [{ group, sessions: previewMembers }])
      return
    }
    if (path.endsWith("/session-group")) {
      groupListRequests++
      await json(route, [group])
      return
    }
    await route.fallback()
  })

  await page.addInitScript(
    ({ directory, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", server)
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { [server]: [{ worktree: directory, expanded: true }] },
          lastProject: { [server]: directory },
          list: [server],
        }),
      )
      localStorage.setItem("opencode-theme-id", "oc-2")
      localStorage.setItem("opencode-color-scheme", "dark")
    },
    {
      directory: worktree,
      server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    },
  )

  await page.goto("/")
  const toggle = page.locator('button[aria-controls="chat-sidebar-pane"]')
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()

  const sidebar = page.locator("#chat-sidebar-pane")
  await expect(sidebar).toBeVisible()
  const projectsView = sidebar.getByRole("button", { name: "Projects" })
  await projectsView.click()
  await expect(projectsView).toHaveAttribute("aria-pressed", "true")

  const tree = sidebar.getByRole("tree", { name: "Chats" })
  await expect(tree).toBeVisible()
  await expect
    .poll(async () => {
      const total = Number((await tree.getAttribute("data-virtual-total")) ?? 0)
      const mounted = Number((await tree.getAttribute("data-virtual-mounted")) ?? 0)
      return total >= 40 && mounted > 0 && mounted < total
    })
    .toBe(true)

  const firstRoot = sidebar.locator(`[data-chat-tooltip-session="${previewAnchor.id}"]`)
  await expect(firstRoot).toHaveCount(1)

  await expect.poll(() => groupListRequests).toBeGreaterThan(0)
  await expect.poll(() => groupDetailRequests).toBeGreaterThan(0)

  const historyRequests: string[] = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (/\/session\/[^/]+\/message(?:\/|$)/.test(path)) historyRequests.push(path)
  })

  await firstRoot.hover()
  const tooltip = page.locator("[data-chat-sidebar-shared-tooltip]")
  await expect(tooltip).toHaveCount(1)
  await expect(tooltip).toHaveAttribute("data-session-id", previewAnchor.id)
  const preview = tooltip.locator('[data-component="session-preview-card"]')
  await expect(preview).toHaveCount(1)
  await expect(preview).toHaveAttribute("data-preview-total", "80")
  await expect.poll(async () => Number((await preview.getAttribute("data-preview-mounted")) ?? 0)).toBeGreaterThan(0)
  await expect.poll(async () => Number((await preview.getAttribute("data-preview-mounted")) ?? 80)).toBeLessThan(80)
  expect(historyRequests).toEqual([])

  const secondRoot = sidebar.locator('[data-chat-tooltip-session="ses_virtual_001"]')
  await secondRoot.hover()
  await expect(tooltip).toHaveCount(1)
  await expect(tooltip).toHaveAttribute("data-session-id", "ses_virtual_001")
  expect(historyRequests).toEqual([])

  await page.mouse.move(0, 0)
  await expect(tooltip).toHaveCount(0)

  const farRoot = sidebar.locator('[data-chat-tooltip-session="ses_virtual_040"]')
  await expect(farRoot).toHaveCount(0)
  const viewport = sidebar.locator('[data-slot="tree-scroll"] .scroll-view__viewport')
  await expect(viewport).toBeVisible()
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  await expect(farRoot).toHaveCount(1)
  await expect(firstRoot).toHaveCount(0)

  await expect
    .poll(async () => {
      const total = Number((await tree.getAttribute("data-virtual-total")) ?? 0)
      const mounted = Number((await tree.getAttribute("data-virtual-mounted")) ?? 0)
      return total > mounted && mounted < 45
    })
    .toBe(true)

  await farRoot.locator("[data-tree-item]").focus()
  await page.keyboard.press("Home")
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.activeElement
          ?.closest<HTMLElement>("[data-chat-sidebar-virtual-block]")
          ?.getAttribute("data-index"),
      ),
    )
    // Block 0 is the OXP activity region and may have no focusable row in this
    // fixture; Home correctly advances to the first actual treeitem.
    .toBe("1")
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(30)
})

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers: { "access-control-allow-origin": "*" },
  })
}
