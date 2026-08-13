import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BrowserHostBroker } from "@opencode-ai/core/browser/host-broker"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Fiber } from "effect"
import { createServer, type ServerResponse, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { testEffect } from "../lib/effect"

const brokerLayer = AppNodeBuilder.build(LayerNode.group([BrowserHostBroker.node, httpClient]))
const it = testEffect(brokerLayer)

// --- fake host ---------------------------------------------------------------

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

// --- fixtures ----------------------------------------------------------------

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
  sessionId: "ses_1",
  workspaceId: "wrk_1",
  callbackUrl: "http://127.0.0.1:1",
  callbackToken: "token",
}

const request = (overrides: Partial<BrowserHostBroker.BrokerRequestInput> = {}): BrowserHostBroker.BrokerRequestInput => ({
  sessionId: "ses_1",
  workspaceId: "wrk_1",
  messageId: "msg_1",
  operation: { name: "status", input: {} },
  timeoutMs: 5_000,
  ...overrides,
})

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

  it.live("keeps separate windows as separate sticky connections", () =>
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

  it.live("replacement supersedes the old connectionId", () =>
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

  it.live("stickiness key is session@workspace#window with sha1 directory fallback", () =>
    Effect.gen(function* () {
      const key = BrowserHostBroker.stickinessKey({ sessionId: "ses_1", workspaceId: "wrk_1", windowId: "win-1" })
      expect(key).toBe("ses_1@wrk_1#win-1")
      const withDir = BrowserHostBroker.stickinessKey({ sessionId: "ses_1", directory: "/tmp/proj", windowId: "win-1" })
      expect(withDir).not.toBe("ses_1@/tmp/proj#win-1")
      expect(withDir).toMatch(/^ses_1@[0-9a-f]{40}#win-1$/)
    }),
  )
})

describe("BrowserHostBroker dispatch", () => {
  it.live("forwards to the host and returns the ok envelope", () =>
    withHost({ type: "ok", result: { status: { connected: true } } })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        const response = yield* broker.dispatch(request())
        expect(response.ok).toBe(true)
        if (response.ok) {
          expect(response.result).toEqual({ status: { connected: true } })
          expect(response.elapsedMs).toBeGreaterThanOrEqual(0)
        }
      }),
    ),
  )

  it.live("returns the host's typed error envelope as-is", () =>
    withHost({ type: "error", tag: "BrowserStaleRefError", message: "stale ref" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        const response = yield* broker.dispatch(request())
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
      const response = yield* broker.dispatch(request())
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.tag).toBe("BrowserHostUnavailable")
    }),
  )

  it.live("maps transport failure to BrowserHostUnavailable and marks the connection dead", () =>
    withHost({ type: "close" })((host) =>
      Effect.gen(function* () {
        const broker = yield* BrowserHostBroker.Service
        yield* broker.register({ ...baseHello, callbackUrl: host.url })
        const response = yield* broker.dispatch(request())
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
        const response = yield* broker.dispatch(request({ timeoutMs: 50 }))
        expect(response.ok).toBe(false)
        if (!response.ok) expect(response.error.tag).toBe("BrowserTimeout")
      }),
    ),
  )
})

describe("BrowserHostBroker replacement + abort", () => {
  it.live("in-flight requests fail with BrowserControlInterrupted when superseded", () =>
    withHost({ type: "hold" })((oldHost) =>
      withHost({ type: "ok" })((newHost) =>
        Effect.gen(function* () {
          const broker = yield* BrowserHostBroker.Service
          yield* broker.register({ ...baseHello, connectionId: "conn-old", callbackUrl: oldHost.url })
          // Fork a dispatch against the old connection, then supersede it.
          const scope = yield* Effect.scope
          const fiber = yield* broker.dispatch(request({ timeoutMs: 30_000 })).pipe(Effect.forkIn(scope))
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
          .dispatch(request({ timeoutMs: 30_000, requestId: "req-abort-1" }))
          .pipe(Effect.forkIn(scope))
        yield* Effect.yieldNow
        yield* broker.abort("req-abort-1")
        const outcome = yield* Fiber.join(fiber)
        expect(outcome.ok).toBe(false)
        if (!outcome.ok) expect(outcome.error.tag).toBe("BrowserControlInterrupted")
        // The host abort endpoint is best-effort; give the HTTP call a tick.
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
          .dispatch(request({ timeoutMs: 30_000 }), { signal: controller.signal })
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

describe("BrowserHostBroker stickiness resolution", () => {
  it.live("routes to the most recent window; tabId prefers the matching guest", () =>
    withHost({ type: "ok", result: { tabId: "tab_a" } })((winA) =>
      withHost({ type: "ok", result: { tabId: "tab_b" } })((winB) =>
        Effect.gen(function* () {
          const broker = yield* BrowserHostBroker.Service
          yield* broker.register({
            ...baseHello,
            connectionId: "conn-a",
            windowId: "win-a",
            guest: { attached: true, activeTabId: "tab_a", url: "https://a.example" },
            callbackUrl: winA.url,
          })
          yield* Effect.sleep("10 millis")
          yield* broker.register({
            ...baseHello,
            connectionId: "conn-b",
            windowId: "win-b",
            guest: { attached: true, activeTabId: "tab_b", url: "https://b.example" },
            callbackUrl: winB.url,
          })
          // No tabId → most recent (win-b).
          const recent = yield* broker.dispatch(request())
          // tabId matching win-a → routes to win-a.
          const tabPinned = yield* broker.dispatch(request({ tabId: "tab_a" }))
          if (recent.ok) expect(recent.result).toEqual({ tabId: "tab_b" })
          if (tabPinned.ok) expect(tabPinned.result).toEqual({ tabId: "tab_a" })
        }),
      ),
    ),
  )

  it.live("returns BrowserHostUnavailable when the session workspace has no host", () =>
    Effect.gen(function* () {
      const broker = yield* BrowserHostBroker.Service
      yield* broker.register({ ...baseHello, sessionId: "ses_1" })
      const response = yield* broker.dispatch(request({ sessionId: "ses_other" }))
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.tag).toBe("BrowserHostUnavailable")
    }),
  )
})
