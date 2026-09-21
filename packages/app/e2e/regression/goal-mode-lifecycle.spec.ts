import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer, type MockServerConfig } from "../utils/mock-server"
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
    auditorRuns: number
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

type AutomationRuntime = {
  phase: "working" | "audit_requested" | "auditing" | "continuation_pending" | "audit_error"
  since: number
  auditorSessionID?: string
  error?: string
}

type EventPayload = {
  directory: string
  payload: {
    type: string
    properties: Record<string, unknown>
  }
}

class GoalServer {
  detail: Detail | null = null
  automation: AutomationRuntime | undefined
  auditorSessionID: string | undefined
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

      if (path === `/session/${sessionID}/goal/prepare` && method === "POST") return this.prepare(route)

      if (path === `/session/${sessionID}/goal`) {
        if (method === "GET")
          return json(
            route,
            this.focused && this.detail
              ? {
                  focus: this.focus(),
                  detail: this.detail,
                  ...(this.auditorSessionID ? { auditorSessionID: this.auditorSessionID } : {}),
                  ...(this.automation ? { automation: this.automation } : {}),
                }
              : null,
          )
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
        auditorRuns: 0,
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

  private async prepare(route: Route) {
    this.operations.push("goal.prepare")
    const body = route.request().postDataJSON() as {
      title: string
      objective: string
      criteria?: string[]
      constraints?: string[]
      steps?: Array<{ title: string; description?: string }>
      continuationPolicy?: { mode: "manual" | "auto_continue" | "unattended" }
      auditorPolicy?: Detail["goal"]["auditorPolicy"]
      start?: boolean
    }
    const now = Date.now()
    const id = `goal_lifecycle_${++this.goalSequence}`
    const started = body.start ?? true
    this.detail = {
      goal: {
        id,
        projectID,
        title: body.title,
        objective: body.objective,
        constraints: body.constraints ?? [],
        status: started ? "active" : "draft",
        revision: started ? 1 : 0,
        auditorRuns: 0,
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
    this.focused = true
    this.audit = [
      { id: "audit_1", goalID: id, seq: 0, type: "created", actor: "user", payload: {}, createdAt: now },
      ...(started
        ? [
            {
              id: "audit_2",
              goalID: id,
              seq: 1,
              type: "transitioned",
              actor: "user",
              payload: { from: "draft", to: "active", action: "start" },
              createdAt: now,
            },
          ]
        : []),
    ]
    return json(route, { focus: this.focus(), detail: this.detail })
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
    const body = route.request().postDataJSON() as { action: string; blocker?: string; sessionID?: string }
    const current = this.detail.goal.status
    if (
      body.action === "request_verification" &&
      body.sessionID === sessionID &&
      (current === "active" || current === "verifying")
    ) {
      // Production treats this as an immediate audit request, not as a durable
      // transition into a passive `verifying` holding state. Manual mode still
      // permits an explicit audit; it only suppresses automatic worker
      // continuation after the verdict.
      this.operations.push("goal.audit.request")
      this.automation = { phase: "audit_requested", since: Date.now() }
      return json(route, this.detail)
    }
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
  options?: {
    protocol?: "v1" | "v2"
    auditorChildSessionID?: string
    events?: EventPayload[]
    pageMessages?: MockServerConfig["pageMessages"]
  },
) {
  const auditorChildSessionID = options?.auditorChildSessionID
  await mockOpenCodeServer(page, {
    protocol: options?.protocol,
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
      ...(auditorChildSessionID
        ? [
            {
              id: auditorChildSessionID,
              slug: "goal-auditor-live",
              projectID,
              directory,
              parentID: sessionID,
              title: "Goal Auditor · Live inspection",
              version: "dev",
              time: { created: Date.now() - 5_000, updated: Date.now() },
            },
          ]
        : []),
    ],
    pageMessages: options?.pageMessages ?? (() => ({ items: [] })),
    ...(options?.events
      ? {
          events: () => options.events!.splice(0, 1),
          eventRetry: 16,
          persistentEvents: true,
        }
      : {}),
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
  await expect(shelf).toHaveAttribute("data-goal-status", "active")

  const summary = shelf.locator('[data-slot="goal-summary"]')
  await summary.getByRole("button", { name: "Pause Goal", exact: true }).click()
  await expect(shelf).toHaveAttribute("data-goal-status", "paused")
  await summary.getByRole("button", { name: "Resume Goal", exact: true }).click()
  await expect(shelf).toHaveAttribute("data-goal-status", "active")

  await popover.getByRole("button", { name: "Request verification" }).click()
  await expect(shelf).toHaveAttribute("data-goal-status", "active")
  await expect(shelf).toHaveAttribute("data-goal-runtime-phase", "audit_requested")
  await expect(shelf.locator('[data-slot="goal-status-chip"]')).toHaveText("audit requested", { ignoreCase: true })
  expect(server.operations).toContain("goal.audit.request")

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
  await expect(shelf).toHaveAttribute("data-goal-status", "active")
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
  expect(server.operations.slice(0, 2)).toEqual(["goal.prepare", "worker.prompt"])
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
      auditorRuns: 2,
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
  await expect(goalPopover).toContainText("2 auditor runs")
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

test("shows AUDITING from the session-local runtime projection while the durable Goal stays active", async ({ page }) => {
  const now = Date.now()
  const initial: Detail = {
    goal: {
      id: "goal_auditing_runtime",
      projectID,
      title: "Auditing Goal",
      objective: "Verify the runtime phase projection",
      constraints: [],
      status: "active",
      revision: 2,
      auditorRuns: 0,
      continuationPolicy: { mode: "auto_continue" },
      auditorPolicy: {},
      time: { created: now - 30_000, updated: now },
    },
    criteria: [{ id: "criterion_auditing", position: 0, description: "Auditor verifies the cycle", status: "pending" }],
    steps: [],
  }
  const server = new GoalServer(initial)
  server.automation = { phase: "auditing", since: now, auditorSessionID: "ses_goal_auditor_runtime" }
  await openSession(page, server)

  const shelf = page.locator('[data-component="goal-composer-shelf"]')
  await expect(shelf).toHaveAttribute("data-goal-status", "active")
  await expect(shelf).toHaveAttribute("data-goal-runtime-phase", "auditing")
  await expect(shelf.locator('[data-slot="goal-status-chip"]')).toHaveText("auditing", { ignoreCase: true })
  await shelf.getByRole("button", { name: /Auditing Goal/ }).click()
  await expect(shelf).toContainText("Independent auditor is auditing the latest worker cycle")
})

test("enters the live Goal Auditor Session while it is working and keeps the same durable transcript after completion", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const now = Date.now()
  const auditorSessionID = "ses_goal_auditor_live_inspection"
  const auditorPromptMessageID = "msg_goal_auditor_live_prompt"
  const assistantMessageID = "msg_goal_auditor_live_assistant"
  const textID = "txt_goal_auditor_live"
  const initial: Detail = {
    goal: {
      id: "goal_live_auditor_inspection",
      projectID,
      title: "Inspectable Auditor",
      objective: "Let the user inspect the independent auditor while it is reasoning",
      constraints: [],
      status: "active",
      revision: 2,
      auditorRuns: 0,
      continuationPolicy: { mode: "auto_continue" },
      auditorPolicy: {},
      time: { created: now - 30_000, updated: now },
    },
    criteria: [{ id: "criterion_live_auditor", position: 0, description: "Auditor transcript is live", status: "pending" }],
    steps: [],
  }
  const server = new GoalServer(initial)
  server.automation = { phase: "audit_requested", since: now }
  const events: EventPayload[] = []
  await openSession(page, server, undefined, {
    protocol: "v2",
    auditorChildSessionID: auditorSessionID,
    events,
    pageMessages: (requestedSessionID) => ({
      items:
        requestedSessionID === auditorSessionID
          ? [
              {
                id: auditorPromptMessageID,
                type: "synthetic",
                provenance: { owner: "host", source: "special-agent.goal-auditor" },
                text: "Audit the latest Goal worker cycle and determine whether the acceptance criteria are satisfied.",
                time: { created: now - 1_000 },
              },
            ]
          : [],
    }),
  })

  const shelf = page.locator('[data-component="goal-composer-shelf"]')
  const openAuditor = shelf.locator('[data-action="goal-open-auditor-session"]')
  await expect(openAuditor).toHaveCount(0)

  events.push({
    directory,
    payload: {
      type: "goal.automation.updated",
      properties: {
        goalID: initial.goal.id,
        sessionID,
        automation: { phase: "auditing", since: Date.now(), auditorSessionID },
      },
    },
  })
  await expect(shelf).toHaveAttribute("data-goal-runtime-phase", "auditing")
  await expect(openAuditor).toBeVisible()
  await expect(openAuditor).toHaveAttribute("href", new RegExp(`/session/${auditorSessionID}$`))

  await openAuditor.click()
  await expect(page).toHaveURL(new RegExp(`/session/${auditorSessionID}$`))
  await expect
    .poll(() =>
      page.evaluate(
        (label) => performance.getEntriesByName(label, "measure").length,
        `session.sync:${auditorSessionID}`,
      ),
    )
    .toBeGreaterThan(0)

  // The Goal Auditor publishes through the ordinary SessionEvent stream. Once
  // the child is foregrounded, its in-flight provider output must render through
  // the same Session reducer as a Task subagent rather than waiting for audit
  // completion or polling a Goal-specific transcript endpoint.
  events.push(
    {
      directory,
      payload: {
        type: "session.next.step.started",
        properties: {
          sessionID: auditorSessionID,
          timestamp: Date.now(),
          assistantMessageID,
          agent: "goal_auditor",
          model: { providerID: "opencode", id: "auditor-model" },
        },
      },
    },
    {
      directory,
      payload: {
        type: "session.next.text.started",
        properties: { sessionID: auditorSessionID, timestamp: Date.now(), assistantMessageID, textID },
      },
    },
    {
      directory,
      payload: {
        type: "session.next.text.delta",
        properties: {
          sessionID: auditorSessionID,
          timestamp: Date.now(),
          assistantMessageID,
          textID,
          delta: "Live auditor output is streaming now.",
        },
      },
    },
  )
  await expect(page.getByText("Live auditor output is streaming now.", { exact: true })).toBeVisible()

  // Runtime execution state is ephemeral; the parent+Goal -> auditor child
  // relation is not. A cold/reconnected parent must still expose the same child
  // after the audit has settled.
  server.automation = undefined
  server.auditorSessionID = auditorSessionID
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
  const completedShelf = page.locator('[data-component="goal-composer-shelf"]')
  const completedOpen = completedShelf.locator('[data-action="goal-open-auditor-session"]')
  await expect(completedOpen).toBeVisible()
  await expect(completedOpen).toHaveAttribute("href", new RegExp(`/session/${auditorSessionID}$`))
})

test("shows AUDIT REQUESTED while worker preemption is pending and never claims the auditor is running", async ({ page }) => {
  const now = Date.now()
  const initial: Detail = {
    goal: {
      id: "goal_audit_requested_runtime",
      projectID,
      title: "Preempt for Audit",
      objective: "Expose a truthful pending verification state before the auditor acquires its lease",
      constraints: [],
      status: "active",
      revision: 2,
      auditorRuns: 0,
      continuationPolicy: { mode: "manual" },
      auditorPolicy: {},
      time: { created: now - 30_000, updated: now },
    },
    criteria: [{ id: "criterion_audit_requested", position: 0, description: "Auditor starts only after worker teardown", status: "pending" }],
    steps: [],
  }
  const server = new GoalServer(initial)
  await openSession(page, server)

  const shelf = page.locator('[data-component="goal-composer-shelf"]')
  await shelf.getByRole("button", { name: /Preempt for Audit/ }).click()
  await shelf.getByRole("button", { name: "Request verification", exact: true }).click()

  const chip = shelf.locator('[data-slot="goal-status-chip"]')
  await expect(shelf).toHaveAttribute("data-goal-status", "active")
  await expect(shelf).toHaveAttribute("data-goal-runtime-phase", "audit_requested")
  await expect(chip).toHaveText("audit requested", { ignoreCase: true })
  await expect(chip).not.toContainText("auditing", { ignoreCase: true })
  await expect(shelf).toContainText("Stopping worker execution and starting the independent auditor…")
  expect(server.operations).toContain("goal.audit.request")
})

test("never presents orphaned verifying or auditor failure as a running auditor", async ({ page }) => {
  const now = Date.now()
  const initial: Detail = {
    goal: {
      id: "goal_waiting_for_auditor",
      projectID,
      title: "Waiting Goal",
      objective: "Do not claim the auditor is running before it actually starts",
      constraints: [],
      status: "verifying",
      revision: 4,
      auditorRuns: 0,
      continuationPolicy: { mode: "auto_continue" },
      auditorPolicy: {},
      time: { created: now - 30_000, updated: now },
    },
    criteria: [{ id: "criterion_waiting", position: 0, description: "Runtime state is truthful", status: "pending" }],
    steps: [],
  }
  const server = new GoalServer(initial)
  await openSession(page, server)

  const shelf = page.locator('[data-component="goal-composer-shelf"]')
  const chip = shelf.locator('[data-slot="goal-status-chip"]')
  await expect(shelf).toHaveAttribute("data-goal-status", "verifying")
  await expect(shelf).not.toHaveAttribute("data-goal-runtime-phase", "auditing")
  await expect(chip).toHaveText("audit error", { ignoreCase: true })
  await expect(chip).not.toContainText("verifying", { ignoreCase: true })
  await expect(chip).not.toContainText("auditing", { ignoreCase: true })
  await shelf.getByRole("button", { name: /Waiting Goal/ }).click()
  await expect(shelf).toContainText("Auditor is not running. Retry the audit or resume work.")
  await shelf.getByRole("button", { name: "Retry audit", exact: true }).click()
  expect(server.operations).toContain("goal.audit.request")

  server.automation = { phase: "audit_error", since: Date.now(), error: "Model unavailable" }
  await page.reload()
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))
  const errored = page.locator('[data-component="goal-composer-shelf"]')
  const errorChip = errored.locator('[data-slot="goal-status-chip"]')
  await expect(errored).toHaveAttribute("data-goal-runtime-phase", "audit_error")
  await expect(errorChip).toHaveText("audit error", { ignoreCase: true })
  await expect(errorChip).not.toContainText("verifying", { ignoreCase: true })
  await expect(errorChip).not.toContainText("auditing", { ignoreCase: true })
  await errored.getByRole("button", { name: /Waiting Goal/ }).click()
  await expect(errored).toContainText("Auditor failed: Model unavailable")
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
      auditorRuns: 4,
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
  await expect(shelf.locator('[data-slot="goal-status-chip"]')).toHaveText("ready for review", { ignoreCase: true })
  await shelf.getByRole("button", { name: /Verified Goal/ }).click()
  await expect(shelf.locator('[data-slot="goal-panel"]')).toContainText("4 auditor runs")
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
