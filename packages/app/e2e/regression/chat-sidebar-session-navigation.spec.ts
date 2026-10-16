import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/SidebarNavigationProject"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const sessions = ["ses_sidebar_a", "ses_sidebar_b"].map((id, index) => ({
  id,
  slug: id,
  projectID: "project_sidebar_navigation",
  directory,
  title: `Sidebar navigation ${index + 1}`,
  version: "dev",
  time: { created: 1796200000000 - index * 1000, updated: 1796200000000 - index * 1000 },
}))

test("sidebar opens sessions through the canonical tab route on consecutive SPA navigations", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "project_sidebar_navigation",
      worktree: directory,
      vcs: "git",
      name: "sidebar-navigation-project",
      time: { created: 1796190000000, updated: 1796200000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions,
    pageMessages: () => ({ items: [] }),
    strictBackendPort: true,
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
    },
    { directory, server },
  )
  await page.goto("/")
  const toggle = page.locator('button[aria-controls="chat-sidebar-pane"]')
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()

  const sidebar = page.locator("#chat-sidebar-pane")
  await sidebar.getByRole("button", { name: "Projects" }).click()
  for (const session of sessions) {
    const href = `/server/${base64Encode(server)}/session/${session.id}`
    const link = sidebar.locator(`[data-chat-tooltip-session="${session.id}"] [data-slot="row-link"]`)
    await expect(link).toHaveAttribute("href", href)
    await link.click()
    await expect(page).toHaveURL(new RegExp(`${href}$`))
    await expect(page.locator(`[data-titlebar-tab-slot] a[href="${href}"]`)).toBeVisible()
    // A correct URL and tab alone are insufficient: the session composer must mount.
    await expect(page.locator('[data-slot="prompt-send-primary"]')).toBeVisible()
  }
})
