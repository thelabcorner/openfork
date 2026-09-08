import { expect, test, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/GoalAuditorSettings"
const sessionID = "ses_goal_auditor_settings"
const projectID = "proj_goal_auditor_settings"

const session = {
  id: sessionID,
  slug: sessionID,
  projectID,
  directory,
  title: "Goal auditor settings",
  version: "dev",
  time: { created: 1, updated: 1 },
}

const provider = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: {
        test: { id: "test", name: "Test Model", limit: { context: 200_000 } },
      },
    },
  ],
  connected: ["opencode"],
  default: { providerID: "opencode", modelID: "test" },
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

test("persists the global Goal auditor prompt without defining a global auditor model", async ({ page }) => {
  let globalConfig: Record<string, unknown> = {}
  const writes: Record<string, unknown>[] = []

  await mockOpenCodeServer(page, {
    protocol: "v2",
    provider,
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "Goal auditor settings" },
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })

  await page.route("**/global/config", async (route) => {
    if (route.request().method() === "GET") return json(route, globalConfig)
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>
      writes.push(body)
      globalConfig = { ...globalConfig, ...body }
      return json(route, globalConfig)
    }
    return route.fallback()
  })

  await page.addInitScript(() => {
    const raw = localStorage.getItem("settings.v3")
    const current = raw ? JSON.parse(raw) : {}
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ ...current, general: { ...(current.general ?? {}), newLayoutDesigns: true } }),
    )
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
  await page.keyboard.press("Control+,")

  const settings = page.locator(".settings-v2-dialog")
  const edit = settings.locator('[data-action="settings-auditor-prompt-edit"]')
  await expect(edit).toBeVisible()
  await edit.click()

  const prompt = page.getByRole("textbox", { name: "Goal auditor prompt" })
  const custom = "Audit independently. Inspect the repository when evidence is ambiguous and require concrete evidence for completion."
  await prompt.fill(custom)
  await page.getByRole("button", { name: "Save", exact: true }).click()

  await expect.poll(() => writes.at(-1)?.auditor_prompt).toBe(custom)
  expect(writes.at(-1)).not.toHaveProperty("auditor_model")
  expect(writes.at(-1)).not.toHaveProperty("auditorModel")

  await page.reload()
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
  await page.keyboard.press("Control+,")
  await page.locator(".settings-v2-dialog").locator('[data-action="settings-auditor-prompt-edit"]').click()
  await expect(page.getByRole("textbox", { name: "Goal auditor prompt" })).toHaveValue(custom)
})
