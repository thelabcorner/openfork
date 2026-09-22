import { expect, test, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/ScheduledQuotaResetCollision"
const projectID = "project_scheduled_quota_reset_collision"
const taskID = "stk_quota_reset_collision"

test("quota resets use a collision-free system rail beside scheduled task hit targets", async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })

  const collisionAt = Date.now()
  const task = {
    id: taskID,
    projectID,
    targetDirectory: directory,
    target: { kind: "directory" as const },
    sessionPolicy: { kind: "new" as const },
    name: "Collision audit",
    enabled: true,
    revision: 1,
    schedule: { kind: "daily" as const, times: [{ hour: 12, minute: 0 }] },
    timezone: "America/Chicago",
    action: { prompt: "Audit collision handling" },
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
    nextRunAt: collisionAt,
    consecutiveFailures: 0,
    source: "api" as const,
    time: { created: collisionAt - 86_400_000, updated: collisionAt - 1_000 },
  }
  const agenda = [{ taskID, scheduledAt: collisionAt, effectiveAt: collisionAt }]
  const resets = [
    {
      id: "opencode-go:account:primary",
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      resetAt: collisionAt,
      observedAt: collisionAt - 1_000,
      scope: "account" as const,
      accountId: "zen-primary",
      accountLabel: "Migrated Key",
      windows: [
        {
          key: "5h",
          usedPercent: 75,
          remainingPercent: 25,
          valueLabel: null,
          source: "provider" as const,
        },
      ],
    },
    {
      id: "claude:account:secondary",
      providerId: "claude",
      providerName: "Claude",
      resetAt: collisionAt + 8 * 60_000,
      observedAt: collisionAt - 500,
      scope: "account" as const,
      accountId: "claude-secondary",
      accountLabel: "Secondary",
      windows: [
        {
          key: "5h",
          usedPercent: 40,
          remainingPercent: 60,
          valueLabel: null,
          source: "provider" as const,
        },
      ],
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "scheduled-quota-reset-collision",
      time: { created: collisionAt - 100_000, updated: collisionAt },
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
    sessions: [],
    pageMessages: () => ({ items: [] }),
    strictBackendPort: true,
  })

  await page.route("**/scheduled-task**", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (method === "GET" && url.pathname === "/scheduled-task/agenda") return json(route, agenda)
    if (method === "GET" && url.pathname === "/scheduled-task") return json(route, [task])
    if (method === "GET" && url.pathname === "/scheduled-task/run") return json(route, [])
    if (method === "GET" && url.pathname === "/scheduled-task/inbox/count") return json(route, { unread: 0 })
    if (method === "GET" && url.pathname === "/scheduled-task/control") {
      return json(route, { paused: false, timeUpdated: collisionAt })
    }
    return route.fallback()
  })
  await page.route("**/quota/resets**", async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== "GET" || url.pathname !== "/quota/resets") return route.fallback()
    return json(route, {
      from: Number(url.searchParams.get("from")),
      to: Number(url.searchParams.get("to")),
      generatedAt: collisionAt,
      occurrences: resets,
      failures: [],
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

  const taskControl = page.locator('[data-calendar-layer="scheduled-task"]').filter({ hasText: "Collision audit" })
  const rails = page.locator('[data-calendar-layer="system-event-rail"]')
  const marker = page.locator('[data-calendar-layer="quota-reset-marker"]')
  const guides = page.locator('[data-calendar-layer="quota-reset-guide"]')
  await expect(taskControl).toHaveCount(1)
  await expect(rails.first()).toBeVisible()
  await expect(marker).toHaveCount(1)
  await expect(guides).toHaveCount(2)

  const taskBox = await taskControl.boundingBox()
  expect(taskBox).not.toBeNull()
  const railBoxes = await rails.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { x: box.x, right: box.right, width: box.width }
    }),
  )
  const taskRight = taskBox!.x + taskBox!.width
  const owningRail = railBoxes.filter((box) => box.x >= taskBox!.x).sort((left, right) => left.x - right.x)[0]
  expect(owningRail).toBeDefined()
  expect(taskRight).toBeLessThanOrEqual(owningRail!.x)

  // The task remains the primary canvas interaction even when a reset shares
  // its exact timestamp; the reset's click target is isolated in the rail.
  await taskControl.click()
  await expect(taskControl).toHaveClass(/ring-1/)

  const markerButton = marker.getByRole("button", { name: "2 resets" })
  await expect(markerButton).toBeVisible()
  await markerButton.hover()
  await expect(page.getByText("Migrated Key")).toBeVisible()
  await expect(page.getByText("Secondary")).toBeVisible()

  const widthWithRail = (await taskControl.boundingBox())!.width
  await page.getByRole("button", { name: /Quota resets/ }).click()
  await expect(rails).toHaveCount(0)
  await expect.poll(async () => (await taskControl.boundingBox())?.width ?? 0).toBeGreaterThan(widthWithRail + 20)
})

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers: { "access-control-allow-origin": "*" },
  })
}
