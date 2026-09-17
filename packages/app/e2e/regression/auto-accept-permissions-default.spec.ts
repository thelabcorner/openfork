import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { currentSession, flatSession, mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/AutoAcceptDefault"
const projectID = "proj_auto_accept_default"
const sessionA = session("ses_auto_accept_a", "Auto-accept A")
const sessionB = session("ses_auto_accept_b", "Auto-accept B")
const draftID = "draft_auto_accept_default"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const safetyNote =
  "Automatically approves permission requests. Use only with trusted projects—actions may run without asking you first."

type PermissionReply = { sessionID: string; permissionID: string; body: unknown }

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

async function mockBackend(
  page: Page,
  input: { replies?: PermissionReply[]; created?: { id: string }; createRequests?: string[] } = {},
) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "auto-accept-default",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "mock",
          name: "Mock",
          models: { "mock-model": { id: "mock-model", name: "Mock Model", limit: { context: 200_000 } } },
        },
      ],
      connected: ["mock"],
      default: { providerID: "mock", modelID: "mock-model" },
    },
    sessions: [sessionA, sessionB],
    pageMessages: () => ({ items: [] }),
  })

  // The v1 settings shell controller reads the unprefixed /pty/shells list; the
  // shared mock only shapes the /api variant, so answer the legacy path too.
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname !== "/pty/shells") return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "[]",
    })
  })

  // Registered after the shared catch-all so these win route precedence.
  if (input.replies) {
    const replies = input.replies
    const record = (route: Route) => {
      const match = new URL(route.request().url()).pathname.match(
        /\/(?:api\/)?session\/([^/]+)\/permissions?\/([^/]+)$/,
      )
      if (route.request().method() !== "POST" || !match) return false
      replies.push({ sessionID: match[1]!, permissionID: match[2]!, body: route.request().postDataJSON() })
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: "true",
      })
      return true
    }
    await page.route("**/*", async (route) => {
      if (record(route)) return
      return route.fallback()
    })
  }

  if (input.created) {
    const created = input.created
    const createdSession = flatSession(
      { id: created.id, projectID, directory, title: "Created session", time: { created: 2, updated: 2 } },
      directory,
    )
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      const method = route.request().method()
      if (method === "POST" && (url.pathname === "/session" || url.pathname === "/api/session")) {
        input.createRequests?.push(url.toString())
        return json(route, createdSession)
      }
      // Serve the dynamically-created session after a reload so the promoted
      // session (not the draft) is what reads the persisted choice.
      if (method === "GET" && url.pathname === `/session/${created.id}`) return json(route, createdSession)
      if (method === "GET" && url.pathname === `/api/session/${created.id}`)
        return json(route, { data: currentSession(createdSession, directory) })
      return route.fallback()
    })
  }
}

async function seed(page: Page, input: { tabs?: unknown; default?: boolean } = {}) {
  await page.addInitScript(
    ({ directory, draftID, server, tabs, preference }) => {
      const general: Record<string, unknown> = { newLayoutDesigns: true }
      if (preference !== undefined) general.autoAcceptPermissionsDefault = preference
      if (!localStorage.getItem("settings.v3")) localStorage.setItem("settings.v3", JSON.stringify({ general }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify(tabs))
      void draftID
      void server
    },
    { directory, draftID, server, tabs: input.tabs ?? [], preference: input.default },
  )
}

const autoAcceptToggle = (page: Page) => page.locator('[data-action="prompt-permissions-autoaccept"]')

const settingsScreen = (page: Page) => page.locator('[data-testid="settings-screen"]')

const settingsRow = (page: Page) =>
  settingsScreen(page).locator('[data-action="settings-auto-accept-permissions-default"]')

const settingsSwitch = (page: Page) => settingsRow(page).getByRole("switch")

async function openSettings(page: Page) {
  await page.goto("/settings?tab=general")
  await expectAppVisible(settingsScreen(page))
}

function readSettings(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("settings.v3")
    if (!raw) return undefined
    try {
      return (JSON.parse(raw) as { general?: { autoAcceptPermissionsDefault?: boolean } }).general
        ?.autoAcceptPermissionsDefault
    } catch {
      return undefined
    }
  })
}

function permissionEvent(sessionID: string, id: string) {
  return {
    id: `evt-${id}`,
    type: "permission.asked",
    properties: { id, sessionID, permission: "bash", patterns: ["git status"], metadata: {}, always: [] },
  }
}

function readAutoAccept(page: Page) {
  return page.evaluate(() => {
    const merged: Record<string, boolean> = {}
    for (let index = 0; index < localStorage.length; index++) {
      const storageKey = localStorage.key(index)
      if (!storageKey || !storageKey.startsWith("opencode.global.dat")) continue
      const raw = localStorage.getItem(storageKey)
      if (!raw) continue
      try {
        const value = (JSON.parse(raw) as { autoAccept?: Record<string, boolean> }).autoAccept
        if (value) Object.assign(merged, value)
      } catch {
        // Ignore unrelated global storage entries.
      }
    }
    return merged
  })
}

test("settings exposes the new-session default with a safety note and persists OFF across reload", async ({ page }) => {
  await mockBackend(page)
  await seed(page)

  await openSettings(page)

  const input = settingsSwitch(page)
  await expect(input).toBeEnabled()
  await expect(input).toBeChecked()
  await expect(settingsScreen(page).getByText(safetyNote)).toBeVisible()

  await settingsRow(page).locator('[data-slot="switch-control"]').click()
  await expect(input).not.toBeChecked()
  await expect.poll(() => readSettings(page)).toBe(false)

  await page.reload()
  await expectAppVisible(settingsScreen(page))
  await expect(settingsSwitch(page)).not.toBeChecked()
})

test("draft composer defaults ON while an existing session keeps its own OFF state", async ({ page }) => {
  await mockBackend(page)
  await seed(page, { tabs: [{ type: "draft", draftID, server, directory }] })

  await page.goto(`/new-session?draftId=${draftID}`)
  const draftToggle = autoAcceptToggle(page)
  await expectAppVisible(draftToggle)
  await expect(draftToggle).toHaveAttribute("aria-pressed", "true")
  await draftToggle.click()
  await expect(draftToggle).toHaveAttribute("aria-pressed", "false")

  await page.goto(`/${base64Encode(directory)}/session/${sessionA.id}`)
  const sessionToggle = autoAcceptToggle(page)
  await expectAppVisible(sessionToggle)
  await expect(sessionToggle).toHaveAttribute("aria-pressed", "false")
})

test("an explicit session choice survives reload and is not overwritten by the ON default", async ({ page }) => {
  await mockBackend(page)
  await seed(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionB.id}`)
  const toggle = autoAcceptToggle(page)
  await expectAppVisible(toggle)
  await expect(toggle).toHaveAttribute("aria-pressed", "false")

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expectAppVisible(autoAcceptToggle(page))
  await expect(autoAcceptToggle(page)).toHaveAttribute("aria-pressed", "true")

  // An explicit OFF must also be durable and must not be flipped back on by
  // the ON default on the next load.
  await autoAcceptToggle(page).click()
  await expect(autoAcceptToggle(page)).toHaveAttribute("aria-pressed", "false")
  await page.reload()
  await expectAppVisible(autoAcceptToggle(page))
  await expect(autoAcceptToggle(page)).toHaveAttribute("aria-pressed", "false")
})

test("permission requests follow the per-session auto-accept state", async ({ page }) => {
  const replies: PermissionReply[] = []
  const transport = await installSseTransport<{ directory: string; payload: Record<string, unknown> }>(page, {
    server,
    retry: 20,
  })
  await mockBackend(page, { replies })
  await seed(page, { tabs: [{ type: "session", server, sessionId: sessionB.id }] })

  await page.goto(`/${base64Encode(directory)}/session/${sessionB.id}`)
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await transport.waitForConnection()

  const toggle = autoAcceptToggle(page)
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")

  await transport.send({ directory, payload: permissionEvent(sessionA.id, "perm-a") })
  await transport.send({ directory, payload: permissionEvent(sessionB.id, "perm-b") })

  await expect.poll(() => replies.map((reply) => reply.sessionID)).toEqual([sessionB.id])
  expect(replies[0]).toEqual({ sessionID: sessionB.id, permissionID: "perm-b", body: { response: "once" } })
})

test("creating a session from the draft materializes the ON default as an explicit session choice", async ({ page }) => {
  const createdID = "ses_auto_accept_created"
  const createRequests: string[] = []
  await mockBackend(page, { created: { id: createdID }, createRequests })
  await seed(page, { tabs: [{ type: "draft", draftID, server, directory }] })

  await page.goto(`/new-session?draftId=${draftID}`)
  const input = page.locator('[data-component="prompt-input"]')
  await expectAppVisible(input)
  await expect(autoAcceptToggle(page)).toHaveAttribute("aria-pressed", "true")

  await input.fill("hello")
  await page.locator('[data-action="prompt-submit"]').click()

  await expect.poll(() => createRequests.length).toBeGreaterThan(0)
  await expect(page).toHaveURL(new RegExp(`/session/${createdID}$`))
  // With no explicit key an existing session resolves to OFF, so an ON toggle
  // on the promoted session proves the draft's effective value was stamped.
  const key = `${base64Encode(directory)}/${createdID}`
  await expect(page).toHaveURL(new RegExp(`/session/${createdID}$`))
  await expect(autoAcceptToggle(page)).toHaveAttribute("aria-pressed", "true")
  await expect.poll(async () => (await readAutoAccept(page))[key]).toBe(true)

  // Reload forces the session to rehydrate from persisted state, proving this
  // is a durable explicit choice rather than transient draft-level state.
  await page.reload()
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await expect(autoAcceptToggle(page)).toHaveAttribute("aria-pressed", "true")
})

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}
