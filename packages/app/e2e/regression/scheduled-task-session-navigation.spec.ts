import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/ScheduledTaskSessionNavigation"
const projectID = "project_scheduled_task_navigation"
const taskID = "stk_navigation"
const runID = "str_navigation"
const sessionID = "ses_scheduled_task_navigation"
const sessionTitle = "Nightly audit — live run"
const startedAt = 1_796_000_000_000

const task = {
  id: taskID,
  projectID,
  targetDirectory: directory,
  target: { kind: "directory" as const },
  name: "Nightly audit",
  enabled: true,
  revision: 1,
  schedule: { kind: "daily" as const, times: [{ hour: 2, minute: 0 }] },
  timezone: "America/Chicago",
  action: { prompt: "Audit the project" },
  policy: {
    catchUp: "skip" as const,
    catchUpMaxAgeMs: 86_400_000,
    overrun: "skip" as const,
    jitterMs: 0,
    maxAttempts: 1,
    maxDurationMs: 1_800_000,
    retentionRuns: 50,
    permission: "deny" as const,
    notify: "failure" as const,
  },
  nextRunAt: startedAt + 86_400_000,
  lastRunAt: startedAt,
  lastRunStatus: "running" as const,
  lastRunID: runID,
  consecutiveFailures: 0,
  source: "api" as const,
  time: { created: startedAt - 86_400_000, updated: startedAt - 1_000 },
}

const runningRun = {
  id: runID,
  taskID,
  fireFor: startedAt,
  trigger: "schedule" as const,
  status: "running" as const,
  attempt: 1,
  startedAt,
}

type EventPayload = {
  directory: string
  payload: {
    type: string
    properties: Record<string, unknown>
  }
}

test("scheduled run enters its ordinary Session while active and after settlement", async ({ page }) => {
  test.setTimeout(90_000)
  const events: EventPayload[] = []
  const promptRequests: unknown[] = []
  let inboxRun: Record<string, unknown> = { ...runningRun }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "scheduled-task-session-navigation",
      time: { created: startedAt - 100_000, updated: startedAt },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "mock",
          name: "Mock",
          models: {
            "mock-model": {
              id: "mock-model",
              name: "Mock Model",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["mock"],
      default: { providerID: "mock", modelID: "mock-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "scheduled-task-navigation",
        projectID,
        directory,
        title: sessionTitle,
        version: "dev",
        time: { created: startedAt, updated: startedAt },
      },
    ],
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
    persistentEvents: true,
    strictBackendPort: true,
  })

  // Registered after the broad mock route so these production Scheduled Task
  // endpoints win without expanding the shared mock harness for one regression.
  await page.route("**/scheduled-task**", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (method === "GET" && url.pathname === "/scheduled-task") return json(route, [task])
    if (method === "GET" && url.pathname === "/scheduled-task/run") return json(route, [inboxRun])
    if (method === "GET" && url.pathname === "/scheduled-task/inbox/count") return json(route, { unread: 0 })
    if (method === "GET" && url.pathname === "/scheduled-task/control")
      return json(route, { paused: false, timeUpdated: startedAt })
    return route.fallback()
  })
  await page.route("**/session/*/prompt_async**", async (route) => {
    const url = new URL(route.request().url())
    if (
      route.request().method() !== "POST" ||
      url.pathname !== `/session/${sessionID}/prompt_async`
    )
      return route.fallback()
    promptRequests.push(route.request().postDataJSON())
    return route.fulfill({
      status: 204,
      headers: { "access-control-allow-origin": "*" },
    })
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
      directory,
      server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    },
  )

  await page.goto("/scheduled")
  await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible()
  const openSession = page.locator('[data-action="scheduled-task-open-session"]')
  await expect(openSession).toHaveCount(0)

  const liveRun = { ...runningRun, sessionID, directory }
  inboxRun = liveRun
  events.push({
    directory,
    payload: {
      type: "scheduledTask.runUpdated",
      properties: { taskID, run: liveRun },
    },
  })

  await expect(openSession).toBeVisible()
  await expect(openSession).toHaveAttribute("href", `/${base64Encode(directory)}/session/${sessionID}`)
  await openSession.click()
  await expectSessionTitle(page, sessionTitle)
  const composer = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await expect(composer).toBeVisible()
  await composer.fill("Follow up on the scheduled audit")
  await expect(composer).toContainText("Follow up on the scheduled audit")
  await page.locator('[data-action="prompt-submit"]').click()
  await expect.poll(() => promptRequests.length).toBe(1)
  expect(promptRequests[0]).toMatchObject({
    agent: "build",
    model: { providerID: "mock", modelID: "mock-model" },
    parts: [{ type: "text", text: "Follow up on the scheduled audit" }],
  })

  // Terminal truth comes from a fresh authoritative inbox read, not a retained
  // client event projection. The Session remains the same durable inspection
  // surface after the scheduler considers the run complete.
  inboxRun = {
    ...liveRun,
    status: "succeeded",
    finishedAt: startedAt + 15_000,
  }
  await page.goto("/scheduled")
  await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible()
  const completedOpen = page.locator('[data-action="scheduled-task-open-session"]')
  await expect(completedOpen).toBeVisible()
  await expect(completedOpen).toHaveAttribute("href", `/${base64Encode(directory)}/session/${sessionID}`)
  await completedOpen.click()
  await expectSessionTitle(page, sessionTitle)
})

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers: { "access-control-allow-origin": "*" },
  })
}
