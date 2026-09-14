import { expect, test } from "bun:test"
import type { Page, Route } from "@playwright/test"
import { mockOpenCodeServer } from "../../utils/mock-server"

test("applies message latency after a list response gate is released", async () => {
  const events: string[] = []
  const gate = Promise.withResolvers<void>()
  let handler: ((route: Route) => Promise<void>) | undefined
  const page = {
    route: (_url: string, callback: (route: Route) => Promise<void>) => {
      handler = callback
      return Promise.resolve()
    },
  } as unknown as Page
  await mockOpenCodeServer(page, {
    provider: {},
    directory: "C:/OpenCode",
    project: {},
    sessions: [{ id: "session" }],
    messageDelay: 25,
    beforeMessagesResponse: () => {
      events.push("before")
      return gate.promise
    },
    onMessages: (request) => events.push(request.phase),
    pageMessages: () => {
      events.push("page")
      return { items: [] }
    },
  })

  const response = handler!({
    request: () => ({ url: () => "http://127.0.0.1:4096/session/session/message" }),
    fulfill: () => {
      events.push("fulfill")
      return Promise.resolve()
    },
  } as unknown as Route)
  expect(events).toEqual(["start", "before"])

  const released = performance.now()
  gate.resolve()
  await response
  expect(performance.now() - released).toBeGreaterThanOrEqual(20)
  expect(events).toEqual(["start", "before", "page", "end", "fulfill"])
})

test("strict backend mode never lets the Vite origin impersonate the mocked OpenCode backend", async () => {
  const previousServerPort = process.env.PLAYWRIGHT_SERVER_PORT
  const previousBaseUrl = process.env.PLAYWRIGHT_BASE_URL
  process.env.PLAYWRIGHT_SERVER_PORT = "4096"
  process.env.PLAYWRIGHT_BASE_URL = "http://127.0.0.1:3030"

  try {
    let handler: ((route: Route) => Promise<void>) | undefined
    const page = {
      route: (_url: string, callback: (route: Route) => Promise<void>) => {
        handler = callback
        return Promise.resolve()
      },
    } as unknown as Page

    await mockOpenCodeServer(page, {
      strictBackendPort: true,
      provider: {},
      directory: "C:/OpenCode",
      project: {},
      sessions: [{ id: "session" }],
      pageMessages: () => ({ items: [] }),
    })

    const calls: string[] = []
    const route = (url: string) =>
      ({
        request: () => ({ url: () => url }),
        fallback: () => {
          calls.push("fallback")
          return Promise.resolve()
        },
        fulfill: () => {
          calls.push("fulfill")
          return Promise.resolve()
        },
      }) as unknown as Route

    await handler!(route("http://127.0.0.1:3030/api/health"))
    expect(calls).toEqual(["fallback"])

    calls.length = 0
    await handler!(route("http://127.0.0.1:4096/api/health"))
    expect(calls).toEqual(["fulfill"])
  } finally {
    if (previousServerPort === undefined) delete process.env.PLAYWRIGHT_SERVER_PORT
    else process.env.PLAYWRIGHT_SERVER_PORT = previousServerPort
    if (previousBaseUrl === undefined) delete process.env.PLAYWRIGHT_BASE_URL
    else process.env.PLAYWRIGHT_BASE_URL = previousBaseUrl
  }
})
