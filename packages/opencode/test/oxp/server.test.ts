import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { request } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { connect as connectSocket } from "node:net"
import { EventEmitter } from "node:events"
import { Effect, Layer } from "effect"
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpAgentCatalog } from "@/oxp/agent-catalog"
import { OxpRoot } from "@/oxp/root"
import { OxpRequestControl } from "@/oxp/request-control"
import {
  OxpServer,
  bridgeRequestCancellation,
  durableContinuationObserved,
  paginateToolList,
} from "@/oxp/server"
import { OxpError } from "@/oxp/error"
import { OxpSessionControl } from "@/oxp/session-control"
import { OxpSurface } from "@/oxp/surface"
import { OxpWorkerControl } from "@/oxp/worker-control"
import { OxpMcpControl } from "@/oxp/mcp-control"
import { OxpSystemOneControl } from "@/oxp/system-one-control"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-server-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const noSessionControl = Layer.succeed(
  OxpSessionControl.Service,
  OxpSessionControl.Service.of({
    pause: () => Effect.die("server test must not enter Session runtime control"),
    resume: () => Effect.die("server test must not enter Session runtime control"),
    abort: () => Effect.die("server test must not enter Session runtime control"),
    setSelection: () => Effect.die("server test must not enter Session runtime control"),
    send: () => Effect.die("server test must not enter Session runtime control"),
    turn: () => Effect.die("server test must not enter Session runtime control"),
    backgroundSubagents: () => Effect.die("server test must not enter Session runtime control"),
    todoGet: () => Effect.die("server test must not enter Session runtime control"),
    todoSet: () => Effect.die("server test must not enter Session runtime control"),
    checkpoint: () => Effect.die("server test must not enter Session runtime control"),
    goal: () => Effect.die("server test must not enter Session runtime control"),
  }),
)
const noRequestControl = Layer.succeed(
  OxpRequestControl.Service,
  OxpRequestControl.Service.of({
    list: () => Effect.die("server test must not enter request runtime control"),
    replyPermission: () => Effect.die("server test must not enter request runtime control"),
    answerQuestion: () => Effect.die("server test must not enter request runtime control"),
    rejectQuestion: () => Effect.die("server test must not enter request runtime control"),
  }),
)
const noWorkerControl = Layer.succeed(
  OxpWorkerControl.Service,
  OxpWorkerControl.Service.of({
    resolveSelection: () => Effect.die("server test must not enter worker runtime control"),
    start: () => Effect.die("server test must not enter worker runtime control"),
    continue: () => Effect.die("server test must not enter worker runtime control"),
    wait: () => Effect.die("server test must not enter worker runtime control"),
    result: () => Effect.die("server test must not enter worker runtime control"),
    cancel: () => Effect.die("server test must not enter worker runtime control"),
    batchStart: () => Effect.die("server test must not enter worker runtime control"),
    batchContinue: () => Effect.die("server test must not enter worker runtime control"),
    batchWait: () => Effect.die("server test must not enter worker runtime control"),
    batchCancel: () => Effect.die("server test must not enter worker runtime control"),
  }),
)
const noMcpControl = Layer.succeed(
  OxpMcpControl.Service,
  OxpMcpControl.Service.of({
    list: () => Effect.die("server test must not enter native MCP runtime"),
    call: () => Effect.die("server test must not enter native MCP runtime"),
  }),
)
const noAgentCatalog = Layer.succeed(
  OxpAgentCatalog.Service,
  OxpAgentCatalog.Service.of({
    list: () => Effect.die("server test must not enter workspace agent catalog"),
  }),
)
const noSystemOneControl = Layer.succeed(
  OxpSystemOneControl.Service,
  OxpSystemOneControl.Service.of({
    infer: () => Effect.die("server test must not enter System One runtime control"),
  }),
)
const layer = AppNodeBuilder.build(
  LayerNode.group([
    CrossSpawnSpawner.node,
    OxpServer.node,
    OxpRoot.node,
    OxpConfig.node,
    OxpActivityInspection.node,
  ]),
  [
    [Global.node, Global.layerWith({ config: configDir, state: stateDir })],
    [OxpSessionControl.node, noSessionControl],
    [OxpRequestControl.node, noRequestControl],
    [OxpWorkerControl.node, noWorkerControl],
    [OxpMcpControl.node, noMcpControl],
    [OxpAgentCatalog.node, noAgentCatalog],
    [OxpSystemOneControl.node, noSystemOneControl],
  ],
)
const it = testEffect(layer)

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

function raw(input: {
  port: number
  path: string
  host?: string
  origin?: string
  method?: string
  contentLength?: number
  body?: string
  headers?: Record<string, string>
}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: input.method ?? "GET",
        headers: {
          host: input.host ?? `127.0.0.1:${input.port}`,
          ...(input.origin ? { origin: input.origin } : {}),
          ...(input.contentLength === undefined ? {} : { "content-length": String(input.contentLength) }),
           ...input.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
      },
    )
    req.once("error", reject)
    req.end(input.body)
  })
}

function rawOversizedDeclaration(port: number, requestPath: string) {
  return new Promise<number>((resolve, reject) => {
    const socket = connectSocket({ host: "127.0.0.1", port })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("timed out waiting for oversized-body rejection"))
    }, 2_000)
    timer.unref?.()
    socket.once("connect", () => {
      socket.write(
        [
          `POST ${requestPath} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Content-Type: application/json",
          `Content-Length: ${8 * 1024 * 1024 + 1}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      )
    })
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once("end", () => {
      clearTimeout(timer)
      const head = Buffer.concat(chunks).toString("utf8").split("\r\n", 1)[0] ?? ""
      const status = Number(/^HTTP\/1\.1\s+(\d{3})/.exec(head)?.[1] ?? 0)
      resolve(status)
    })
  })
}

describe("OxpServer", () => {
  test("treats a committed worker mutation as durable continuation even when the caller receives an error", () => {
    const input = { action: "start", rootID: "root", prompt: "continue durably" }
    expect(durableContinuationObserved("openfork_worker", input)).toBe(true)
    expect(
      durableContinuationObserved(
        "openfork_worker",
        input,
        new OxpError.Cancelled({
          detail: "worker committed before cancellation",
          metadata: { committed: true, workerID: "ses_worker" },
        }),
      ),
    ).toBe(true)
    expect(
      durableContinuationObserved(
        "openfork_worker",
        input,
        new OxpError.AuthDenied({ detail: "denied before commit" }),
      ),
    ).toBe(false)
    expect(durableContinuationObserved("read", input)).toBe(false)
  })

  test("bridges Node client disconnects into the MCP request cancellation signal", () => {
    const req = new EventEmitter() as IncomingMessage
    const res = Object.assign(new EventEmitter(), { writableFinished: false }) as ServerResponse
    const bridge = bridgeRequestCancellation(req, res)
    expect(bridge.signal.aborted).toBe(false)
    res.emit("close")
    expect(bridge.signal.aborted).toBe(true)
    bridge.dispose()

    const completedReq = new EventEmitter() as IncomingMessage
    const completedRes = Object.assign(new EventEmitter(), { writableFinished: true }) as ServerResponse
    const completed = bridgeRequestCancellation(completedReq, completedRes)
    completedRes.emit("close")
    expect(completed.signal.aborted).toBe(false)
    completedReq.emit("aborted")
    expect(completed.signal.aborted).toBe(true)
    completed.dispose()
  })

  test("paginates the fixed manifest by bytes and rejects stale cursors", () => {
    const synthetic = Array.from({ length: 40 }, (_, index) => ({
      ...OxpSurface.TOOLS[0]!,
      name: `tool_${index}`,
      description: `tool-${index}-${"x".repeat(80)}`,
    }))
    const names: string[] = []
    let cursor: string | undefined
    do {
      const page = paginateToolList(synthetic, cursor, 600)
      names.push(...page.tools.map((tool) => tool.name))
      cursor = page.nextCursor
    } while (cursor)
    expect(names).toEqual([...synthetic].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => tool.name))

    const first = paginateToolList(synthetic, undefined, 600)
    expect(first.nextCursor).toBeDefined()
    expect(() =>
      paginateToolList([...synthetic, { ...synthetic[0]!, name: "new_tool" }], first.nextCursor, 600),
    ).toThrow(/stale tools\/list cursor/i)
  })

  it.live(
    "serves Gate B tools over a secret loopback MCP endpoint with a stable fingerprint",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const server = yield* OxpServer.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "hello.txt"), "hello oxp\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const endpoint = yield* server.start()
      const client = new ModernClient(
        { name: "oxp-gate-c-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )

      try {
        expect(endpoint.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${endpoint.port}/mcp/[A-Za-z0-9_-]{43}$`))
        expect(endpoint.surfaceFingerprint).toBe(OxpSurface.FINGERPRINT)
        expect(endpoint.surfaceFingerprint).toMatch(/^[a-f0-9]{64}$/)
        yield* Effect.promise(() => client.connect(new ModernStreamableHTTPClientTransport(new URL(endpoint.url))))
        expect(client.getProtocolEra()).toBe("modern")
        const listed = yield* Effect.promise(() => client.listTools())
        expect(listed.tools.map((tool) => tool.name)).toEqual(
          OxpSurface.TOOLS.map((tool) => tool.name).sort(),
        )

        const result = yield* Effect.promise(() =>
          client.callTool({ name: "read", arguments: { rootID: root.id, path: "hello.txt" } }),
        )
        expect(result.isError).not.toBe(true)
        expect(result.content.find((item) => item.type === "text")?.text).toContain("hello oxp")
        // Human/model-readable output remains MCP content and is duplicated
        // into structuredContent so structured-only ChatGPT connector bridges
        // cannot silently discard successful tool output.
        expect(result.structuredContent).toMatchObject({
          output: expect.stringContaining("hello oxp"),
          metadata: {
            action: "read",
            grounded: true,
            path: "/workspace/hello.txt",
          },
        })
        expect(JSON.stringify(result)).not.toContain(rootDir)

        const status = yield* Effect.promise(() =>
          client.callTool({ name: "openfork_info", arguments: { action: "status" } }),
        )
        expect(status.isError).not.toBe(true)
        expect(JSON.stringify(status)).toContain(endpoint.surfaceFingerprint)
        expect(JSON.stringify(status)).not.toContain(rootDir)
        expect(JSON.stringify(status)).toContain('"read":true')
        expect(JSON.stringify(status)).toContain('"write":false')
        expect(JSON.stringify(status)).toContain('"git":false')
        expect(JSON.stringify(status)).toContain('"process":false')
        expect(JSON.stringify(status)).toContain('"browser":false')
        expect(JSON.stringify(status)).toContain('"automation":false')
        expect(JSON.stringify(status)).toContain('"sessionSupervision":"none"')
        expect(JSON.stringify(status)).toContain('"requestSupervision":false')
        expect(JSON.stringify(status)).toContain('"delegation":"disabled"')
        expect(JSON.stringify(status)).toContain('"nestedDelegation":false')
      } finally {
        yield* Effect.promise(() => client.close().catch(() => undefined))
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
    { timeout: 20_000 },
  )

  it.live(
    "serves the MCP 2026-07-28 era while preserving ChatGPT tool metadata and structured output",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const server = yield* OxpServer.Service
      const rootDir = path.join(suite, "modern-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "hello.txt"), "hello modern oxp\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const endpoint = yield* server.start()
      const client = new ModernClient(
        { name: "oxp-modern-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )
      try {
        yield* Effect.promise(() => client.connect(new ModernStreamableHTTPClientTransport(new URL(endpoint.url))))
        expect(client.getProtocolEra()).toBe("modern")
        const listed = yield* Effect.promise(() => client.listTools())
        const readTool = listed.tools.find((tool) => tool.name === "read")
        expect(readTool?.title).toBe("Read workspace files")
        expect(readTool?.outputSchema).toEqual(OxpSurface.OUTPUT_SCHEMA)
        expect(readTool?.annotations?.readOnlyHint).toBe(true)
        // MCP 2026's standard Tool codec does not carry OpenAI's non-standard
        // top-level securitySchemes extension; ChatGPT's documented
        // compatibility projection is therefore the descriptor _meta mirror.
        expect(readTool?._meta?.securitySchemes).toEqual([{ type: "noauth" }])

        const result = yield* Effect.promise(() =>
          client.callTool({ name: "read", arguments: { rootID: root.id, path: "hello.txt" } }),
        )
        expect(result.isError).not.toBe(true)
        expect(result.content.find((item) => item.type === "text")?.text).toContain("hello modern oxp")
        expect(result.structuredContent).toMatchObject({
          output: expect.stringContaining("hello modern oxp"),
          metadata: { action: "read", grounded: true },
        })
      } finally {
        yield* Effect.promise(() => client.close().catch(() => undefined))
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
    { timeout: 20_000 },
  )

  it.live(
    "rejects 2025-era MCP traffic instead of negotiating down",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const server = yield* OxpServer.Service
      yield* config.setEnabled(true)
      const endpoint = yield* server.start()
      try {
        const response = yield* Effect.promise(() =>
          fetch(endpoint.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "legacy-probe", version: "1.0.0" },
              },
            }),
          }),
        )
        const body = yield* Effect.promise(() => response.text())
        expect(response.status).toBe(400)
        expect(body).toContain("Unsupported protocol version")
        expect(body).toContain("2026-07-28")
      } finally {
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
    { timeout: 20_000 },
  )

  it.live(
    "keeps the manifest fixed across grant changes while enforcing live call authority",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const server = yield* OxpServer.Service
      const rootDir = path.join(suite, "workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "hello.txt"), "hello\n"))
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const endpoint = yield* server.start()
      const client = new ModernClient(
        { name: "oxp-revocation-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )
      try {
        yield* Effect.promise(() => client.connect(new ModernStreamableHTTPClientTransport(new URL(endpoint.url))))
        expect(client.getProtocolEra()).toBe("modern")
        const before = yield* Effect.promise(() => client.listTools())
        yield* config.setGrant({ read: false })
        const after = yield* Effect.promise(() => client.listTools())
        expect(after.tools).toEqual(before.tools)
        expect(endpoint.surfaceFingerprint).toBe(OxpSurface.FINGERPRINT)

        const denied = yield* Effect.promise(() =>
          client.callTool({ name: "read", arguments: { rootID: root.id, path: "hello.txt" } }),
        )
        expect(denied.isError).toBe(true)
        expect(denied.content.find((item) => item.type === "text")?.text).toContain("OXP_AUTH_DENIED")
        expect(denied.structuredContent).toMatchObject({
          error: {
            code: "OXP_AUTH_DENIED",
            retryable: false,
          },
        })
      } finally {
        yield* Effect.promise(() => client.close().catch(() => undefined))
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
    { timeout: 20_000 },
  )

  it.live(
    "binds parent-tool epochs only to documented ChatGPT conversation metadata",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const server = yield* OxpServer.Service
      const activities = yield* OxpActivityInspection.Service
      yield* config.setEnabled(true)
      const endpoint = yield* server.start()
      const client = new ModernClient(
        { name: "oxp-parent-correlation-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )
      const call = (openaiSession?: string) =>
        client.callTool({
          name: "openfork_info",
          arguments: { action: "status" },
          ...(openaiSession
            ? { _meta: { "openai/session": openaiSession } }
            : {}),
        })

      try {
        yield* Effect.promise(() =>
          client.connect(
            new ModernStreamableHTTPClientTransport(new URL(endpoint.url)),
          ),
        )
        expect(client.getProtocolEra()).toBe("modern")

        yield* Effect.promise(() => call("conversation-a"))
        expect(server.metrics()).toMatchObject({
          calls: 1,
          parentEpochs: 1,
          trackedParents: 1,
          conversationCorrelatedCalls: 1,
          unattributedParentCalls: 0,
        })

        yield* Effect.promise(() => call("conversation-a"))
        expect(server.metrics()).toMatchObject({
          calls: 2,
          parentEpochs: 1,
          trackedParents: 1,
          conversationCorrelatedCalls: 2,
        })

        yield* Effect.promise(() => call("conversation-b"))
        expect(server.metrics()).toMatchObject({
          calls: 3,
          parentEpochs: 2,
          trackedParents: 2,
          conversationCorrelatedCalls: 3,
        })

        yield* Effect.promise(() => call())
        expect(server.metrics()).toMatchObject({
          calls: 4,
          parentEpochs: 2,
          trackedParents: 2,
          conversationCorrelatedCalls: 3,
          unattributedParentCalls: 1,
        })
        const rows = yield* activities.list()
        expect(rows).toHaveLength(2)
        expect(rows.map((row) => row.call_count).sort()).toEqual([1, 2])
        const serialized = JSON.stringify(rows)
        expect(serialized).not.toContain("conversation-a")
        expect(serialized).not.toContain("conversation-b")
      } finally {
        yield* Effect.promise(() => client.close().catch(() => undefined))
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
    { timeout: 20_000 },
  )

  it.live(
    "rejects wrong paths, hostile Host/Origin headers, and oversized declared bodies before MCP handling",
    Effect.gen(function* () {
      const server = yield* OxpServer.Service
      const endpoint = yield* server.start()
      try {
        const parsed = new URL(endpoint.url)
        expect((yield* Effect.promise(() => raw({ port: endpoint.port, path: "/wrong" }))).status).toBe(404)
        expect(
          (yield* Effect.promise(() => raw({ port: endpoint.port, path: parsed.pathname, host: "evil.example" }))).status,
        ).toBe(403)
        expect(
          (yield* Effect.promise(() =>
            raw({ port: endpoint.port, path: parsed.pathname, origin: "https://evil.example" }),
          )).status,
        ).toBe(403)
        const metadata = new URL(endpoint.metadataUrl)
        expect(
          (yield* Effect.promise(() =>
            raw({ port: endpoint.port, path: metadata.pathname, method: "POST", body: "{}" }),
          )).status,
        ).toBe(405)
        expect(yield* Effect.promise(() => rawOversizedDeclaration(endpoint.port, parsed.pathname))).toBe(413)
      } finally {
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
  )

  it.live(
    "allows only one local endpoint per OXP server owner",
    Effect.gen(function* () {
      const server = yield* OxpServer.Service
      const endpoint = yield* server.start()
      try {
        const busy = yield* server.start().pipe(Effect.flip)
        expect(busy._tag).toBe("OXP_BUSY")
      } finally {
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
  )

  it.live(
    "joins concurrent endpoint stop callers onto one listener-retirement proof",
    Effect.gen(function* () {
      const server = yield* OxpServer.Service
      const endpoint = yield* server.start()
      const first = endpoint.stop({ forceAfterMs: 1_000 })
      const second = endpoint.stop({ forceAfterMs: 1_000 })
      expect(second).toBe(first)
      yield* Effect.promise(() => Promise.all([first, second]))
      expect(server.active()).toBeUndefined()
    }),
  )
})
