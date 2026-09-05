/**
 * End-to-end over real sockets, on purpose.
 *
 * The bug this file exists to prevent was a config option that did not exist:
 * the proxy was handed the verified URL through `http-proxy`'s non-existent
 * `router` hook, so every request silently went to the placeholder target and
 * the entire API answered an empty 500. Unit tests of the resolver all passed —
 * the resolver was fine. Nothing asserted that a byte ever reached a backend.
 *
 * So: two genuine HTTP servers, and assertions about what actually arrives.
 */
import { afterEach, describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { INSTANCE_EXPECT_HEADER } from "./constants"
import { createApiProxy } from "./proxy"
import type { TargetResolution } from "./target"

const INSTANCE = "desktop:instance-under-test"

type Received = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

function listen(server: http.Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      closers.push(
        () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      )
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

/** Stands in for the opencode sidecar, including its instance-pin check. */
async function upstream(input: { instanceID?: string } = {}) {
  const seen: Received[] = []
  let releaseStream: (() => void) | undefined
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      })

      const pin = request.headers[INSTANCE_EXPECT_HEADER]
      const actual = input.instanceID ?? INSTANCE
      if (pin && pin !== actual) {
        response.writeHead(409, { "content-type": "application/json" })
        response.end(JSON.stringify({ name: "InstanceMismatchError", data: { expected: pin, actual } }))
        return
      }

      if (request.url === "/event") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        response.write("data: first\n\n")
        // Held open until the test has proven the first event already arrived —
        // that is the difference between streaming and buffering.
        releaseStream = () => {
          response.write("data: second\n\n")
          response.end()
        }
        return
      }

      response.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" })
      response.end(JSON.stringify({ ok: true, path: request.url, body: Buffer.concat(chunks).toString() }))
    })
  })
  const url = await listen(server)
  return { url, seen, release: () => releaseStream?.() }
}

/** Stands in for the Vite dev server: our middleware, then a SPA-ish fallback. */
async function front(resolution: () => Promise<TargetResolution> | TargetResolution) {
  const api = createApiProxy({
    resolver: { resolve: async () => resolution() },
    apiPrefixes: ["session", "event", "instance", "pair"],
  })
  const server = http.createServer((request, response) => {
    api.handle(request, response, () => {
      response.writeHead(200, { "content-type": "text/html" })
      response.end("<!doctype html>vite-fallback")
    })
  })
  return { url: await listen(server), api }
}

const bound = (url: string, instanceID = INSTANCE): TargetResolution => ({
  ok: true,
  url,
  instanceID,
  identity: { instanceID },
  source: "handshake",
})

const unbound: TargetResolution = {
  ok: false,
  code: "DesktopSidecarInstanceMismatchError",
  message: "A different opencode answered on the expected port.",
  hint: "Restart the desktop with `bun run dev`.",
  detail: "expected a, got b",
}

describe("dev API proxy", () => {
  test("actually forwards a request to the verified backend", async () => {
    const back = await upstream()
    const dev = await front(() => bound(back.url))

    const response = await fetch(`${dev.url}/session/abc?limit=2`)
    expect(response.status).toBe(200)
    expect(response.headers.get("x-upstream")).toBe("yes")
    expect(await response.json()).toMatchObject({ ok: true, path: "/session/abc?limit=2" })
    expect(back.seen).toHaveLength(1)
    expect(back.seen[0]!.url).toBe("/session/abc?limit=2")
  })

  test("forwards the request body and method", async () => {
    const back = await upstream()
    const dev = await front(() => bound(back.url))

    const response = await fetch(`${dev.url}/session/abc/message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: JSON.stringify({ text: "hello" }),
    })
    expect(response.status).toBe(200)
    expect(back.seen[0]!.method).toBe("POST")
    expect(back.seen[0]!.body).toBe(JSON.stringify({ text: "hello" }))
    expect(back.seen[0]!.headers.authorization).toBe("Bearer token")
  })

  test("pins every forwarded request to the verified instance", async () => {
    const back = await upstream()
    const dev = await front(() => bound(back.url))

    await fetch(`${dev.url}/session/abc`)
    expect(back.seen[0]!.headers[INSTANCE_EXPECT_HEADER]).toBe(INSTANCE)
  })

  test("a client cannot forge the pin to reach a different instance", async () => {
    const back = await upstream()
    const dev = await front(() => bound(back.url))

    await fetch(`${dev.url}/session/abc`, { headers: { [INSTANCE_EXPECT_HEADER]: "some-other-instance" } })
    // The proxy's verified value wins; the client's header is overwritten, not merged.
    expect(back.seen[0]!.headers[INSTANCE_EXPECT_HEADER]).toBe(INSTANCE)
  })

  test("surfaces the backend's own refusal when the port changed hands", async () => {
    // The resolver still believes in `INSTANCE`, but the process now listening
    // is someone else — the case a probe-then-connect design cannot catch.
    const back = await upstream({ instanceID: "a-completely-different-opencode" })
    const dev = await front(() => bound(back.url))

    const response = await fetch(`${dev.url}/session/abc`)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ name: "InstanceMismatchError" })
  })

  test("streams SSE incrementally instead of buffering it", async () => {
    const back = await upstream()
    const dev = await front(() => bound(back.url))

    const response = await fetch(`${dev.url}/event`)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()

    const first = await reader.read()
    // Arrived while the upstream response is still open: proof the hop is not
    // waiting for the body to complete.
    expect(new TextDecoder().decode(first.value)).toContain("first")

    back.release()
    let rest = ""
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      rest += new TextDecoder().decode(chunk.value)
    }
    expect(rest).toContain("second")
  })

  test("does not compress the hop, which would buffer the stream", async () => {
    const back = await upstream()
    const dev = await front(() => bound(back.url))

    await fetch(`${dev.url}/session/abc`, { headers: { "accept-encoding": "gzip, br" } })
    expect(back.seen[0]!.headers["accept-encoding"]).toBe("identity")
  })

  test("refuses with an actionable 503 rather than reaching any backend", async () => {
    const back = await upstream()
    const dev = await front(() => unbound)

    const response = await fetch(`${dev.url}/session/abc`)
    expect(response.status).toBe(503)
    const body = (await response.json()) as { name: string; data: { message: string; hint: string } }
    expect(body.name).toBe("DesktopSidecarInstanceMismatchError")
    expect(body.data.hint).toContain("bun run dev")
    expect(back.seen).toHaveLength(0)
  })

  test("answers 502 when the verified backend has since died", async () => {
    const dev = await front(() => bound("http://127.0.0.1:1"))

    const response = await fetch(`${dev.url}/session/abc`)
    expect(response.status).toBe(502)
    expect((await response.json()).name).toBe("DesktopSidecarProxyError")
  })

  test("leaves non-API paths to the dev server", async () => {
    const back = await upstream()
    const dev = await front(() => bound(back.url))

    expect(await (await fetch(`${dev.url}/`)).text()).toContain("vite-fallback")
    expect(await (await fetch(`${dev.url}/assets/app.js`)).text()).toContain("vite-fallback")
    // `/sessions` must not match the `session` prefix on a substring basis.
    expect(await (await fetch(`${dev.url}/sessionsomething`)).text()).toContain("vite-fallback")
    expect(back.seen).toHaveLength(0)
  })

  test("reports the binding on the dev-target status route", async () => {
    const back = await upstream()
    const dev = await front(() => bound(back.url))

    const ok = await (await fetch(`${dev.url}/__opencode/dev-target`)).json()
    expect(ok).toMatchObject({ bound: true, instanceID: INSTANCE, source: "handshake" })

    const broken = await front(() => unbound)
    const bad = await (await fetch(`${broken.url}/__opencode/dev-target`)).json()
    expect(bad).toMatchObject({ bound: false, code: "DesktopSidecarInstanceMismatchError" })
  })

  test("re-resolves per request, so a rebind takes effect immediately", async () => {
    const first = await upstream({ instanceID: "first" })
    const second = await upstream({ instanceID: "second" })
    let current = first
    const dev = await front(() => bound(current.url, current === first ? "first" : "second"))

    await fetch(`${dev.url}/session/abc`)
    current = second
    await fetch(`${dev.url}/session/abc`)

    expect(first.seen).toHaveLength(1)
    expect(second.seen).toHaveLength(1)
    expect(second.seen[0]!.headers[INSTANCE_EXPECT_HEADER]).toBe("second")
  })

  test("a resolver that throws fails closed", async () => {
    const dev = await front(() => {
      throw new Error("handshake file vanished")
    })

    const response = await fetch(`${dev.url}/session/abc`)
    expect(response.status).toBe(503)
    expect((await response.json()).name).toBe("DesktopSidecarUnavailableError")
  })
})
