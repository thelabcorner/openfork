import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/GoalComposerShelf"
const projectID = "proj_goal_composer_shelf"
const sessionID = "ses_goal_composer_shelf"
const goalID = "goal_goal_composer_shelf"
const now = 1_788_750_000_000

const detail = {
  goal: {
    id: goalID,
    projectID,
    title: "Ship Goal Mode",
    objective: "Finish the Goal orchestration surface with durable autonomous continuation and verification.",
    constraints: ["Preserve upstream composer behavior", "Keep the UI dense"],
    status: "active",
    revision: 7,
    continuationPolicy: { mode: "auto_continue", maxConsecutiveTurns: 8, maxNoProgressTurns: 2 },
    time: { created: now - 2_730_000, updated: now - 14_000 },
  },
  criteria: [
    { id: "criterion_1", position: 0, description: "Autonomous turns survive process recovery", status: "passed" },
    { id: "criterion_2", position: 1, description: "The composer remains stable while Goal Mode is active", status: "pending" },
    { id: "criterion_3", position: 2, description: "Delegated workers inherit Goal context", status: "passed" },
  ],
  steps: [
    {
      id: "step_1",
      position: 0,
      title: "Harden continuation runner",
      description: "Exercise durable reservations end-to-end",
      status: "completed",
      attempts: 1,
      time: { started: now - 1_800_000, completed: now - 1_200_000 },
    },
    {
      id: "step_2",
      position: 1,
      title: "Verify premium shelf UX",
      description: "Inspect the live browser composition",
      status: "active",
      assignedSessionID: sessionID,
      attempts: 1,
      time: { started: now - 300_000 },
    },
  ],
}

const focus = { sessionID, goalID, role: "owner", focusedAt: now - 2_700_000 }

test.use({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
})

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

async function mockGoals(page: Page) {
  await page.route(`**/session/${sessionID}/goal`, async (route) => {
    if (route.request().method() === "GET") return json(route, { focus, detail })
    return json(route, focus)
  })
  await page.route(`**/goal/${goalID}/evidence`, (route) =>
    json(route, [
      {
        id: "evidence_1",
        goalID,
        criterionID: "criterion_1",
        type: "test",
        sessionID,
        summary: "Provider-backed continuation integration test passed.",
        verdict: "pass",
        createdAt: now - 90_000,
      },
    ]),
  )
  await page.route(`**/goal/${goalID}/audit`, (route) =>
    json(route, [
      { id: "audit_1", goalID, seq: 1, type: "created", actor: "user", payload: {}, createdAt: now - 2_730_000 },
      { id: "audit_2", goalID, seq: 2, type: "transitioned", actor: "user", payload: { to: "active" }, createdAt: now - 2_700_000 },
    ]),
  )
  await page.route(`**/goal/${goalID}/focus`, (route) =>
    json(route, [focus, { sessionID: "ses_goal_worker", goalID, role: "worker", focusedAt: now - 900_000 }]),
  )
  await page.route(`**/goal/${goalID}`, (route) => json(route, detail))
}

test("renders Goal Mode as a stable premium shelf above PromptInputV2", async ({ page }, testInfo: TestInfo) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "goal-composer-shelf",
      time: { created: now - 3_000_000, updated: now },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: "goal-composer-shelf",
        projectID,
        directory,
        title: "Goal composer shelf visual verification",
        version: "dev",
        time: { created: now - 3_000_000, updated: now },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockGoals(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("opencode-theme-id", "oc-2")
    localStorage.setItem("opencode-color-scheme", "dark")
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  const shelf = page.locator('[data-component="goal-composer-shelf"]')
  await expectAppVisible(composer)
  await expect(shelf).toBeVisible()
  await expect(shelf).toContainText("Ship Goal Mode")
  await expect(shelf).toContainText("3/5")

  const [composerBox, shelfBox] = await Promise.all([composer.boundingBox(), shelf.boundingBox()])
  if (!composerBox || !shelfBox) throw new Error("Goal shelf/composer bounds unavailable")
  expect(shelfBox.height).toBe(36)
  expect(shelfBox.width).toBeLessThanOrEqual(680)
  expect(shelfBox.x).toBeGreaterThanOrEqual(composerBox.x)
  expect(shelfBox.x + shelfBox.width).toBeLessThanOrEqual(composerBox.x + composerBox.width)
  expect(shelfBox.y + shelfBox.height).toBeLessThanOrEqual(composerBox.y - 8)

  const shelfStyle = await shelf.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      borderRadius: style.borderRadius,
      background: style.backgroundColor,
      display: style.display,
    }
  })
  expect(shelfStyle.borderRadius).toBe("10px")
  expect(shelfStyle.display).toBe("flex")
  expect(shelfStyle.background).not.toBe("rgba(0, 0, 0, 0)")

  await page.screenshot({ path: testInfo.outputPath("goal-shelf-dark.png") })

  await shelf.getByRole("button", { name: /Ship Goal Mode/ }).click()
  const popover = page.locator('[data-component="popover-content"]').filter({ hasText: "Acceptance criteria" })
  await expect(popover).toBeVisible()
  await expect(popover).toContainText("Autonomous turns survive process recovery")
  await expect(popover).toContainText("Verify premium shelf UX")
  await expect(popover).toContainText("Auto")
  await expect(popover).toContainText("ses_goal_worker")
  await expect(popover.getByRole("button", { name: "Manual" })).not.toBeFocused()

  const popoverBox = await popover.boundingBox()
  if (!popoverBox) throw new Error("Goal popover bounds unavailable")
  const popoverStyle = await popover.evaluate((element) => {
    const style = getComputedStyle(element)
    return { width: style.width, borderRadius: style.borderRadius }
  })
  expect(popoverStyle.width).toBe("420px")
  expect(popoverStyle.borderRadius).toBe("10px")
  expect(popoverBox.width).toBeGreaterThan(400)
  expect(popoverBox.width).toBeLessThanOrEqual(420)
  expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(shelfBox.y)
  await page.screenshot({ path: testInfo.outputPath("goal-popover-dark.png") })
})
