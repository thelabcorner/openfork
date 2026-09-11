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
    auditorPolicy: {},
    time: { created: now - 2_730_000, updated: now - 14_000 },
  },
  criteria: [
    { id: "criterion_1", position: 0, description: "Autonomous turns survive process recovery", status: "passed" },
    {
      id: "criterion_2",
      position: 1,
      description: "The composer remains stable while Goal Mode is active",
      status: "pending",
    },
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
      {
        id: "audit_2",
        goalID,
        seq: 2,
        type: "transitioned",
        actor: "user",
        payload: { to: "active" },
        createdAt: now - 2_700_000,
      },
      {
        id: "audit_3",
        goalID,
        seq: 3,
        type: "audited",
        actor: "auditor",
        payload: {
          decision: "continue",
          rationale: "One acceptance criterion remains pending.",
          progressMade: true,
          continuationPrompt: "Finish the remaining shelf stability criterion and capture verification evidence.",
        },
        createdAt: now - 10_000,
      },
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
  await expect(popover).toContainText("Auditor")
  await expect(popover).toContainText("Inherit worker model")
  await expect(popover).toContainText("One acceptance criterion remains pending.")
  await expect(popover).toContainText("Next cycle")
  await expect(popover).toContainText("Finish the remaining shelf stability criterion and capture verification evidence.")
  await expect(popover).toContainText("ses_goal_worker")
  await expect(popover.getByRole("button", { name: "Manual" })).not.toBeFocused()

  const popoverBox = await popover.boundingBox()
  if (!popoverBox) throw new Error("Goal popover bounds unavailable")
  const popoverStyle = await popover.evaluate((element) => {
    const style = getComputedStyle(element)
    return { width: style.width, borderRadius: style.borderRadius }
  })
  expect(popoverStyle.width).toBe("370px")
  expect(popoverStyle.borderRadius).toBe("8px")
  expect(popoverBox.width).toBeGreaterThan(340)
  expect(popoverBox.width).toBeLessThanOrEqual(370)
  expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(shelfBox.y)
  await page.screenshot({ path: testInfo.outputPath("goal-popover-dark.png") })
})

test("places the inactive Goal entrypoint between add and agent as an icon-only control", async ({ page }) => {
  const models = Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => {
      const id = `goal-auditor-${index + 1}`
      return [
        id,
        {
          id,
          name: `Goal Auditor ${index + 1}`,
          cost: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
          limit: { context: 200_000 },
        },
      ]
    }),
  )
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "goal-composer-launcher",
      time: { created: now - 3_000_000, updated: now },
      sandboxes: [],
    },
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models }],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "goal-auditor-1" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "goal-composer-launcher",
        projectID,
        directory,
        title: "Goal launcher placement verification",
        version: "dev",
        time: { created: now - 3_000_000, updated: now },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route(`**/session/${sessionID}/goal`, (route) => json(route, null))
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("opencode-theme-id", "oc-2")
    localStorage.setItem("opencode-color-scheme", "dark")
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)

  const add = composer.getByRole("button", { name: "Add images and files" })
  const launcher = composer.getByRole("button", { name: "Goal", exact: true })
  const menu = composer.getByRole("button", { name: "Goal setup" })
  const agent = composer.getByRole("button", { name: "Choose agent" })
  await expect(launcher).toBeVisible()
  await expect(menu).toBeVisible()
  await expect(launcher).toHaveText("")
  await expect(menu).toHaveText("")
  await expect(page.locator('[data-component="goal-composer-shelf"]')).toHaveCount(0)

  const [addBox, launcherBox, menuBox, agentBox] = await Promise.all([
    add.boundingBox(),
    launcher.boundingBox(),
    menu.boundingBox(),
    agent.boundingBox(),
  ])
  if (!addBox || !launcherBox || !menuBox || !agentBox) throw new Error("Composer control bounds unavailable")
  expect(Math.round(launcherBox.width)).toBe(Math.round(addBox.width))
  expect(Math.round(launcherBox.height)).toBe(Math.round(addBox.height))
  expect(addBox.x + addBox.width).toBeLessThanOrEqual(launcherBox.x)
  expect(launcherBox.x + launcherBox.width).toBeLessThanOrEqual(menuBox.x)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(agentBox.x)

  await launcher.click()
  await expect(launcher).toHaveAttribute("aria-pressed", "true")
  await expect(launcher).toHaveAttribute("data-goal-armed", "true")
  await expect(page.locator('[data-component="popover-content"]').filter({ hasText: "Goal Mode" })).toHaveCount(0)

  await launcher.click()
  await expect(launcher).toHaveAttribute("aria-pressed", "false")

  // Reproduce the effective layout width/height seen under high desktop zoom.
  // Goal creation must remain a bounded surface with an internal scroll region,
  // rather than clipping fields/footer or pushing content outside the viewport.
  await page.setViewportSize({ width: 460, height: 440 })
  await menu.click()
  const chooser = page.locator('[data-component="popover-content"]').filter({ hasText: "Goal Mode" })
  await expect(chooser).toBeVisible()

  // Its nested model selector used to be forced downward from a near-bottom
  // trigger, rendering a large catalog below the viewport.
  await chooser.getByRole("button", { name: "New Goal" }).click()
  const creation = page.locator("[data-goal-create-surface]")
  await expect(creation).toBeVisible()
  const creationBox = await creation.boundingBox()
  if (!creationBox) throw new Error("Goal creation popover bounds unavailable")
  const compactViewport = page.viewportSize()
  if (!compactViewport) throw new Error("Compact viewport unavailable")
  expect(creationBox.x).toBeGreaterThanOrEqual(8)
  expect(creationBox.y).toBeGreaterThanOrEqual(8)
  expect(creationBox.x + creationBox.width).toBeLessThanOrEqual(compactViewport.width - 8)
  expect(creationBox.y + creationBox.height).toBeLessThanOrEqual(compactViewport.height - 8)
  expect(await creation.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const createScroll = creation.locator("[data-goal-create-scroll]")
  await expect(createScroll).toBeVisible()
  expect(await createScroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const objectivePlaceholder = creation.getByPlaceholder("What should OpenCode accomplish?")
  await expect(objectivePlaceholder).toBeVisible()
  expect(
    await objectivePlaceholder.evaluate((element) => Number.parseFloat(getComputedStyle(element, "::placeholder").opacity)),
  ).toBeLessThanOrEqual(0.4)

  const auditor = page.locator('[data-action="goal-create-auditor-model"]')
  await expect(auditor).toBeVisible()
  await auditor.click()
  const modelMenu = page.locator('[data-component="menu-v2-content"]').filter({ hasText: "Goal Auditor 1" }).first()
  await expect(modelMenu).toBeVisible()
  const modelMenuBox = await modelMenu.boundingBox()
  if (!modelMenuBox) throw new Error("Goal auditor model menu bounds unavailable")
  expect(modelMenuBox.x).toBeGreaterThanOrEqual(8)
  expect(modelMenuBox.y).toBeGreaterThanOrEqual(8)
  expect(modelMenuBox.x + modelMenuBox.width).toBeLessThanOrEqual(compactViewport.width - 8)
  expect(modelMenuBox.y + modelMenuBox.height).toBeLessThanOrEqual(compactViewport.height - 8)
})
