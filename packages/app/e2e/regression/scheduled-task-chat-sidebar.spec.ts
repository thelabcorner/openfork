import { expect, test, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const worktree = "C:/OpenCode/ScheduledSidebarProject"
const workerDirectory = "C:/OpenCode/.scheduled/ScheduledSidebarProject/task-a"
const projectID = "project_scheduled_sidebar"
const ordinarySessionID = "ses_ordinary_sidebar"
const scheduledSessionID = "ses_scheduled_sidebar"
const startedAt = 1_796_100_000_000

type EventPayload = {
  directory: string
  payload: {
    type: string
    properties: Record<string, unknown>
  }
}

const ordinarySession = {
  id: ordinarySessionID,
  slug: "ordinary-sidebar",
  projectID,
  directory: worktree,
  title: "Ordinary project root",
  version: "dev",
  time: { created: startedAt - 60_000, updated: startedAt - 60_000 },
}

const scheduledSession = {
  id: scheduledSessionID,
  slug: "scheduled-sidebar",
  projectID,
  directory: workerDirectory,
  title: "Scheduled audit — active",
  version: "dev",
  metadata: {
    scheduledTaskID: "stk_sidebar",
    scheduledTaskRunID: "str_sidebar",
  },
  time: { created: startedAt, updated: startedAt },
}

test("foreign-directory Scheduled root converges through the project Session census and ordinary Session events", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const events: EventPayload[] = []
  const sessions: Array<Record<string, unknown> & { id: string }> = [{ ...ordinarySession }]
  const rootQueries: URLSearchParams[] = []
  const scheduledDataRequests: string[] = []
  let projectCatalogRequests = 0
  const project = {
    id: projectID,
    worktree,
    vcs: "git",
    name: "scheduled-sidebar-project",
    time: { created: startedAt - 100_000, updated: startedAt },
    sandboxes: [],
  }

  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === "GET" && (path === "/scheduled-task" || path === "/scheduled-task/run")) {
      scheduledDataRequests.push(path)
    }
  })

  await mockOpenCodeServer(page, {
    directory: worktree,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions,
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
    persistentEvents: true,
    strictBackendPort: true,
  })

  // Persisted layout state below intentionally knows only the worktree. The
  // production Tier-0 project catalog supplies the durable project identity
  // asynchronously and must upgrade the already-started root Session census.
  await page.route("**/global/project", (route) => {
    projectCatalogRequests++
    return json(route, [project])
  })

  // Registered after the broad mock route so this production Tier-0 endpoint
  // wins. The test deliberately models a root whose physical directory differs
  // from the project worktree: projectID must be the census key.
  await page.route("**/global/session/roots**", async (route) => {
    const url = new URL(route.request().url())
    const query = url.searchParams
    rootQueries.push(new URLSearchParams(query))
    const scopedProject = query.get("projectID")
    const scopedDirectory = query.get("directory")
    const limit = Math.max(1, Number(query.get("limit") ?? 50))
    const rows = sessions
      .filter((session) => !session.parentID)
      .filter((session) =>
        scopedProject ? session.projectID === scopedProject : session.directory === scopedDirectory,
      )
      .filter((session) => !(session.time as { archived?: number } | undefined)?.archived)
      .toSorted((left, right) => {
        const leftUpdated = (left.time as { updated?: number } | undefined)?.updated ?? 0
        const rightUpdated = (right.time as { updated?: number } | undefined)?.updated ?? 0
        return rightUpdated - leftUpdated || right.id.localeCompare(left.id)
      })
      .slice(0, limit)
    return json(route, rows)
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
      directory: worktree,
      server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    },
  )

  await page.goto("/")
  const toggle = page.locator('button[aria-controls="chat-sidebar-pane"]')
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()

  const sidebar = page.locator("#chat-sidebar-pane")
  await expect(sidebar).toBeVisible()
  const ordinaryRow = sidebar.locator(`[data-chat-tooltip-session="${ordinarySessionID}"]`)
  const scheduledRow = sidebar.locator(`[data-chat-tooltip-session="${scheduledSessionID}"]`)
  // The sidebar intentionally projects each visible root once in Recent and
  // once in its project group. Two is therefore the exact non-duplicate
  // baseline; a third copy would be a real project/sandbox aggregation bug.
  await expect(ordinaryRow).toHaveCount(2)
  await expect(scheduledRow).toHaveCount(0)

  expect(projectCatalogRequests).toBeGreaterThan(0)
  await expect
    .poll(() =>
      rootQueries.some((query) => query.get("projectID") === projectID && query.get("directory") === worktree),
    )
    .toBe(true)
  // This fixture's persisted layout intentionally begins directory-only. The
  // authoritative project catalog must upgrade that already-started census to
  // project scope before the foreign worker event arrives.
  // Opening the Session sidebar must not import the Scheduled Tasks catalog or
  // inbox as a second source of truth.
  expect(scheduledDataRequests).toEqual([])

  // The scheduler creates/attaches the ordinary root Session before model work.
  // A physical worker-directory event must enter the already-materialized
  // canonical project Session index without another root fetch.
  // The authoritative project catalog is already present; the Session event is
  // the only input needed for the foreign worker root.
  sessions.push({ ...scheduledSession })
  const rootsBeforeCreate = rootQueries.length
  events.push({
    directory: workerDirectory,
    payload: { type: "session.created", properties: { info: { ...scheduledSession } } },
  })
  await expect(scheduledRow).toHaveCount(2)
  await expect(scheduledRow.first()).toContainText("Scheduled audit — active")
  expect(rootQueries).toHaveLength(rootsBeforeCreate)
  expect(scheduledDataRequests).toEqual([])

  // Ordinary Session metadata remains the live update surface.
  const settledSession = {
    ...scheduledSession,
    title: "Scheduled audit — settled",
    time: { ...scheduledSession.time, updated: startedAt + 15_000 },
  }
  sessions[sessions.findIndex((session) => session.id === scheduledSessionID)] = settledSession
  events.push({
    directory: workerDirectory,
    payload: { type: "session.updated", properties: { info: settledSession } },
  })
  await expect(scheduledRow).toHaveCount(2)
  await expect(scheduledRow.first()).toContainText("Scheduled audit — settled")

  // Settlement belongs to the Scheduled Task producer, but it must neither
  // replace nor remove the ordinary Session row.
  events.push({
    directory: "global",
    payload: {
      type: "scheduledTask.runSettled",
      properties: {
        taskID: "stk_sidebar",
        run: {
          id: "str_sidebar",
          taskID: "stk_sidebar",
          fireFor: startedAt,
          trigger: "schedule",
          status: "succeeded",
          sessionID: scheduledSessionID,
          directory: workerDirectory,
          attempt: 1,
          startedAt,
          finishedAt: startedAt + 15_000,
        },
      },
    },
  })
  await expect(scheduledRow).toHaveCount(2)
  expect(scheduledDataRequests).toEqual([])

  // Deletion converges through the same Session event path and does not require
  // a Scheduled-specific invalidation or refetch.
  events.push({
    directory: workerDirectory,
    payload: { type: "session.deleted", properties: { sessionID: scheduledSessionID, info: settledSession } },
  })
  await expect(scheduledRow).toHaveCount(0)
  await expect(ordinaryRow).toHaveCount(2)
  expect(scheduledDataRequests).toEqual([])
})

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers: { "access-control-allow-origin": "*" },
  })
}
