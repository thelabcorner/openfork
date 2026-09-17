import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/GoalModeLifecycle"
const projectID = "proj_goal_mode_lifecycle"
const sessionID = "ses_goal_mode_lifecycle"

type Criterion = { id: string; position: number; description: string; status: "pending" | "passed" | "failed" }
type Step = {
  id: string
  position: number
  title: string
  description: string
  status: "pending" | "active" | "blocked" | "completed" | "cancelled"
  attempts: number
  time: { started?: number; completed?: number }
}
type Detail = {
  goal: {
    id: string
    projectID: string
    title: string
    objective: string
    constraints: string[]
    status: "draft" | "active" | "paused" | "blocked" | "verifying" | "completed" | "cancelled" | "failed"
    revision: number
    continuationPolicy: { mode: "manual" | "auto_continue" | "unattended" }
    auditorPolicy: {
      model?: { providerID: string; id: string }
      blockedThreshold?: number
      maxAttempts?: number
    }
    blocker?: string
    time: { created: number; updated: number; completed?: number }
  }
  criteria: Criterion[]
  steps: Step[]
}

type Evidence = {
  id: string
  goalID: string
  criterionID?: string
  stepID?: string
  type: string
  sessionID?: string
  summary: string
  verdict?: string
  createdAt: number
}

class GoalServer {
  detail: Detail | null = null
  focused = false
  evidence: Evidence[] = []
  operations: string[] = []
  audit: Array<{ id: string; goalID: string; seq: number; type: string; actor: string; payload: Record<string, unknown>; createdAt: number }> = []
  private goalSequence = 0
  private criterionSequence = 0
  private stepSequence = 0

  constructor(initial?: Detail) {
    if (initial) {
      this.detail = structuredClone(initial)
      this.focused = true
    }
  }

  async install(page: Page) {
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      const path = url.pathname.replace(/^\/api(?=\/)/, "")
      const method = route.request().method()

      if (path === `/session/${sessionID}/goal`) {
        if (method === "GET") return json(route, this.focused && this.detail ? { focus: this.focus(), detail: this.detail } : null)
        if (method === "PUT") {
          this.operations.push("goal.focus")
          this.focused = true
          return json(route, this.focus())
        }
        if (method === "DELETE") {
          this.focused = false
          return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
        }
      }

      if (path === "/goal") {
        if (method === "GET") return json(route, this.detail && !this.terminal(this.detail.goal.status) ? [this.detail.goal] : [])
        if (method === "POST") return this.create(route)
      }

      const goalID = path.match(/^\/goal\/([^/]+)$/)?.[1]
      if (goalID && this.detail?.goal.id === goalID) {
        if (method === "GET") return json(route, this.detail)
        if (method === "PATCH") return this.update(route)
      }

      const transitionID = path.match(/^\/goal\/([^/]+)\/transition$/)?.[1]
      if (transitionID && this.detail?.goal.id === transitionID && method === "POST") return this.transition(route)

      const criterionMatch = path.match(/^\/goal\/([^/]+)\/criterion\/([^/]+)$/)
      if (criterionMatch && this.detail?.goal.id === criterionMatch[1] && method === "PATCH") {
        const body = route.request().postDataJSON() as { status: Criterion["status"] }
        const criterion = this.detail.criteria.find((item) => item.id === criterionMatch[2])
        if (!criterion) return json(route, { error: "criterion missing" }, 404)
        criterion.status = body.status
        this.bump()
        return json(route, this.detail)
      }

      if (this.detail) {
        const id = this.detail.goal.id
        if (path === `/goal/${id}/evidence` && method === "GET") return json(route, this.evidence)
        if (path === `/goal/${id}/audit` && method === "GET") return json(route, this.audit)
        if (path === `/goal/${id}/focus` && method === "GET") return json(route, this.focused ? [this.focus()] : [])
      }

      return route.fallback()
    })
  }

  private async create(route: Route) {
    this.operations.push("goal.create")
    const body = route.request().postDataJSON() as {
      title: string
      objective: string
      criteria?: string[]
      constraints?: string[]
      steps?: Array<{ title: string; description?: string }>
      continuationPolicy?: { mode: "manual" | "auto_continue" | "unattended" }
      auditorPolicy?: Detail["goal"]["auditorPolicy"]
    }
    const now = Date.now()
    const id = `goal_lifecycle_${++this.goalSequence}`
    this.detail = {
      goal: {
        id,
        projectID,
        title: body.title,
        objective: body.objective,
        constraints: body.constraints ?? [],
        status: "draft",
        revision: 0,
        continuationPolicy: body.continuationPolicy ?? { mode: "manual" },
        auditorPolicy: body.auditorPolicy ?? {},
        time: { created: now, updated: now },
      },
      criteria: (body.criteria ?? []).map((description, position) => ({
        id: `criterion_lifecycle_${++this.criterionSequence}`,
        position,
        description,
        status: "pending",
      })),
      steps: (body.steps ?? []).map((step, position) => ({
        id: `step_lifecycle_${++this.stepSequence}`,
        position,
        title: step.title,
        description: step.description ?? "",
        status: "pending",
        attempts: 0,
        time: {},
      })),
    }
    this.audit = [{ id: "audit_1", goalID: id, seq: 0, type: "created", actor: "user", payload: {}, createdAt: now }]
    return json(route, this.detail)
  }

  private async update(route: Route) {
    if (!this.detail) return json(route, { error: "missing" }, 404)
    const body = route.request().postDataJSON() as {
      title?: string
      objective?: string
      criteria?: string[]
      constraints?: string[]
      steps?: Array<{ title: string; description?: string }>
      continuationPolicy?: { mode: "manual" | "auto_continue" | "unattended" }
      auditorPolicy?: Detail["goal"]["auditorPolicy"]
    }
    if (body.title !== undefined) this.detail.goal.title = body.title
    if (body.objective !== undefined) this.detail.goal.objective = body.objective
    if (body.constraints !== undefined) this.detail.goal.constraints = body.constraints
    if (body.continuationPolicy !== undefined) this.detail.goal.continuationPolicy = body.continuationPolicy
    if (body.auditorPolicy !== undefined) this.detail.goal.auditorPolicy = body.auditorPolicy
    if (body.criteria !== undefined) {
      this.detail.criteria = body.criteria.map((description, position) => ({
        id: `criterion_lifecycle_${++this.criterionSequence}`,
        position,
        description,
        status: "pending",
      }))
    }
    if (body.steps !== undefined) {
      this.detail.steps = body.steps.map((step, position) => ({
        id: `step_lifecycle_${++this.stepSequence}`,
        position,
        title: step.title,
        description: step.description ?? "",
        status: "pending",
        attempts: 0,
        time: {},
      }))
    }
    this.bump()
    return json(route, this.detail)
  }

  private async transition(route: Route) {
    if (!this.detail) return json(route, { error: "missing" }, 404)
    const body = route.request().postDataJSON() as { action: string; blocker?: string }
    const current = this.detail.goal.status
    const next: Record<string, Partial<Record<string, Detail["goal"]["status"]>>> = {
      draft: { start: "active", cancel: "cancelled", fail: "failed" },
      active: { pause: "paused", block: "blocked", request_verification: "verifying", cancel: "cancelled", fail: "failed" },
      paused: { resume: "active", cancel: "cancelled", fail: "failed" },
      blocked: { resume: "active", cancel: "cancelled", fail: "failed" },
      verifying: { verification_pass: "completed", verification_fail: "active", cancel: "cancelled", fail: "failed" },
    }
    const status = next[current]?.[body.action]
    if (!status) return json(route, { error: "invalid transition" }, 409)
    if (body.action === "start" && this.detail.criteria.length === 0) return json(route, { error: "criterion required" }, 400)
    if (body.action === "start") this.operations.push("goal.start")
    this.detail.goal.status = status
    this.detail.goal.blocker = body.action === "block" ? body.blocker : status === "active" ? undefined : this.detail.goal.blocker
    if (status === "completed") this.detail.goal.time.completed = Date.now()
    this.bump()
    this.audit.push({
      id: `audit_${this.audit.length + 1}`,
      goalID: this.detail.goal.id,
      seq: this.audit.length,
      type: "transitioned",
      actor: "user",
      payload: { from: current, to: status, action: body.action },
      createdAt: Date.now(),
    })
    return json(route, this.detail)
  }

  private bump() {
    if (!this.detail) return
    this.detail.goal.revision++
    this.detail.goal.time.updated = Date.now()
  }

  private focus() {
    return { sessionID, goalID: this.detail!.goal.id, role: "owner", focusedAt: Date.now() }
  }

  private terminal(status: Detail["goal"]["status"]) {
    return status === "completed" || status === "cancelled" || status === "failed"
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

async function openSession(
  page: Page,
  server: GoalServer,
  provider: unknown = { all: [], connected: [], default: {} },
) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "goal-mode-lifecycle",
      time: { created: Date.now() - 60_000, updated: Date.now() },
      sandboxes: [],
    },
    provider,
    sessions: [
      {
        id: sessionID,
        slug: "goal-mode-lifecycle",
        projectID,
        directory,
        title: "Goal Mode lifecycle",
        version: "dev",
        time: { created: Date.now() - 60_000, updated: Date.now() },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await server.install(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("opencode-theme-id", "oc-2")
    localStorage.setItem("opencode-color-scheme", "dark")
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
}

async function openGoalLauncher(page: Page) {
  const menu = page.getByRole("button", { name: "Goal setup" })
  await expect(menu).toBeVisible()
  await menu.click()
  const chooser = page.getByText("Goal Mode", { exact: true })
  const setup = page.getByText("New Goal", { exact: true })
  // Both can be on screen at once (header label + "New Goal" action): the
  // helper only needs the launcher to have opened.
  await expect(chooser.or(setup).first()).toBeVisible()
  return { chooser, setup }
}

test("drafts are repairable and can traverse the user-visible lifecycle", async ({ page }) => {
  const server = new GoalServer()
  await openSession(page, server)
  const launcher = await openGoalLauncher(page)
  if (await launcher.chooser.isVisible()) await page.getByRole("button", { name: "New Goal" }).click()

  await page.getByLabel("Objective").fill("Repairable Goal\nProve the Goal lifecycle can be driven from the UI")
  const createAndStart = page.getByRole("button", { name: "Start Goal", exact: true })
  await expect(createAndStart).toBeDisabled()
  await expect(page.getByText("Add at least one acceptance criterion to start.")).toBeVisible()
  await page.getByRole("button", { name: "Save draft" }).click()

  const shelf = page.locator('[data-component="goal-composer-shelf"]')
  await expect(shelf).toContainText("Repairable Goal")
  await expect(shelf).toContainText("draft")
  await shelf.getByRole("button", { name: /Repairable Goal/ }).click()
  const popover = shelf.locator('[data-slot="goal-panel"]')
  await expect(popover.getByText("Goal setup", { exact: true })).toBeVisible()
  await expect(popover.getByRole("button", { name: "Start Goal", exact: true })).toBeDisabled()

  await popover.getByLabel("Done when").fill("The lifecycle completes without UI dead ends\nState survives a reload")
  await popover.getByRole("button", { name: "Save setup" }).click()
  await expect(popover.getByRole("button", { name: "Start Goal", exact: true })).toBeEnabled()
  await popover.getByRole("button", { name: "Start Goal", exact: true }).click()
  await expect(popover.getByText("active", { exact: true })).toBeVisible()

  await popover.getByRole("button", { name: "Pause Goal" }).click()
  await expect(popover.getByText("paused", { exact: true })).toBeVisible()
  await popover.getByRole("button", { name: "Resume Goal" }).click()
  await expect(popover.getByText("active", { exact: true })).toBeVisible()

  await popover.getByRole("button", { name: "Request verification" }).click()
  await expect(popover.getByText("verifying", { exact: true })).toBeVisible()
  await expect(popover.getByRole("button", { name: "Complete Goal" })).toBeDisabled()
  await popover.getByRole("button", { name: "Resume work" }).click()
  await expect(popover.getByText("active", { exact: true })).toBeVisible()

  await page.reload()
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
  await expect(page.locator('[data-component="goal-composer-shelf"]')).toContainText("Repairable Goal")
  await page.locator('[data-component="goal-composer-shelf"]').getByRole("button", { name: /Repairable Goal/ }).click()
  const reloadedPopover = page.locator('[data-component="goal-composer-shelf"] [data-slot="goal-panel"]')
  await expect(reloadedPopover.getByRole("button", { name: "Cancel Goal" })).toBeVisible()

  await reloadedPopover.getByRole("button", { name: "Cancel Goal" }).click()
  await expect(page.getByRole("button", { name: "Goal", exact: true })).toBeVisible()
  expect(server.detail?.goal.status).toBe("cancelled")
  expect(server.focused).toBe(false)
})

test("create and start is one operation when setup is valid", async ({ page }) => {
  const server = new GoalServer()
  await openSession(page, server)
  const launcher = await openGoalLauncher(page)
  if (await launcher.chooser.isVisible()) await page.getByRole("button", { name: "New Goal" }).click()

  await page.getByLabel("Objective").fill("Direct Start\nStart immediately after creation")
  await page.getByLabel(/Done when/).fill("Goal becomes active immediately")
  const start = page.getByRole("button", { name: "Start Goal", exact: true })
  await expect(start).toBeEnabled()
  await start.click()

  const shelf = page.locator('[data-component="goal-composer-shelf"]')
  await expect(shelf).toContainText("Direct Start")
  await shelf.getByRole("button", { name: /Direct Start/ }).click()
  await expect(page.getByText("active", { exact: true })).toBeVisible()
  expect(server.detail?.goal.status).toBe("active")
  expect(server.detail?.criteria).toHaveLength(1)
  expect(server.detail?.steps).toHaveLength(0)
})

test("quick Goal arming prepares durable Goal state before the first worker prompt", async ({ page }) => {
  const server = new GoalServer()
  await openSession(page, server, {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: {
          "goal-test-model": {
            id: "goal-test-model",
            name: "Goal Test Model",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "goal-test-model" },
  })

  await page.route(`**/session/${sessionID}/prompt_async`, async (route) => {
    server.operations.push("worker.prompt")
    await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
  })

  const composer = page.locator('[data-component="prompt-input-v2"]')
  const input = composer.locator('[data-component="prompt-input"]')
  const goal = composer.getByRole("button", { name: "Goal", exact: true })
  await goal.click()
  await expect(goal).toHaveAttribute("data-goal-armed", "true")
  await input.fill("Implement the quick Goal ordering contract")
  await composer.getByRole("button", { name: "Send", exact: true }).click()

  await expect.poll(() => server.operations.includes("worker.prompt")).toBe(true)
  expect(server.operations.slice(0, 4)).toEqual(["goal.create", "goal.focus", "goal.start", "worker.prompt"])
  expect(server.detail?.goal).toMatchObject({
    objective: "Implement the quick Goal ordering contract",
    status: "active",
    continuationPolicy: { mode: "auto_continue" },
  })
  expect(server.detail?.criteria).toHaveLength(1)
  await expect(page.locator('[data-component="goal-composer-shelf"]')).toContainText("Implement the quick Goal ordering contract")
})

test("persists the auditor model per Goal through the real model picker", async ({ page }) => {
  const now = Date.now()
  const initial: Detail = {
    goal: {
      id: "goal_auditor_model",
      projectID,
      title: "Audited Goal",
      objective: "Persist an independent auditor model on the Goal",
      constraints: [],
      status: "active",
      revision: 3,
      continuationPolicy: { mode: "auto_continue" },
      auditorPolicy: {},
      time: { created: now - 60_000, updated: now },
    },
    criteria: [{ id: "criterion_auditor_model", position: 0, description: "Auditor model persists", status: "pending" }],
    steps: [],
  }
  const server = new GoalServer(initial)
  await openSession(page, server, {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: {
          "worker-model": { id: "worker-model", name: "Worker Model", limit: { context: 200_000 } },
          "auditor-two": { id: "auditor-two", name: "Auditor Two", limit: { context: 200_000 } },
        },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "worker-model" },
  })

  const shelf = page.locator('[data-component="goal-composer-shelf"]')
  await shelf.getByRole("button", { name: /Audited Goal/ }).click()
  const goalPopover = shelf.locator('[data-slot="goal-panel"]')
  const picker = goalPopover.locator('[data-action="goal-auditor-model"]')
  await expect(picker).toContainText("Inherit worker model")
  await picker.click()
  await page.getByText("Auditor Two", { exact: true }).last().click()

  await expect.poll(() => server.detail?.goal.auditorPolicy.model?.id).toBe("auditor-two")
  expect(server.detail?.goal.auditorPolicy.model).toEqual({ providerID: "opencode", id: "auditor-two" })
  await expect(picker).toContainText("Auditor Two")

  await page.reload()
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
  await page.locator('[data-component="goal-composer-shelf"]').getByRole("button", { name: /Audited Goal/ }).click()
  await expect(page.locator('[data-action="goal-auditor-model"]')).toContainText("Auditor Two")
})

test("a verified Goal can complete only when every criterion has evidence", async ({ page }) => {
  const now = Date.now()
  const initial: Detail = {
    goal: {
      id: "goal_verified",
      projectID,
      title: "Verified Goal",
      objective: "Exercise completion gating",
      constraints: [],
      status: "verifying",
      revision: 8,
      continuationPolicy: { mode: "manual" },
      auditorPolicy: {},
      time: { created: now - 60_000, updated: now },
    },
    criteria: [
      { id: "criterion_verified_1", position: 0, description: "Tests pass", status: "passed" },
      { id: "criterion_verified_2", position: 1, description: "UX verified", status: "passed" },
    ],
    steps: [],
  }
  const server = new GoalServer(initial)
  server.evidence = [
    { id: "evidence_1", goalID: initial.goal.id, criterionID: "criterion_verified_1", type: "test", summary: "Tests passed", verdict: "pass", createdAt: now },
  ]
  await openSession(page, server)
  const shelf = page.locator('[data-component="goal-composer-shelf"]')
  await shelf.getByRole("button", { name: /Verified Goal/ }).click()
  await expect(page.getByRole("button", { name: "Complete Goal" })).toBeDisabled()

  server.evidence.push({
    id: "evidence_2",
    goalID: initial.goal.id,
    criterionID: "criterion_verified_2",
    type: "review",
    summary: "UX verified",
    verdict: "pass",
    createdAt: now,
  })
  // Collapsing and reopening is the refresh boundary that reloads evidence.
  await shelf.getByRole("button", { name: "Collapse Goal" }).click()
  await shelf.getByRole("button", { name: /Verified Goal/ }).click()
  await expect(page.getByRole("button", { name: "Complete Goal" })).toBeEnabled()
  await page.getByRole("button", { name: "Complete Goal" }).click()
  await expect(page.getByRole("button", { name: "Goal", exact: true })).toBeVisible()
  expect(server.detail?.goal.status).toBe("completed")
})
