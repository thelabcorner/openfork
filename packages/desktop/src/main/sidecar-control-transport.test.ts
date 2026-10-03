import { describe, expect, test } from "bun:test"
import {
  createSidecarControlTransport,
  isLoopbackControlOrigin,
  validateSidecarControlFetch,
} from "./sidecar-control-transport"

const input = {
  url: "http://127.0.0.1:4096/global/event/interest?directory=%2Frepo",
  method: "POST",
  headers: {
    authorization: "Basic dXNlcjpwYXNz",
    "content-type": "application/json",
    "x-opencode-directory": "%2Frepo",
  },
  body: JSON.stringify({ subscriber: "sub_1", generation: 2, sessions: ["ses_1"] }),
}

describe("sidecar control transport", () => {
  test("urgent signals complete while runtime admission is stalled", async () => {
    const admission = Promise.withResolvers<Response>()
    let admitted = false
    const dispatch = createSidecarControlTransport({
      sidecarURL: () => "http://127.0.0.1:4096",
      fetchAdmission: async () => { admitted = true; return admission.promise },
      fetch: async () => new Response("true"),
    })
    const pending = dispatch({ ...input, url: "http://127.0.0.1:4096/session/ses_1/prompt_async" }, new AbortController().signal)
    expect(admitted).toBe(true)
    const signal = await dispatch({ ...input, url: "http://127.0.0.1:4096/session/ses_1/abort" }, new AbortController().signal)
    expect(signal.body).toBe("true")
    const created = await dispatch({ ...input, url: "http://127.0.0.1:4096/session" }, new AbortController().signal)
    expect(created.body).toBe("true")
    admission.resolve(new Response(null, { status: 204 }))
    await pending
  })
  test("requires the exact local active-sidecar origin and a control method/path", () => {
    expect(isLoopbackControlOrigin("http://127.0.0.1:4096")).toBe(true)
    expect(isLoopbackControlOrigin("https://127.0.0.1:4096")).toBe(false)
    expect(isLoopbackControlOrigin("http://localhost:4096")).toBe(true)
    expect(isLoopbackControlOrigin("http://example.test:4096")).toBe(false)
    expect(() => validateSidecarControlFetch({ ...input, url: "http://127.0.0.1:4097/global/event/interest" }, "http://127.0.0.1:4096")).toThrow()
    expect(() => validateSidecarControlFetch({ ...input, url: "http://127.0.0.1:4096/provider" }, "http://127.0.0.1:4096")).toThrow()
    expect(() => validateSidecarControlFetch(input, "http://example.test:4096")).toThrow()
  })

  test("forwards only approved auth/location headers and omits cookie credentials", async () => {
    let observed: { init: RequestInit; url: URL } | undefined
    const dispatch = createSidecarControlTransport({
      sidecarURL: () => "http://127.0.0.1:4096",
      fetch: async (url, init) => {
        observed = { url, init }
        return new Response(JSON.stringify({ updated: true, generation: 2 }), {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "ignored=yes" },
        })
      },
    })
    const result = await dispatch(input, new AbortController().signal)

    expect(observed?.url.href).toBe(input.url)
    expect(observed?.init.credentials).toBe("omit")
    expect(observed?.init.cache).toBe("no-store")
    expect(observed?.init.redirect).toBe("error")
    expect(observed?.init.referrerPolicy).toBe("no-referrer")
    expect(new Headers(observed?.init.headers).get("cookie")).toBeNull()
    expect(new Headers(observed?.init.headers).get("authorization")).toBe(input.headers.authorization)
    expect(result.body).toBe('{"updated":true,"generation":2}')
    expect(result.headers).toEqual({ "content-type": "application/json" })
  })

  test("rejects headers that could extend the dispatch capability", () => {
    expect(() =>
      validateSidecarControlFetch(
        { ...input, headers: { ...input.headers, cookie: "session=secret" } },
        "http://127.0.0.1:4096",
      ),
    ).toThrow()
  })

  test("aborts the isolated session fetch with the renderer request signal", async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const dispatch = createSidecarControlTransport({
      sidecarURL: () => "http://127.0.0.1:4096",
      fetch: async (_url, init) => {
        observedSignal = init.signal as AbortSignal
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
        })
      },
    })
    const pending = dispatch(input, controller.signal)
    await Promise.resolve()
    controller.abort()
    expect(observedSignal?.aborted).toBe(true)
    await expect(pending).rejects.toThrow()
  })
})
