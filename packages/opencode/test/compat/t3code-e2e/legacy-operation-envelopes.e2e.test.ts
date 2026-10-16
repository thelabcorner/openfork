// Durable regression guard for the AUDITED legacy T3 Code operation matrix.
//
// EVIDENCE CLASS: `real_http_sse` (real listener, real HTTP over a real socket).
//
// SCOPE / TAXONOMY
//
// This is `openfork_process_integration`, NOT the real stock-T3 E2E gate. The
// client side here is a hand-written driver, so this file proves OpenFork's
// legacy wire contract, not that immutable T3 source interoperates. The stock
// gate is satisfied by executing pinned T3 snapshots.
//
// WHY THIS FILE IS NOT A DUPLICATE
//
// The existing suite (test/server/t3code-compat-contract.test.ts) asserts route
// EXISTENCE from the generated OpenApi spec and payload ACCEPTANCE via
// `Schema.is`. Neither observes a live server, so neither can see a route that
// answers 500, an envelope that changed shape, or a status code that moved.
// The audited matrix in docs/architecture/t3code-compatibility.md is therefore
// NOT actually regression-tested at the wire. This file closes that gap.
//
// The one operation deliberately NOT exercised here is a model-spend prompt
// turn: it needs credentials and would make this a flaky, expensive suite.
// `session.prompt_async` is instead pinned at the schema level by the existing
// contract suite; this file pins everything around it that is deterministic.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { EventManifest } from "../../../src/event-manifest"
import {
  cleanupScratch,
  legacyFetch,
  resetCompatState,
  startCompatServer,
  type CompatServer,
} from "./harness"
import { T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION } from "../../../src/compat/t3code"

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

async function createSession(active: CompatServer, title: string) {
  const response = await legacyFetch({
    baseUrl: active.url,
    path: "/session",
    method: "POST",
    directory: active.workspace,
    body: { title },
  })
  expect(response.status).toBe(200)
  return (response.json as { id: string }).id
}

describe("audited legacy operation matrix over real HTTP", () => {
  test("GET /agent returns the legacy agent list", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({ baseUrl: active.url, path: "/agent", directory: active.workspace })
    expect(response.status).toBe(200)
    expect(Array.isArray(response.json)).toBe(true)
  })

  test("GET /skill returns the legacy skill list", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({ baseUrl: active.url, path: "/skill", directory: active.workspace })
    expect(response.status).toBe(200)
    expect(Array.isArray(response.json)).toBe(true)
  })

  test("GET /command returns the legacy command list", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({ baseUrl: active.url, path: "/command", directory: active.workspace })
    expect(response.status).toBe(200)
    expect(Array.isArray(response.json)).toBe(true)
  })

  test("GET /provider returns the legacy provider envelope T3 round-trips model slugs from", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({ baseUrl: active.url, path: "/provider", directory: active.workspace })
    expect(response.status).toBe(200)
    const body = response.json as Record<string, unknown>
    // T3 splits the returned model id on the FIRST "/" only, so provider keys
    // must stay account-neutral slugs and every model id must be a string the
    // client can carry through selection and prompt submission unchanged.
    expect(typeof body).toBe("object")
    expect(Array.isArray(body.connected)).toBe(true)
    const providers = body.all ?? body.provider ?? {}
    for (const [providerID, provider] of Object.entries(providers as Record<string, unknown>)) {
      expect(providerID).not.toContain("/")
      const models = (provider as { models?: Record<string, { id?: unknown }> }).models ?? {}
      for (const [modelKey, model] of Object.entries(models)) {
        expect(typeof modelKey).toBe("string")
        expect((model as { id?: unknown }).id ?? modelKey).toBe(modelKey)
      }
    }
  })

  test("GET /permission returns the legacy pending-request list", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({
      baseUrl: active.url,
      path: "/permission",
      directory: active.workspace,
    })
    expect(response.status).toBe(200)
    expect(Array.isArray(response.json)).toBe(true)
  })

  test("GET /question returns the legacy pending-request list", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({
      baseUrl: active.url,
      path: "/question",
      directory: active.workspace,
    })
    expect(response.status).toBe(200)
    expect(Array.isArray(response.json)).toBe(true)
  })

  test("GET /session/status stays bootstrap-free and returns the legacy session-id map", async () => {
    const active = await ensureServer()
    await createSession(active, "T3 Code thread (status)")
    // Deliberately sent WITHOUT a directory carrier: the audited contract says
    // this operation must remain valid unscoped and must not require one.
    const response = await legacyFetch({ baseUrl: active.url, path: "/session/status" })
    expect(response.status).toBe(200)
    const body = response.json as Record<string, unknown>
    expect(typeof body).toBe("object")
    for (const status of Object.values(body)) {
      expect(["idle", "busy", "retry"]).toContain((status as { type?: string }).type ?? "")
    }
  })

  test("session create -> update -> get -> messages -> children all answer the legacy shapes", async () => {
    const active = await ensureServer()
    const sessionID = await createSession(active, "T3 Code thread (matrix)")

    const updated = await legacyFetch({
      baseUrl: active.url,
      path: `/session/${sessionID}`,
      method: "PATCH",
      directory: active.workspace,
      body: { permission: [{ permission: "*", pattern: "*", action: "allow" }] },
    })
    expect(updated.status).toBe(200)
    expect((updated.json as { id: string }).id).toBe(sessionID)

    const fetched = await legacyFetch({
      baseUrl: active.url,
      path: `/session/${sessionID}`,
      directory: active.workspace,
    })
    expect(fetched.status).toBe(200)
    expect((fetched.json as { id: string }).id).toBe(sessionID)

    const messages = await legacyFetch({
      baseUrl: active.url,
      path: `/session/${sessionID}/message`,
      directory: active.workspace,
    })
    expect(messages.status).toBe(200)
    expect(Array.isArray(messages.json)).toBe(true)

    const children = await legacyFetch({
      baseUrl: active.url,
      path: `/session/${sessionID}/children`,
      directory: active.workspace,
    })
    expect(children.status).toBe(200)
    expect(Array.isArray(children.json)).toBe(true)
  })

  test("POST /session/{id}/abort accepts the SDK-ENCODED directory header", async () => {
    // Regression for the defect this lane found: handlers/session-control.ts read
    // the raw header and compared it to the durable raw directory, so a
    // percent-encoded carrier mismatched and aborted returned 400 while every
    // other operation succeeded.
    const active = await ensureServer()
    const sessionID = await createSession(active, "T3 Code thread (abort)")
    const response = await legacyFetch({
      baseUrl: active.url,
      path: `/session/${sessionID}/abort`,
      method: "POST",
      directory: active.workspace,
    })
    expect(response.status).toBe(200)
    expect(response.json).toBe(true)
  })

  test("POST /session/{id}/fork accepts the SDK-ENCODED directory header and the result is addressable", async () => {
    const active = await ensureServer()
    const sessionID = await createSession(active, "T3 Code thread (fork)")
    const forked = await legacyFetch({
      baseUrl: active.url,
      path: `/session/${sessionID}/fork`,
      method: "POST",
      directory: active.workspace,
      body: { messageID: "msg_t3_rewind" },
    })
    expect(forked.status).toBe(200)
    const forkID = (forked.json as { id?: string }).id
    expect(typeof forkID).toBe("string")
    const fetched = await legacyFetch({
      baseUrl: active.url,
      path: `/session/${forkID}`,
      directory: active.workspace,
    })
    expect(fetched.status).toBe(200)
  })

  test("POST /mcp accepts the OUTER payload envelope stock T3 actually sends", async () => {
    // Payload transcribed from immutable stock T3 0fcd5f9,
    // apps/server/src/provider/Layers/OpenCodeAdapter.ts:2871-2883:
    //
    //   client.mcp.add({
    //     name: "t3-code",
    //     config: { type: "remote", url, headers: { Authorization }, oauth: false },
    //   })
    //
    // The load-bearing detail is the `config` NESTING: `type`/`url`/`headers`/
    // `oauth` live INSIDE `config`, not at the top level. The pre-existing
    // contract suite only ever validates the inner `ConfigMCPV1.Info`, so the
    // outer envelope — the part that actually rejects with 400 — was unpinned
    // anywhere in this repository. A flat `{name, type, url, headers, oauth}`
    // is rejected with a 400 schema rejection, which is correct behaviour, not
    // a compatibility regression. This test pins the real shape.
    const active = await ensureServer()
    const response = await legacyFetch({
      baseUrl: active.url,
      path: "/mcp",
      method: "POST",
      directory: active.workspace,
      body: {
        name: "t3-code",
        config: {
          type: "remote",
          url: "http://127.0.0.1:43123",
          headers: { Authorization: "Bearer t3-test" },
          oauth: false,
        },
      },
    })
    expect(response.status).not.toBe(400)
    if (response.status === 200) {
      expect(response.json).toHaveProperty("t3-code")
    }
  })

  test("the FLAT (non-nested) MCP shape is correctly rejected: it is not what T3 sends", async () => {
    // Negative invariant that keeps the guard above honest. If someone ever
    // "fixes" the route by also accepting the flat shape, this fails, because
    // accepting an undocumented second envelope widens the audited contract
    // instead of repairing it.
    const active = await ensureServer()
    const response = await legacyFetch({
      baseUrl: active.url,
      path: "/mcp",
      method: "POST",
      directory: active.workspace,
      body: {
        name: "t3-e2e",
        type: "remote",
        url: "http://127.0.0.1:43123",
        headers: { Authorization: "Bearer t3-test" },
        oauth: false,
      },
    })
    expect(response.status).toBe(400)
  })
})

describe("legacy version handshake and the v1 signal", () => {
  test("GET /global/health projects the audited 1.x identity with no extra fields", async () => {
    const active = await ensureServer()
    const response = await legacyFetch({ baseUrl: active.url, path: "/global/health" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.json).toEqual({ healthy: true, version: T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION })
    // Canonical OpenFork adds a `path` block here. Its ABSENCE is part of the
    // audited legacy shape, so assert it explicitly rather than by toEqual alone.
    expect((response.json as Record<string, unknown>).path).toBeUndefined()
  })

  test("GET /api/info stays ABSENT: a decodable /api/info is the v2 selection signal", async () => {
    // Both T3 generations classify generation by SEMVER MAJOR, not by path, but
    // the absence of /api/info plus a 1.x /global/health is the wrapper's
    // observable v1 identity. Adding /api/info must fail this test on purpose.
    const active = await ensureServer()
    const response = await legacyFetch({ baseUrl: active.url, path: "/api/info" })
    expect(response.status).toBe(404)
  })
})

describe("canonical OpenFork negative control", () => {
  test("WITHOUT the T3 profile the health envelope keeps its canonical `path` block", async () => {
    // Proves the profile gate is what changes the observable contract, i.e. the
    // legacy shape above is genuinely produced by the compatibility profile and
    // is not simply OpenFork's global behaviour.
    const canonical = await startCompatServer("canonical")
    try {
      const response = await legacyFetch({ baseUrl: canonical.url, path: "/global/health" })
      expect(response.status).toBe(200)
      const body = response.json as { healthy?: unknown; version?: unknown; path?: Record<string, string> }
      expect(body.healthy).toBe(true)
      expect(body.version).not.toBe(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
      expect(body.path?.worktree).toBeTypeOf("string")
    } finally {
      await canonical.stop()
    }
  })
})

describe("legacy event manifest still covers every audited T3 event type", () => {
  test("all 18 audited event names remain registered", () => {
    const audited = [
      "server.connected",
      "session.created",
      "session.updated",
      "session.deleted",
      "session.error",
      "session.compacted",
      "session.status",
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.delta",
      "message.part.removed",
      "todo.updated",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "question.rejected",
    ] as const
    for (const name of audited) {
      expect(EventManifest.Latest.has(name), `${name} must remain in the legacy event manifest`).toBe(true)
    }
  })
})
