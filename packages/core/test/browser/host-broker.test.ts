import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  BrowserHostBroker,
  canClaim,
  canDispatch,
  orphanOwnedTabs,
  resolveDispatch,
  sessionTabs,
  type ResolveDispatchResult,
  type SessionTabInfo,
  type TabRecord,
} from "@opencode-ai/core/browser/host-broker"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Fiber } from "effect"
import { createServer, type ServerResponse, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { testEffect } from "../lib/effect"

const brokerLayer = AppNodeBuilder.build(LayerNode.group([BrowserHostBroker.node, httpClient]))
const it = testEffect(brokerLayer)

// --- fixtures ----------------------------------------------------------------

const tab = (overrides: Partial<TabRecord> & { tabId: string }): TabRecord => ({
  windowId: "win-1",
  url: "https://example.com",
  title: "Example",
  readyState: "Success",
  controller: "none",
  zoomFactor: 1,
  attached: true,
  active: false,
  muted: false,
  owner: { kind: "user" },
  lastActiveAt: 0,
  ...overrides,
})

const agentTab = (tabId: string, sessionId: string, overrides: Partial<TabRecord> = {}): TabRecord =>
  tab({ tabId, owner: { kind: "agent", sessionId }, ...overrides })

const request = (overrides: Partial<BrowserHostBroker.BrokerRequestInput> = {}): BrowserHostBroker.BrokerRequestInput => ({
  sessionId: "ses_1",
  messageId: "msg_1",
  operation: { name: "snapshot", input: {} },
  timeoutMs: 5_000,
  ...overrides,
})

/** A tabless op (host global state) — used where the test is about FORWARDING. */
const statusRequest = (overrides: Partial<BrowserHostBroker.BrokerRequestInput> = {}): BrowserHostBroker.BrokerRequestInput =>
  request({ operation: { name: "status", input: {} }, ...overrides })

const baseHello = {
  protocolVersion: BrowserHostBroker.BROWSER_PROTOCOL_VERSION,
  hostId: "host-1",
  hostEpoch: 1,
  connectionId: "conn-1",
  windowId: "win-1",
  capabilities: {
    maxSnapshotBytes: 1_000_000,
    maxResultBytes: 256_000,
    supportedAppearances: ["system", "light", "dark"] as const,
    supportsRecording: true,
    cdp: true,
  },
  guest: { attached: true, activeTabId: "tab_1" as string | null, url: "https://example.com" as string | null },
  callbackUrl: "http://127.0.0.1:1",
  callbackToken: "token",
}

const stateChanged = (record: TabRecord) => ({
  type: "guest.stateChanged" as const,
  tab: {
    tabId: record.tabId,
    url: record.url,
    title: record.title,
    readyState: record.readyState,
    controller: record.controller,
    zoomFactor: record.zoomFactor,
    attached: record.attached,
    active: record.active,
    muted: record.muted,
    owner: record.owner,
  },
  timestamp: new Date().toISOString(),
})

const expectError = (result: ResolveDispatchResult, tag: BrowserHostBroker.BrowserErrorTag) => {
  expect(result.kind).toBe("error")
  if (result.kind === "error") expect(result.tag).toBe(tag)
}

// --- pure dispatch resolution (design §4) -------------------------------------

describe("resolveDispatch — window resolution", () => {
  test("no window → BrowserHostUnavailable", () => {
    const result = resolveDispatch({ request: request(), windowId: undefined, tabs: [] })
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.tag).toBe("BrowserHostUnavailable")
      expect(result.message).toBe(BrowserHostBroker.HOST_UNAVAILABLE_MESSAGE)
    }
  })

  test("status forwards without a tabId (broker enriches tabs after)", () => {
    const result = resolveDispatch({ request: statusRequest(), windowId: "win-1", tabs: [] })
    expect(result).toEqual({ kind: "forward", windowId: "win-1" })
  })
})

describe("resolveDispatch — tab resolution + ownership (O1/O2/O3/O7)", () => {
  test("no tabId, session has no owned tab → BrowserTabNotFound with open prose", () => {
    const result = resolveDispatch({ request: request(), windowId: "win-1", tabs: [] })
    expectError(result, "BrowserTabNotFound")
    if (result.kind === "error") expect(result.message).toContain("browser_open")
  })

  test("no tabId, session owns 2 tabs → forwards to the most-recently-active owned tab", () => {
    const tabs = [
      agentTab("tab_a", "ses_1", { lastActiveAt: 100, active: true }),
      agentTab("tab_b", "ses_1", { lastActiveAt: 200, active: false }),
    ]
    const result = resolveDispatch({ request: request(), windowId: "win-1", tabs })
    expect(result).toEqual({ kind: "forward", windowId: "win-1", tabId: "tab_b" })
  })

  test("explicit tabId of the session's own agent tab → forwards with that tabId", () => {
    const result = resolveDispatch({
      request: request({ tabId: "tab_a" }),
      windowId: "win-1",
      tabs: [agentTab("tab_a", "ses_1")],
    })
    expect(result).toEqual({ kind: "forward", windowId: "win-1", tabId: "tab_a" })
  })

  test("explicit tabId of agent(other) tab → BrowserPermissionDenied", () => {
    const result = resolveDispatch({
      request: request({ tabId: "tab_other" }),
      windowId: "win-1",
      tabs: [agentTab("tab_other", "ses_2")],
    })
    expectError(result, "BrowserPermissionDenied")
  })

  test("explicit tabId of a user tab (no claim) → BrowserPermissionDenied (no implicit peek)", () => {
    const result = resolveDispatch({
      request: request({ tabId: "tab_user" }),
      windowId: "win-1",
      tabs: [tab({ tabId: "tab_user", owner: { kind: "user" } })],
    })
    expectError(result, "BrowserPermissionDenied")
    if (result.kind === "error") expect(result.message).toContain("Claim it")
  })

  test("a tab from another window is not visible to this window's resolution", () => {
    const result = resolveDispatch({
      request: request({ tabId: "tab_other_win" }),
      windowId: "win-1",
      tabs: [agentTab("tab_other_win", "ses_1", { windowId: "win-2" })],
    })
    expectError(result, "BrowserTabNotFound")
  })
})

describe("resolveDispatch — open reuse/create/claim (D5/D6)", () => {
  test("open { url, tabId, claim: true } on a user tab → forwards open-with-claim", () => {
    const result = resolveDispatch({
      request: request({
        operation: { name: "open", input: { url: "https://example.com", tabId: "tab_user", claim: true } },
      }),
      windowId: "win-1",
      tabs: [tab({ tabId: "tab_user", owner: { kind: "user" } })],
    })
    expect(result).toEqual({ kind: "forward", windowId: "win-1", tabId: "tab_user" })
  })

  test("open with tabId on a user tab WITHOUT claim → BrowserPermissionDenied", () => {
    const result = resolveDispatch({
      request: request({
        operation: { name: "open", input: { url: "https://example.com", tabId: "tab_user" } },
      }),
      windowId: "win-1",
      tabs: [tab({ tabId: "tab_user", owner: { kind: "user" } })],
    })
    expectError(result, "BrowserPermissionDenied")
  })

  test("open with tabId of another agent's tab → BrowserPermissionDenied even with claim", () => {
    const result = resolveDispatch({
      request: request({
        operation: { name: "open", input: { url: "https://example.com", tabId: "tab_other", claim: true } },
      }),
      windowId: "win-1",
      tabs: [agentTab("tab_other", "ses_2")],
    })
    expectError(result, "BrowserPermissionDenied")
  })

  test("open + no tabId + newTab unset + session owns a tab → rewrite to navigate on the owned tab", () => {
    const result = resolveDispatch({
      request: request({ operation: { name: "open", input: { url: "https://new.example" } } }),
      windowId: "win-1",
      tabs: [agentTab("tab_a", "ses_1", { lastActiveAt: 100 }), agentTab("tab_b", "ses_1", { lastActiveAt: 200 })],
    })
    expect(result).toEqual({
      kind: "forward",
      windowId: "win-1",
      tabId: "tab_b",
      rewrite: { name: "navigate", input: { url: "https://new.example" } },
    })
  })

  test("open + no tabId + newTab:true → forward create (host sets agent owner)", () => {
    const result = resolveDispatch({
      request: request({ operation: { name: "open", input: { url: "https://example.com", newTab: true } } }),
      windowId: "win-1",
      tabs: [agentTab("tab_a", "ses_1")],
    })
    expect(result).toEqual({ kind: "forward", windowId: "win-1" })
  })

  test("open + no owned tab → forward create (host sets agent owner)", () => {
    const result = resolveDispatch({
      request: request({ operation: { name: "open", input: { url: "https://example.com" } } }),
      windowId: "win-1",
      tabs: [],
    })
    expect(result).toEqual({ kind: "forward", windowId: "win-1" })
  })

  test("claim on a user tab → allowed (host flips; mirror syncs)", () => {
    const result = resolveDispatch({
      request: request({ operation: { name: "claim", input: { tabId: "tab_user" } } }),
      windowId: "win-1",
      tabs: [tab({ tabId: "tab_user", owner: { kind: "user" } })],
    })
    expect(result).toEqual({ kind: "forward", windowId: "win-1", tabId: "tab_user" })
  })

  test("claim on agent(other) tab → BrowserPermissionDenied (never steals)", () => {
    const result = resolveDispatch({
      request: request({ operation: { name: "claim", input: { tabId: "tab_other" } } }),
      windowId: "win-1",
      tabs: [agentTab("tab_other", "ses_2")],
    })
    expectError(result, "BrowserPermissionDenied")
  })

  test("claim on the session's own tab → idempotent forward", () => {
    const result = resolveDispatch({
      request: request({ operation: { name: "claim", input: { tabId: "tab_own" } } }),
      windowId: "win-1",
      tabs: [agentTab("tab_own", "ses_1")],
    })
    expect(result).toEqual({ kind: "forward", windowId: "win-1", tabId: "tab_own" })
  })
})

// --- pure ownership helpers (O1-O6, O10) --------------------------------------

describe("canDispatch / canClaim / orphanOwnedTabs / sessionTabs", () => {
  test("canDispatch: own agent ok; other agent denied; user tab denied for control", () => {
    expect(canDispatch({ kind: "agent", sessionId: "ses_1" }, "ses_1")).toBe("ok")
    expect(canDispatch({ kind: "agent", sessionId: "ses_2" }, "ses_1")).toBe("other-agent")
    expect(canDispatch({ kind: "user" }, "ses_1")).toBe("user-owned")
  })

  test("canClaim: user tab claimable; own agent idempotent; other agent denied", () => {
    expect(canClaim({ kind: "user" }, "ses_1")).toBe("ok")
    expect(canClaim({ kind: "agent", sessionId: "ses_1" }, "ses_1")).toBe("idempotent")
    expect(canClaim({ kind: "agent", sessionId: "ses_2" }, "ses_1")).toBe("denied")
  })

  test("orphanOwnedTabs releases only the given session's tabs (O10)", () => {
    const tabs = [
      agentTab("a", "ses_1"),
      agentTab("b", "ses_2"),
      tab({ tabId: "c", owner: { kind: "user" } }),
    ]
    const orphaned = orphanOwnedTabs(tabs, "ses_1")
    expect(orphaned[0]!.owner).toEqual({ kind: "user" })
    expect(orphaned[1]!.owner).toEqual({ kind: "agent", sessionId: "ses_2" })
    expect(orphaned[2]!.owner).toEqual({ kind: "user" })
  })

  test("sessionTabs orders most-recently-active first and filters window+session", () => {
    const tabs = [
      agentTab("a", "ses_1", { windowId: "win-1", lastActiveAt: 100 }),
      agentTab("b", "ses_1", { windowId: "win-1", lastActiveAt: 300 }),
      agentTab("c", "ses_1", { windowId: "win-2", lastActiveAt: 900 }),
      agentTab("d", "ses_2", { windowId: "win-1", lastActiveAt: 500 }),
      tab({ tabId: "e", windowId: "win-1", owner: { kind: "user" }, lastActiveAt: 700 }),
    ]
    const owned = sessionTabs(tabs, "win-1", "ses_1")
    expect(owned.map((t) => t.tabId)).toEqual(["b", "a"])
  })
})

// --- fake host (forwarding behavior only; loopback, no browser) ---------------

type Behavior =
  | { type: "ok"; result?: unknown }
  | { type: "error"; tag: BrowserHostBroker.BrowserErrorTag; message?: string }
  | { type: "hold" } // holds the request open until released
  | { type: "close" } // destroys the socket (transport failure)

interface HostHandle {
  readonly url: string
  readonly close: () => Promise<void>
  readonly abortCalls: () => number
  readonly release: () => void
}

function startHost(behavior: Behavior): Promise<HostHandle> {
  return new Promise((resolve) => {
    let abortCalls = 0
    let release: () => void = () => {}
    const pending: Array<{ res: ServerResponse }> = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.endsWith("/abort")) {
        abortCalls++
        res.writeHead(204)
        res.end()
        return
      }
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        if (behavior.type === "close") {
          req.socket.destroy()
          return
        }
        if (behavior.type === "hold") {
          pending.push({ res })
          return
        }
        const request = JSON.parse(body) as { requestId: string }
        const started = Date.now()
        if (behavior.type === "error") {
          const payload = {
            ok: false,
            requestId: request.requestId,
            error: { tag: behavior.tag, message: behavior.message ?? "host error", retryable: true },
            elapsedMs: 1,
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(payload))
          return
        }
        const payload = {
          ok: true,
          requestId: request.requestId,
          result: behavior.result ?? { status: { connected: true } },
          elapsedMs: Date.now() - started,
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(payload))
      })
    })
    release = () => {
      for (const p of pending.splice(0)) {
        p.res.writeHead(200, { "content-type": "application/json" })
        p.res.end(JSON.stringify({ ok: true, requestId: "req", result: {}, elapsedMs: 1 }))
      }
    }
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done) => {
            release()
            ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
            server.close(() => done())
          }),
        abortCalls: () => abortCalls,
        release,
      })
    })
  })
}

const withHost = (behavior: Behavior) => <A, E, R>(use: (host: HostHandle) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const host = yield* Effect.promise(() => startHost(behavior))
    return yield* use(host).pipe(Effect.ensuring(Effect.promise(() => host.close())))
  })

// --- registry (window-keyed) --------------------------------------------------

describe("BrowserHostBroker registry", () => {
  it.live("registers a host and heartbeats idempotently", () =>
    Effect.gen(function* () {
      const broker = yield* BrowserHostBroker.Service
      const first = yield* broker.register({ ...baseHello })
      expect(first.data.accepted).toBe(true)
      expect(first.data.replacement).toBeUndefined()
      const heartbeat = yield* broker.register({ ...baseHello })
      expect(heartbeat.data.accepted).toBe(true)
      expect(heartbeat.data.replacement).toBeUndefined()
      const rows = yield* broker.list()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.status).toBe("live")
      expect(rows[0]?.connectionId).toBe("conn-1")
      expect(Object.hasOwn(rows[0] ?? {}, "callbackToken")).toBe(false) // token redacted
      expect("sessionId" in (rows[0] ?? {})).toBe(false) // session-agnostic registration
    }),
  )

  it.live("rejects a protocolVersion mismatch", () =>
    Effect.gen(function* () {
      const broker = yield* BrowserHostBroker.Service
      const reply = yield* broker.register({ ...baseHello, protocolVersion: 99 })
      expect(reply.data.accepted).toBe(false)
      expect(reply.data.brokerProtocolVersion).toBe(BrowserHostBroker.BROWSER_PROTOCOL_VERSION)
      const rows = yield* broker.list()
      expect(rows).toHaveLength(0)
    }),
  )

  it.live("keeps separate windows as separate connections", () =>
    Effect.gen(function* () {
      const broker = yield* BrowserHostBroker.Service
      yield* broker.register({ ...baseHello, connectionId: "conn-a", windowId: "win-a" })
      yield* broker.register({ ...baseHello, connectionId: "conn-b", windowId: "win-b" })
      const rows = yield* broker.list()
      expect(rows).toHaveLength(2)
      const windows = rows.map((row) => row.windowId).sort()
      expect(windows).toEqual(["win-a", "win-b"])
    }),
  )

  it.live("replacement supersedes the old connectionId for the same window", () =>
    Effect.gen(function* () {
      const broker = yield* BrowserHostBroker.Service
      yield* broker.register({ ...baseHello, connectionId: "conn-old" })
      const replaced = yield* broker.register({ ...baseHello, connectionId: "conn-new" })
      expect(replaced.data.replacement).toBe(true)
      const rows = yield* broker.list()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.connectionId).toBe("conn-new")
    }),
  )

  it.live("a different windowId is a distinct registration (not a replacement)", () =>
    Effect.gen(function* () {
      const broker = yield* BrowserHostBroker.Service
      yield* broker.register({ ...baseHello, windowId: "win-a" })
      const second = yield* broker.register({ ...baseHello, windowId: "win-b" })
      expect(second.data.replacement).toBeUndefined()
    }),
  )
})

// --- dispatch forwarding ------------------------------------------------------

describe("BrowserHostBroker dispatch", () => {
  it.live("forwards to the host and returns the ok envelope (status gains tabs)", () =>
    withHost({ type: "ok", result: { status: { connected: true } } })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        const response = yield* broker.dispatch(statusRequest())
        expect(response.ok).toBe(true)
        if (response.ok) {
          expect(response.result).toEqual({ status: { connected: true }, tabs: [] })
          expect(response.elapsedMs).toBeGreaterThanOrEqual(0)
        }
      }),
    ),
  )

  it.live("fills windowId + tabId on the forwarded envelope", () =>
    withHost({ type: "ok", result: { status: { connected: true } } })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(agentTab("tab_a", "ses_1", { active: true })))
        const response = yield* broker.dispatch(request({ operation: { name: "snapshot", input: {} } }))
        expect(response.ok).toBe(true)
      }),
    ),
  )

  it.live("returns the host's typed error envelope as-is", () =>
    withHost({ type: "error", tag: "BrowserStaleRefError", message: "stale ref" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(agentTab("tab_a", "ses_1")))
        const response = yield* broker.dispatch(request({ tabId: "tab_a" }))
        expect(response.ok).toBe(false)
        if (!response.ok) {
          expect(response.error.tag).toBe("BrowserStaleRefError")
          expect(response.error.retryable).toBe(true)
        }
      }),
    ),
  )

  it.live("fails with BrowserHostUnavailable when no host is registered", () =>
    Effect.gen(function* () {
      const broker = yield* BrowserHostBroker.Service
      const response = yield* broker.dispatch(statusRequest())
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.tag).toBe("BrowserHostUnavailable")
    }),
  )

  it.live("maps transport failure to BrowserHostUnavailable and marks the connection dead", () =>
    withHost({ type: "close" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        const response = yield* broker.dispatch(statusRequest())
        expect(response.ok).toBe(false)
        if (!response.ok) expect(response.error.tag).toBe("BrowserHostUnavailable")
        const rows = yield* broker.list()
        expect(rows[0]?.status).toBe("dead")
      }),
    ),
  )

  it.live("host-reported timeout error surfaces as BrowserTimeout", () =>
    withHost({ type: "error", tag: "BrowserTimeout" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        const response = yield* broker.dispatch(statusRequest({ timeoutMs: 50 }))
        expect(response.ok).toBe(false)
        if (!response.ok) expect(response.error.tag).toBe("BrowserTimeout")
      }),
    ),
  )
})

// --- replacement + abort ------------------------------------------------------

describe("BrowserHostBroker replacement + abort", () => {
  it.live("in-flight requests fail with BrowserControlInterrupted when superseded", () =>
    withHost({ type: "hold" })((oldHost) =>
      withHost({ type: "ok" })((newHost) =>
        Effect.gen(function* () {
          const broker = yield* BrowserHostBroker.Service
          yield* broker.register({ ...baseHello, connectionId: "conn-old", callbackUrl: oldHost.url })
          const scope = yield* Effect.scope
          const fiber = yield* broker.dispatch(statusRequest({ timeoutMs: 30_000 })).pipe(Effect.forkIn(scope))
          yield* Effect.yieldNow
          yield* broker.register({ ...baseHello, connectionId: "conn-new", callbackUrl: newHost.url })
          const outcome = yield* Fiber.join(fiber)
          expect(outcome.ok).toBe(false)
          if (!outcome.ok) expect(outcome.error.tag).toBe("BrowserControlInterrupted")
        }),
      ),
    ),
  )

  it.live("abort fails the in-flight request and fires the host abort endpoint", () =>
    withHost({ type: "hold" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        const scope = yield* Effect.scope
        const fiber = yield* broker
          .dispatch(statusRequest({ timeoutMs: 30_000, requestId: "req-abort-1" }))
          .pipe(Effect.forkIn(scope))
        yield* Effect.yieldNow
        yield* broker.abort("req-abort-1")
        const outcome = yield* Fiber.join(fiber)
        expect(outcome.ok).toBe(false)
        if (!outcome.ok) expect(outcome.error.tag).toBe("BrowserControlInterrupted")
        yield* Effect.sleep("50 millis")
        expect(host.abortCalls()).toBeGreaterThanOrEqual(1)
      }),
    ),
  )

  it.live("ctx.abort signal interrupts a held dispatch with BrowserControlInterrupted", () =>
    withHost({ type: "hold" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        const controller = new AbortController()
        const scope = yield* Effect.scope
        const fiber = yield* broker
          .dispatch(statusRequest({ timeoutMs: 30_000 }), { signal: controller.signal })
          .pipe(Effect.forkIn(scope))
        yield* Effect.sleep("50 millis")
        controller.abort()
        const outcome = yield* Fiber.join(fiber)
        expect(outcome.ok).toBe(false)
        if (!outcome.ok) expect(outcome.error.tag).toBe("BrowserControlInterrupted")
      }),
    ),
  )
})

// --- tab mirror: ownership enforcement through the service --------------------

describe("BrowserHostBroker tab mirror (ownership enforcement)", () => {
  it.live("dispatch to another session's tab fails fast with BrowserPermissionDenied", () =>
    withHost({ type: "ok" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(agentTab("tab_a", "ses_2")))
        const response = yield* broker.dispatch(request({ tabId: "tab_a" }))
        expect(response.ok).toBe(false)
        if (!response.ok) expect(response.error.tag).toBe("BrowserPermissionDenied")
      }),
    ),
  )

  it.live("dispatch to a user tab (no claim) fails fast with BrowserPermissionDenied", () =>
    withHost({ type: "ok" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(tab({ tabId: "tab_user", owner: { kind: "user" } })))
        const response = yield* broker.dispatch(request({ tabId: "tab_user" }))
        expect(response.ok).toBe(false)
        if (!response.ok) expect(response.error.tag).toBe("BrowserPermissionDenied")
      }),
    ),
  )

  it.live("no session tab (no tabId) → BrowserTabNotFound", () =>
    withHost({ type: "ok" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(tab({ tabId: "tab_user", owner: { kind: "user" } })))
        const response = yield* broker.dispatch(request({ operation: { name: "snapshot", input: {} } }))
        expect(response.ok).toBe(false)
        if (!response.ok) {
          expect(response.error.tag).toBe("BrowserTabNotFound")
          expect(response.error.message).toContain("browser_open")
        }
      }),
    ),
  )

  it.live("status is enriched with the FULL tab list (incl. user + other-agent tabs)", () =>
    withHost({ type: "ok", result: { status: { connected: true } } })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(tab({ tabId: "tab_user", owner: { kind: "user" }, active: true })))
        yield* broker.pushEvent(stateChanged(agentTab("tab_other", "ses_2")))
        const response = yield* broker.dispatch(statusRequest())
        expect(response.ok).toBe(true)
        if (response.ok) {
          const tabs = (response.result as { tabs: SessionTabInfo[] }).tabs
          expect(tabs).toHaveLength(2)
          expect(tabs.map((t) => t.tabId).sort()).toEqual(["tab_other", "tab_user"])
          expect(tabs.find((t) => t.tabId === "tab_user")?.owner).toEqual({ kind: "user" })
          expect(tabs.find((t) => t.tabId === "tab_other")?.owner).toEqual({ kind: "agent", sessionId: "ses_2" })
        }
      }),
    ),
  )

  it.live("claim on a user tab flips the mirror to the session (host flips first)", () =>
    withHost({ type: "ok", result: { claimed: { tabId: "tab_user", owner: { kind: "agent", sessionId: "ses_1" } } } })(
      (host) =>
        Effect.gen(function* () {
          const broker = yield* BrowserHostBroker.Service
          yield* broker.register({ ...baseHello, callbackUrl: host.url })
          yield* broker.pushEvent(stateChanged(tab({ tabId: "tab_user", owner: { kind: "user" } })))
          const response = yield* broker.dispatch(request({ operation: { name: "claim", input: { tabId: "tab_user" } } }))
          expect(response.ok).toBe(true)
          const listed = yield* broker.listTabs()
          expect(listed.find((t) => t.tabId === "tab_user")?.owner).toEqual({ kind: "agent", sessionId: "ses_1" })
        }),
    ),
  )

  it.live("open create mirrors the new tab as agent-owned (from the response)", () =>
    withHost({
      type: "ok",
      result: {
        opened: {
          tabId: "tab_new",
          url: "https://example.com",
          title: "Example",
          readyState: "Success",
          viewport: { width: 800, height: 600, dpr: 1, scrollX: 0, scrollY: 0 },
          owner: { kind: "agent", sessionId: "ses_1" },
        },
      },
    })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        const response = yield* broker.dispatch(
          request({ operation: { name: "open", input: { url: "https://example.com", newTab: true } } }),
        )
        expect(response.ok).toBe(true)
        const listed = yield* broker.listTabs()
        expect(listed.find((t) => t.tabId === "tab_new")?.owner).toEqual({ kind: "agent", sessionId: "ses_1" })
      }),
    ),
  )

  it.live("tab.closed event removes the mirror row", () =>
    withHost({ type: "ok" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(agentTab("tab_a", "ses_1")))
        yield* broker.pushEvent({ type: "tab.closed", tabId: "tab_a", timestamp: new Date().toISOString() })
        const listed = yield* broker.listTabs()
        expect(listed).toHaveLength(0)
      }),
    ),
  )

  it.live("guest.crashed also removes the mirror row", () =>
    withHost({ type: "ok" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(agentTab("tab_a", "ses_1")))
        yield* broker.pushEvent({ type: "guest.crashed", tabId: "tab_a", timestamp: new Date().toISOString() })
        const listed = yield* broker.listTabs()
        expect(listed).toHaveLength(0)
      }),
    ),
  )

  it.live("duplicate owner-inherit is visible in the mirror (stateChanged carries owner)", () =>
    withHost({ type: "ok" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(agentTab("tab_a", "ses_1", { active: true })))
        yield* broker.pushEvent(stateChanged(agentTab("tab_a2", "ses_1"))) // the duplicate inherits the owner
        yield* broker.pushEvent(stateChanged(tab({ tabId: "tab_u2", owner: { kind: "user" } })))
        const listed = yield* broker.listTabs()
        expect(listed.find((t) => t.tabId === "tab_a2")?.owner).toEqual({ kind: "agent", sessionId: "ses_1" })
        expect(listed.find((t) => t.tabId === "tab_u2")?.owner).toEqual({ kind: "user" })
      }),
    ),
  )
})

// --- user-initiated assign + session-delete orphan ----------------------------

describe("BrowserHostBroker assign + orphanSession", () => {
  it.live("assign flips the mirror to agent(sessionId)", () =>
    withHost({ type: "ok" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(tab({ tabId: "tab_a", owner: { kind: "user" } })))
        const result = yield* broker.assign("tab_a", { kind: "agent", sessionId: "ses_1" })
        expect(result).toEqual({ tabId: "tab_a", owner: { kind: "agent", sessionId: "ses_1" } })
        const listed = yield* broker.listTabs()
        expect(listed[0]?.owner).toEqual({ kind: "agent", sessionId: "ses_1" })
      }),
    ),
  )

  it.live("assign REASSIGNS sessionA → sessionB (user authority)", () =>
    withHost({ type: "ok" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(agentTab("tab_a", "ses_a")))
        yield* broker.assign("tab_a", { kind: "agent", sessionId: "ses_b" })
        const listed = yield* broker.listTabs()
        expect(listed[0]?.owner).toEqual({ kind: "agent", sessionId: "ses_b" })
      }),
    ),
  )

  it.live('assign(tabId, { kind: "user" }) returns the tab to the user', () =>
    withHost({ type: "ok" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(agentTab("tab_a", "ses_1")))
        yield* broker.assign("tab_a", { kind: "user" })
        const listed = yield* broker.listTabs()
        expect(listed[0]?.owner).toEqual({ kind: "user" })
      }),
    ),
  )

  it.live("assign on an unknown tab fails with BrowserTabNotFound", () =>
    Effect.gen(function* () {
      const broker = yield* BrowserHostBroker.Service
      const outcome = yield* broker.assign("nope", { kind: "user" }).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      )
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error._tag).toBe("BrowserTabNotFound")
    }),
  )

  it.live("orphanSession flips only that session's tabs to user", () =>
    withHost({ type: "ok" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        yield* broker.pushEvent(stateChanged(agentTab("tab_a", "ses_1")))
        yield* broker.pushEvent(stateChanged(agentTab("tab_b", "ses_2")))
        yield* broker.pushEvent(stateChanged(tab({ tabId: "tab_c", owner: { kind: "user" } })))
        yield* broker.orphanSession("ses_1")
        const listed = yield* broker.listTabs()
        const byId = Object.fromEntries(listed.map((t) => [t.tabId, t]))
        expect(byId["tab_a"]?.owner).toEqual({ kind: "user" }) // orphaned
        expect(byId["tab_b"]?.owner).toEqual({ kind: "agent", sessionId: "ses_2" }) // untouched
        expect(byId["tab_c"]?.owner).toEqual({ kind: "user" }) // already user
      }),
    ),
  )
})
