import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/NewSessionLimitsEntrypoint"

test("opens the shell Limits pane from the new-session usage arc", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_new_session_limits",
      worktree: directory,
      vcs: "git",
      name: "new-session-limits",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "bench",
          name: "Bench",
          models: {
            "model-1": {
              id: "model-1",
              name: "Model 1",
              cost: { input: 1, output: 2, cache: { read: 0.1, write: 0 } },
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["bench"],
      default: { providerID: "bench", modelID: "model-1" },
    },
    sessions: [],
    pageMessages: () => ({ items: [] }),
    fileList: (path) =>
      path ? [] : [{ name: "NewSessionLimitsEntrypoint", path: "NewSessionLimitsEntrypoint", absolute: directory, type: "directory", ignored: false }],
    findFiles: () => ["NewSessionLimitsEntrypoint"],
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
  const usage = page.locator('[data-action="prompt-usage"]')
  await expectAppVisible(usage)

  const panel = page.locator("[data-limits-panel]")
  await expect(panel).not.toBeVisible()
  await usage.click()
  await expect(panel).toBeVisible()
})
