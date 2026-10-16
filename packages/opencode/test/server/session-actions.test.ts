import { afterEach, describe, expect, mock } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(SessionNs.node), httpApiLayer))

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session action routes", () => {
  it.instance(
    "session routes expose metadata on create, update, get, and fork",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "Content-Type": "application/json" }

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "meta-session",
            metadata: { source: "sdk", trace: { id: "abc" } },
          }),
        })
        expect(created.status).toBe(200)

        const session = (yield* created.json) as SessionNs.Info
        expect(session.metadata).toEqual({ source: "sdk", trace: { id: "abc" } })

        const updated = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: { source: "sdk", trace: { id: "def" }, tags: ["one"] } }),
        })
        expect(updated.status).toBe(200)

        const next = (yield* updated.json) as SessionNs.Info
        expect(next.metadata).toEqual({ source: "sdk", trace: { id: "def" }, tags: ["one"] })

        const fetched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(fetched.status).toBe(200)
        expect(((yield* fetched.json) as SessionNs.Info).metadata).toEqual(next.metadata)

        const forked = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(200)

        const fork = (yield* forked.json) as SessionNs.Info
        expect(fork.metadata).toEqual(next.metadata)

        const reset = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: {} }),
        })
        expect(reset.status).toBe(200)
        expect(((yield* reset.json) as SessionNs.Info).metadata).toEqual({})

        yield* SessionNs.Service.use((svc) => svc.remove(fork.id).pipe(Effect.ignore))
        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "abort route returns success",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/session/${session.id}/abort`, test.directory, { method: "POST" })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "abort route accepts the SDK-encoded directory header",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* request(`/session/${session.id}/abort`, {
          method: "POST",
          headers: { "x-opencode-directory": encodeURIComponent(test.directory) },
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "abort route rejects a stale encoded directory hint",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* request(`/session/${session.id}/abort`, {
          method: "POST",
          headers: { "x-opencode-directory": encodeURIComponent(`${test.directory}-stale`) },
        })

        expect(res.status).toBe(400)
      }),
    { git: true },
  )

  it.instance(
    "abort route handles malformed encoded directory hints without throwing",
    () =>
      Effect.gen(function* () {
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* request(`/session/${session.id}/abort`, {
          method: "POST",
          headers: { "x-opencode-directory": "%E0%A4%A" },
        })

        expect(res.status).toBe(400)
      }),
    { git: true },
  )

  it.instance(
    "experimental background route is a no-op without synchronous subagents",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/experimental/session/${session.id}/background`, test.directory, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(false)
      }),
    { git: true },
  )

  // A directory name may legitimately contain a valid percent escape such as
  // "%20". That makes the raw and URI-encoded spellings of the same path
  // ambiguous, which is why the abort fence compares the header as two candidate
  // spellings instead of one canonical string. These pin both spellings against
  // a real directory rather than a synthetic string.
  it.instance(
    "abort route accepts a percent-escape directory name addressed with the SDK-encoded header",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const scoped = path.join(test.directory, "pct%20dir")
        yield* Effect.promise(() => mkdir(scoped, { recursive: true }))

        const created = yield* request("/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-directory": encodeURIComponent(scoped),
          },
          body: JSON.stringify({}),
        })
        expect(created.status).toBe(200)
        const session = (yield* created.json) as SessionNs.Info

        // Create is the one route where the header is authoritative for routing:
        // workspace-routing.ts:197 falls back to explicitDirectory() only when
        // there is no session id yet. It decodes once, so "%2520" persists as the
        // literal "%20" path. Every later route here is session-addressed, so
        // workspace-routing.ts:197 prefers session.directory over the header and
        // the header is only ever a staleness hint.
        expect(session.directory).toBe(scoped)

        const fetched = yield* request(`/session/${session.id}`, {
          headers: { "x-opencode-directory": encodeURIComponent(scoped) },
        })
        expect(fetched.status).toBe(200)
        expect(((yield* fetched.json) as SessionNs.Info).directory).toBe(scoped)

        const messages = yield* request(`/session/${session.id}/message`, {
          headers: { "x-opencode-directory": encodeURIComponent(scoped) },
        })
        expect(messages.status).toBe(200)
        expect(Array.isArray(yield* messages.json)).toBe(true)

        const forked = yield* request(`/session/${session.id}/fork`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-directory": encodeURIComponent(scoped),
          },
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(200)
        const fork = (yield* forked.json) as SessionNs.Info
        expect(fork.directory).toBe(scoped)

        const res = yield* request(`/session/${session.id}/abort`, {
          method: "POST",
          headers: { "x-opencode-directory": encodeURIComponent(scoped) },
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)

        yield* SessionNs.Service.use((svc) => svc.remove(fork.id).pipe(Effect.ignore))
        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "abort route accepts a percent-escape directory name sent as a raw header",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const scoped = path.join(test.directory, "pct%20dir")
        yield* Effect.promise(() => mkdir(scoped, { recursive: true }))

// Create uses the SDK-encoded header, so the middleware decodes "%2520"
        // exactly once and persists the literal "%20" path as session.directory.
        // The abort then sends that same path RAW. Routing prefers the existing
        // session's durable directory, so only the hint fence ever sees the
        // header: its raw candidate must match the literal path. Under a single
        // unconditional decode the raw hint becomes "pct dir" and falsely 400s.
        const created = yield* request("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(scoped) },
          body: JSON.stringify({}),
        })
        expect(created.status).toBe(200)
        const session = (yield* created.json) as SessionNs.Info

        const res = yield* request(`/session/${session.id}/abort`, {
          method: "POST",
          headers: { "x-opencode-directory": scoped },
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "abort route still rejects a stale raw directory header",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* request(`/session/${session.id}/abort`, {
          method: "POST",
          headers: { "x-opencode-directory": `${test.directory}-stale` },
        })

        expect(res.status).toBe(400)
      }),
    { git: true },
  )

  // The behavior side of the declaration-side contract that
  // t3code-compat-contract.test.ts asserts for `permission` and `parentID`.
  it.instance(
    "session get returns a permission ruleset the client set, and omits parentID for a root session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ruleset = [{ permission: "codesearch", pattern: "*", action: "ask" as const }]

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permission: ruleset }),
        })
        expect(created.status).toBe(200)
        const session = (yield* created.json) as SessionNs.Info

        // Stock reads `nativeChildSession.permission ?? []` back OFF the response. A
        // ruleset that was accepted on the way in but dropped on the way out would
        // leave stock re-deriving an empty ruleset from a route that still answered
        // 200, so this asserts the persisted value, not merely the status code.
        const fetched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(fetched.status).toBe(200)
        const info = (yield* fetched.json) as SessionNs.Info
        expect(info.permission).toEqual(ruleset)

        // `parentID` appears nowhere on the HTTP session surface -- not on create and
        // not on fork -- so a session created over HTTP is genuinely a root and the
        // encoder omits the key. That is why stock's `info?.parentID` reads undefined
        // for the right reason, rather than a parented session losing its link.
        expect(Object.hasOwn(info, "parentID")).toBe(false)

        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )
})
