import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

// Back-stack audit tests (risk R2, docs/pwa-mobile/01 §2.4, 03 §5): every
// redirect-style route must REPLACE its history entry so back-swipe can never
// land on a redirect and loop. @solidjs/router's <Navigate> hardcodes
// replace:true (node_modules/@solidjs/router/dist/index.js:1697); these tests
// pin that behavior against regressions.
//
// History-length assertions are relative to a measured baseline because a
// fresh Playwright page already owns an about:blank entry.

const directory = "C:/OpenCode/PwaBackStack"
const dirBase64 = base64Encode(directory)
const sessionID = "sess_backstack"
const sessionTitle = "Back stack session"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

async function setup(page: import("@playwright/test").Page, tabs: unknown[] = []) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_pwa_back_stack",
      worktree: directory,
      vcs: "git",
      name: "pwa-back-stack",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [{ id: sessionID, title: sessionTitle }],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, server, tabs }) => {
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    {
      directory,
      server,
      tabs,
    },
  )
}

test("draft-route fallback replaces instead of pushing a history entry", async ({ page }) => {
  await setup(page)

  await page.goto("/")
  const baseline = await page.evaluate(() => history.length)

  await page.goto("/new-session")

  await expect(page).toHaveURL("/")
  expect(await page.evaluate(() => history.length)).toBe(baseline + 1)
  await page.goBack()
  await expect(page).not.toHaveURL(/new-session/)
})

test("new-layout legacy session redirect replaces instead of pushing a history entry", async ({ page }) => {
  await setup(page)

  await page.goto("/")
  const baseline = await page.evaluate(() => history.length)

  await page.goto(`/${dirBase64}/session/${sessionID}`)

  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${sessionID}$`))
  expect(await page.evaluate(() => history.length)).toBe(baseline + 1)
  await page.goBack()
  await expect(page).not.toHaveURL(new RegExp(dirBase64))
})

test("mobile arm back-stack: launch replaces, session tap pushes, back lands home", async ({ page }) => {
  await setup(page, [{ type: "session", server, dirBase64, sessionId: sessionID }])

  await page.goto("about:blank")
  const baseline = await page.evaluate(() => history.length)

  await page.goto("/pwa.html")

  // The pwa entry normalizes /pwa.html to "/" via replaceState so the launch
  // URL never becomes a history entry (docs/pwa-mobile/phase2-backstack-audit.md §3.1).
  await expect(page).toHaveURL("/")
  expect(await page.evaluate(() => history.length)).toBe(baseline + 1)

  const tabBar = page.locator(".pwa-tab-bar")
  await expect(tabBar).toBeVisible()

  const row = page.locator('[data-component="home-session-row"]').filter({ hasText: sessionTitle })
  await expect(row).toBeVisible()
  await row.click()

  // Opening a session is a user navigation: exactly one pushed entry.
  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${sessionID}$`))
  expect(await page.evaluate(() => history.length)).toBe(baseline + 2)
  await expect(tabBar).toBeVisible()

  // Back returns home without replaying any redirect; forward restores the session.
  await page.goBack()
  await expect(page).toHaveURL("/")
  await expect(tabBar).toBeVisible()
  await expect(row).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`/server/.+/session/${sessionID}$`))
})
