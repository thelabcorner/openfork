import { describe, expect, test } from "bun:test"
import { appendEventStreamAuthToken, eventStreamFetch, isEventStreamPath } from "./event-stream-auth"

const credentials = { username: "device", password: "tok_123" }

describe("isEventStreamPath", () => {
  test("matches the SSE endpoints", () => {
    expect(isEventStreamPath("/event")).toBe(true)
    expect(isEventStreamPath("/api/event")).toBe(true)
    expect(isEventStreamPath("/global/event")).toBe(true)
  })

  test("rejects regular API paths", () => {
    expect(isEventStreamPath("/session")).toBe(false)
    expect(isEventStreamPath("/api/session")).toBe(false)
    expect(isEventStreamPath("/events")).toBe(false)
  })
})

describe("appendEventStreamAuthToken", () => {
  test("appends the RAW device token on /event (server reads the query value verbatim)", () => {
    const url = appendEventStreamAuthToken("http://localhost:4096/event", credentials)
    expect(url.searchParams.get("auth_token")).toBe("tok_123")
  })

  test("appends base64 credentials for regular passwords (PTY websocket convention)", () => {
    const url = appendEventStreamAuthToken("http://localhost:4096/event", { username: "opencode", password: "secret" })
    expect(url.searchParams.get("auth_token")).toBe(btoa("opencode:secret"))
  })

  test("appends auth_token on /global/event and /api/event", () => {
    expect(
      appendEventStreamAuthToken("http://localhost:4096/global/event", credentials).searchParams.get("auth_token"),
    ).toBe("tok_123")
    expect(appendEventStreamAuthToken("http://localhost:4096/api/event", credentials).searchParams.get("auth_token")).toBe(
      "tok_123",
    )
  })

  test("preserves existing query params", () => {
    const url = appendEventStreamAuthToken("http://localhost:4096/event?directory=/tmp", credentials)
    expect(url.searchParams.get("directory")).toBe("/tmp")
    expect(url.searchParams.get("auth_token")).toBe("tok_123")
  })

  test("passes through non-event URLs untouched", () => {
    const url = appendEventStreamAuthToken("http://localhost:4096/session/ses_1", credentials)
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("passes through when there is no password", () => {
    const url = appendEventStreamAuthToken("http://localhost:4096/event", { username: "opencode" })
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("does not duplicate an existing auth_token", () => {
    const url = appendEventStreamAuthToken(`http://localhost:4096/event?auth_token=${btoa("a:b")}`, credentials)
    expect(url.searchParams.get("auth_token")).toBe(btoa("a:b"))
  })
})

describe("eventStreamFetch", () => {
  test("rewrites string inputs for event URLs", async () => {
    const seen: string[] = []
    const base = ((input: Parameters<typeof fetch>[0]) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(new Response("ok"))
    }) as typeof fetch
    await eventStreamFetch(base, credentials)("http://localhost:4096/event")
    expect(seen[0]).toContain("auth_token=")
  })

  test("rewrites Request inputs preserving method and headers", async () => {
    let received: Request | undefined
    const base = ((input: Parameters<typeof fetch>[0]) => {
      if (!(typeof input === "string") && !(input instanceof URL)) received = input
      return Promise.resolve(new Response("ok"))
    }) as typeof fetch
    const request = new Request("http://localhost:4096/api/event", {
      method: "GET",
      headers: { Authorization: "Basic abc" },
    })
    await eventStreamFetch(base, credentials)(request)
    expect(received).toBeDefined()
    expect(received!.method).toBe("GET")
    expect(received!.headers.get("Authorization")).toBe("Basic abc")
    expect(new URL(received!.url).searchParams.get("auth_token")).toBe("tok_123")
  })

  test("leaves non-event Request inputs untouched", async () => {
    let receivedUrl = ""
    const base = ((input: Parameters<typeof fetch>[0]) => {
      receivedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      return Promise.resolve(new Response("ok"))
    }) as typeof fetch
    await eventStreamFetch(base, credentials)(new Request("http://localhost:4096/session"))
    expect(receivedUrl).toBe("http://localhost:4096/session")
  })
})
