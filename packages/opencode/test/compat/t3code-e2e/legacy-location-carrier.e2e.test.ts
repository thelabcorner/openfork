// Durable regression guard for the LEGACY SDK location-carrier contract.
//
// EVIDENCE CLASS: `real_http_sse` (real listener, real HTTP) — plus one pure
// transport-normalization unit block that needs no server.
//
// WHY THIS FILE EXISTS
//
// The legacy SDK never sends a bare path. `createOpencodeClient({directory})`
// injects `x-opencode-directory: encodeURIComponent(directory)` and a request
// interceptor then rewrites GET/HEAD into `?directory=`, deleting the header
// (packages/sdk/js/src/client.ts:17-31,46-51). The server accepts BOTH carriers
// but decodes them differently
// (middleware/workspace-routing.ts:89-103): the query value is used as-is
// because `URLSearchParams` already decoded it, while the header value is
// `decodeURIComponent`ed because the SDK URI-encoded it.
//
// The round trip only stays correct because `pick()`
// (packages/sdk/js/src/client.ts:9-15) recognizes the encoded header as
// equivalent to the raw configured directory and hands back the RAW value for
// the query. Delete or "simplify" `pick()` and every GET/HEAD instance route
// starts receiving a doubly-encoded path while POST keeps working — the exact
// asymmetric signature that `handlers/session-control.ts` exhibited on
// `session.abort`.
//
// Nothing in the repository pinned this before the abort defect, so this file
// is the guard.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import {
  cleanupScratch,
  legacyFetch,
  resetCompatState,
  sdkPick,
  startCompatServer,
  type CompatServer,
} from "./harness"

let server: CompatServer | undefined

async function ensureServer() {
  server ??= await startCompatServer("t3code")
  return server
}

afterEach(async () => {
  await resetCompatState()
})

afterAll(async () => {
  await server?.stop()
  server = undefined
  await cleanupScratch()
})

describe("legacy SDK transport normalization (no server)", () => {
  // These pin the SDK's own rules from its source. If the SDK changes, the
  // contract changed, and this must fail rather than silently drift.
  test("pick() un-does the header encoding so the GET query carries the raw path", () => {
    const directory = "C:\\work\\t3 thread"
    const headerValue = encodeURIComponent(directory)
    expect(headerValue).not.toBe(directory)
    expect(sdkPick(headerValue, directory)).toBe(directory)
  })

  test("pick() leaves a genuinely different value alone", () => {
    expect(sdkPick("D:\\elsewhere", "C:\\work\\t3 thread")).toBe("D:\\elsewhere")
    expect(sdkPick(null, "C:\\work")).toBeUndefined()
  })
})

describe("legacy location carriers over real HTTP", () => {
  test("GET carrier (?directory, encoded exactly once by URLSearchParams) reaches the instance", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({
      baseUrl: active.url,
      path: "/agent",
      directory: active.workspace,
    })
    expect(response.status).toBe(200)
    expect(Array.isArray(response.json)).toBe(true)
  })

  test("POST carrier (percent-encoded x-opencode-directory header) reaches the instance", async () => {
    const active = await ensureServer()
    const created = await legacyFetch({
      baseUrl: active.url,
      path: "/session",
      method: "POST",
      directory: active.workspace,
      body: { title: "T3 Code thread (carrier)" },
    })
    expect(created.status).toBe(200)
    expect(typeof (created.json as { id?: unknown } | undefined)?.id).toBe("string")
  })

  test("BOTH carriers address the SAME workspace instance", async () => {
    const active = await ensureServer()
    const viaQuery = await legacyFetch({ baseUrl: active.url, path: "/agent", directory: active.workspace })
    const viaHeader = await legacyFetch({
      baseUrl: active.url,
      path: "/agent",
      rawDirectory: { carrier: "header", value: encodeURIComponent(active.workspace) },
    })
    expect(viaQuery.status).toBe(200)
    expect(viaHeader.status).toBe(200)
    expect(JSON.stringify(viaHeader.json)).toBe(JSON.stringify(viaQuery.json))
  })

  test("a session created via the POST carrier is readable via the GET carrier", async () => {
    // This is the cross-carrier round trip that actually matters: T3 creates with
    // a header and then reads with a query. If the two carriers disagreed about
    // the resolved directory the read would 404 or return an empty session.
    const active = await ensureServer()
    const created = await legacyFetch({
      baseUrl: active.url,
      path: "/session",
      method: "POST",
      directory: active.workspace,
      body: { title: "T3 Code thread (round trip)" },
    })
    const sessionID = (created.json as { id: string }).id
    const fetched = await legacyFetch({
      baseUrl: active.url,
      path: `/session/${sessionID}`,
      directory: active.workspace,
    })
    expect(fetched.status).toBe(200)
    expect((fetched.json as { id: string }).id).toBe(sessionID)
  })

  test("DOUBLE encoding is rejected rather than silently resolving to a bogus path", async () => {
    // Negative invariant. A doubly-encoded path is the exact failure `pick()`
    // exists to prevent, so the server must not accept it as a location.
    const active = await ensureServer()
    const response = await legacyFetch({
      baseUrl: active.url,
      path: "/agent",
      rawDirectory: { carrier: "query", value: encodeURIComponent(encodeURIComponent(active.workspace)) },
    })
    expect(response.status).not.toBe(200)
  })

  test("a RELATIVE directory is rejected: the carrier must be absolute", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({
      baseUrl: active.url,
      path: "/agent",
      rawDirectory: { carrier: "query", value: "." },
    })
    expect(response.status).toBe(400)
  })

  test("a MISSING directory is rejected rather than falling back to process.cwd()", async () => {
    // Ownership invariant from AGENTS.md: never invent a location from cwd.
    const active = await ensureServer()
    const response = await legacyFetch({ baseUrl: active.url, path: "/agent" })
    expect(response.status).toBe(400)
  })

  test("malformed percent-encoding in the header fails safe instead of throwing", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({
      baseUrl: active.url,
      path: "/agent",
      rawDirectory: { carrier: "header", value: "%E0%A4%A" },
    })
    // Not a 500. Whatever it decides, an undecodable carrier must not become a
    // server fault.
    expect(response.status).not.toBe(500)
  })
})

describe("legacy Basic authentication over real HTTP", () => {
  test("the default username is exactly `opencode`", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({ baseUrl: active.url, path: "/global/health" })
    expect(response.status).toBe(200)
    expect(response.json).toMatchObject({ healthy: true })
  })

  test("a wrong password is rejected with an EMPTY body and a www-authenticate challenge", async () => {
    const active = await ensureServer()
    const response = await fetch(`${active.url}/global/health`, {
      headers: {
        Authorization: `Basic ${Buffer.from("opencode:not-the-password", "utf8").toString("base64")}`,
      },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
    expect((await response.text()).length).toBe(0)
  })

  test("a missing Authorization header is rejected", async () => {
    const active = await ensureServer()
    expect((await fetch(`${active.url}/global/health`)).status).toBe(401)
  })
})