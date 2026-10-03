import { describe, expect, test } from "bun:test"
import { createDesktopFetch } from "./control-fetch"

const ready = { url: "http://127.0.0.1:4096", username: "openfork", password: "secret" }

describe("desktop control fetch adapter", () => {
  test("control dispatch completes independently while ordinary renderer traffic is blocked", async () => {
    let releaseBackground!: (response: Response) => void
    let backgroundStarted = false
    let controlCalls = 0
    const fetcher = createDesktopFetch({
      fetch: async () => {
        backgroundStarted = true
        return await new Promise<Response>((resolve) => (releaseBackground = resolve))
      },
      awaitInitialization: async () => ready,
      dispatch: async (_requestID, input) => {
        controlCalls++
        expect(input.url).toContain("/global/event/interest")
        return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: '{"updated":true}' }
      },
      cancel: () => {},
    })

    const background = fetcher("http://127.0.0.1:4096/provider", { method: "GET" })
    await Promise.resolve()
    expect(backgroundStarted).toBe(true)
    const control = await fetcher("http://127.0.0.1:4096/global/event/interest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(await control.json()).toEqual({ updated: true })
    expect(controlCalls).toBe(1)
    releaseBackground(new Response("catalog"))
    await expect((await background).text()).resolves.toBe("catalog")
  })

  test("keeps remote and non-control traffic on the existing renderer fetch", async () => {
    const calls: string[] = []
    const fetcher = createDesktopFetch({
      fetch: async (input) => {
        calls.push(input instanceof Request ? input.url : input.toString())
        return new Response("ordinary")
      },
      awaitInitialization: async () => ready,
      dispatch: async () => {
        throw new Error("must not dispatch")
      },
      cancel: () => {},
    })

    await fetcher("https://server.example/session/ses_1/prompt_async", { method: "POST", body: "{}" })
    await fetcher("http://127.0.0.1:4096/session/ses_1/message", { method: "GET" })
    expect(calls).toEqual([
      "https://server.example/session/ses_1/prompt_async",
      "http://127.0.0.1:4096/session/ses_1/message",
    ])
  })

  test("cancels a dispatched control request when its caller aborts", async () => {
    const controller = new AbortController()
    let cancelID: string | undefined
    let release!: () => void
    const fetcher = createDesktopFetch({
      fetch: async () => new Response("ordinary"),
      awaitInitialization: async () => ready,
      dispatch: async () => await new Promise((_resolve, reject) => (release = () => reject(new Error("cancelled")))),
      cancel: (id) => {
        cancelID = id
        release()
      },
    })
    const pending = fetcher("http://127.0.0.1:4096/session/ses_1/abort", {
      method: "POST",
      signal: controller.signal,
    })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    expect(cancelID).toBeString()
    await expect(pending).rejects.toThrow()
  })
})
