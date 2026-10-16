import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { request } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { connect as connectSocket } from "node:net"
import { EventEmitter } from "node:events"
import { Effect, Layer } from "effect"
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport as LegacyStreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { Global } from "@opencode-ai/core/global"
import { MAX_SOURCE_BYTES } from "@/code/input-admission"
import { OxpConfig } from "@/oxp/config"
import { OxpAgentCatalog } from "@/oxp/agent-catalog"
import { OxpModelCatalog } from "@/oxp/model-catalog"
import { OxpRoot } from "@/oxp/root"
import { OxpRequestControl } from "@/oxp/request-control"
import {
  OxpServer,
  bridgeRequestCancellation,
  durableContinuationObserved,
  paginateToolList,
  projectInternalErrorBody,
  toolResult,
} from "@/oxp/server"
import { OxpError } from "@/oxp/error"
import { OxpRuntimeRefresh } from "@/oxp/runtime-refresh"
import { OxpSessionControl } from "@/oxp/session-control"
import { OxpSurface } from "@/oxp/surface"
import { OxpWorkerControl } from "@/oxp/worker-control"
import { OxpMcpControl } from "@/oxp/mcp-control"
import { OxpSystemOneControl } from "@/oxp/system-one-control"
import { OxpDiagnostics } from "@/oxp/diagnostics"
import { AX_IMPLEMENTATION } from "@/oxp/ax-revisions"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-server-${randomUUID()}`)

test("OXP MCP projection includes native image/audio content without duplicating bytes in structured metadata", () => {
  const result = toolResult({
    output: "Media attachment available",
    mediaContent: [
      { type: "image", mimeType: "image/jpeg", data: "/9j/" },
      { type: "audio", mimeType: "audio/wav", data: "AAEC" },
    ],
    attachments: [{ kind: "file", handle: "/approved/media.mp4", mediaType: "video/mp4" }],
  })
  expect(result.content).toEqual([
    { type: "text", text: "Media attachment available" },
    { type: "image", mimeType: "image/jpeg", data: "/9j/" },
    { type: "audio", mimeType: "audio/wav", data: "AAEC" },
  ])
  expect(JSON.stringify(result.structuredContent)).not.toContain("/9j/")
  expect(JSON.stringify(result.structuredContent)).not.toContain("AAEC")
  expect(result.structuredContent).toMatchObject({ attachments: [{ mediaType: "video/mp4" }] })
})
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const noSessionControl = Layer.succeed(
  OxpSessionControl.Service,
  OxpSessionControl.Service.of({
    pause: () => Effect.die("server test must not enter Session runtime control"),
    resume: () => Effect.die("server test must not enter Session runtime control"),
    abort: () => Effect.die("server test must not enter Session runtime control"),
    archive: () => Effect.die("server test must not enter Session runtime control"),
    unarchive: () => Effect.die("server test must not enter Session runtime control"),
    delete: () => Effect.die("server test must not enter Session runtime control"),
    setSelection: () => Effect.die("server test must not enter Session runtime control"),
    steer: () => Effect.die("server test must not enter Session runtime control"),
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
    setSelection: () => Effect.die("server test must not enter worker runtime control"),
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
const noModelCatalog = Layer.succeed(
  OxpModelCatalog.Service,
  OxpModelCatalog.Service.of({
    list: () => Effect.die("server test must not enter workspace model catalog"),
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
    [OxpModelCatalog.node, noModelCatalog],
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
afterEach(() => OxpRuntimeRefresh.install(undefined))

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

  test("caches canonical list pagination while invalidating mutable custom projections", () => {
    const names: string[] = []
    let cursor: string | undefined
    do {
      const page = paginateToolList(OxpSurface.TOOLS, cursor, 600)
      names.push(...page.tools.map((tool) => tool.name))
      cursor = page.nextCursor
    } while (cursor)
    expect(names).toEqual(OxpSurface.TOOLS.map((tool) => tool.name).toSorted())

    const mutable = Array.from({ length: 8 }, (_, index) => ({
      ...OxpSurface.TOOLS[0]!,
      name: `mutable_${index}`,
      description: "original",
    }))
    const first = paginateToolList(mutable, undefined, 600)
    expect(first.nextCursor).toBeDefined()
    mutable[0]!.description = "changed".repeat(30)
    expect(() => paginateToolList(mutable, first.nextCursor, 600)).toThrow(/stale/i)
  })

  test("returns the incident ID in valid JSON-RPC transport errors", () => {
    const incidentID = "9c2ef6c1-2069-4a44-9d6a-b6cc155f8f32"
    expect(
      projectInternalErrorBody(
        { jsonrpc: "2.0", id: 42, method: "tools/call" },
        incidentID,
      ),
    ).toEqual({
      jsonrpc: "2.0",
      id: 42,
      error: {
        code: -32603,
        message: `Unexpected OXP transport failure recorded as ${incidentID}; query openfork_diagnostics with incidentID=${incidentID}.`,
      },
    })
    expect(
      projectInternalErrorBody(
        [
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: "call-1", method: "tools/call" },
        ],
        incidentID,
      ),
    ).toEqual([
      {
        jsonrpc: "2.0",
        id: "call-1",
        error: {
          code: -32603,
          message: `Unexpected OXP transport failure recorded as ${incidentID}; query openfork_diagnostics with incidentID=${incidentID}.`,
        },
      },
    ])
    expect(projectInternalErrorBody({ jsonrpc: "2.0", method: "notifications/initialized" }, incidentID)).toBeUndefined()
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
        expect(client.getServerVersion()?.version).toBe(
          `0.1.0+schema.${OxpSurface.FINGERPRINT.slice(0, 12)}`,
        )
        const listed = yield* Effect.promise(() => client.listTools())
        expect(listed.tools.map((tool) => tool.name)).toEqual(
          OxpSurface.TOOLS.map((tool) => tool.name).sort(),
        )
        const workerTool = listed.tools.find((tool) => tool.name === "openfork_worker")
        expect(
          (workerTool?.inputSchema as { properties?: Record<string, unknown> } | undefined)
            ?.properties,
        ).toHaveProperty("workdir")

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
        expect(JSON.stringify(status)).toContain('"runtime"')
        expect(JSON.stringify(status)).toContain('"refreshable":false')
        expect(JSON.stringify(status)).not.toContain("runtimeModuleUrl")
        expect(JSON.stringify(status)).not.toContain("dist/node/node.js")
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
    "serves ChatGPT's current 2025 transport through a stateless adapter without downgrading OXP semantics",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const server = yield* OxpServer.Service
      const rootDir = path.join(suite, "legacy-transport-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(rootDir, "hello.txt"), "hello legacy transport\n"),
      )
      const root = yield* roots.approve(rootDir)
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const endpoint = yield* server.start()
      const client = new LegacyClient({
        name: "oxp-legacy-transport-test",
        version: "1.0.0",
      })
      try {
        yield* Effect.promise(() =>
          client.connect(
            new LegacyStreamableHTTPClientTransport(new URL(endpoint.url)),
          ),
        )
        const listed = yield* Effect.promise(() => client.listTools())
        const readTool = listed.tools.find((tool) => tool.name === "read")
        expect(readTool?.outputSchema).toEqual(OxpSurface.LEGACY_OUTPUT_SCHEMA)
        expect(
          (readTool?.outputSchema as { required?: string[] } | undefined)?.required,
        ).toBeUndefined()

        const result = yield* Effect.promise(() =>
          client.callTool({
            name: "read",
            arguments: { rootID: root.id, path: "hello.txt" },
          }),
        )
        expect(result.isError).not.toBe(true)
        expect(
          result.content.find((item) => item.type === "text")?.text,
        ).toContain("hello legacy transport")
        expect(result.structuredContent).toMatchObject({
          output: expect.stringContaining("hello legacy transport"),
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
          output: expect.stringContaining("OXP_AUTH_DENIED"),
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
    "executes brokered Code Mode end-to-end over the real OXP MCP transport",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const server = yield* OxpServer.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ code: true })
      const endpoint = yield* server.start()
      const client = new ModernClient(
        { name: "oxp-code-e2e", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )
      try {
        yield* Effect.promise(() => client.connect(new ModernStreamableHTTPClientTransport(new URL(endpoint.url))))
        const listed = yield* Effect.promise(() => client.listTools())
        expect(listed.tools.some((tool) => tool.name === "code")).toBe(false)
        expect(listed.tools.find((tool) => tool.name === "capability")?.description).toMatch(
          /Code Mode: describe code, then call code/i,
        )

        const described = yield* Effect.promise(() =>
          client.callTool({
            name: "capability",
            arguments: { action: "describe", namespace: "openfork", capability: "code" },
          }),
        )
        expect(described.isError).not.toBe(true)
        const descriptor = JSON.parse(
          described.content.find((item) => item.type === "text")?.text ?? "{}",
        ) as { contract?: string; capability?: { id?: string; authority?: string; exposure?: string } }
        expect(descriptor.capability).toMatchObject({ id: "code", authority: "code", exposure: "brokered" })
        expect(descriptor.contract).toMatch(/^broker-v1:[0-9a-f]{24}$/)

        const ran = yield* Effect.promise(() =>
          client.callTool({
            name: "capability",
            arguments: {
              action: "call",
              namespace: "openfork",
              capability: "code",
              contract: descriptor.contract,
              args: {
                action: "run",
                code: "return input.value + 2",
                input: { value: 40 },
              },
            },
          }),
        )
        expect(ran.isError).not.toBe(true)
        expect(ran.structuredContent).toMatchObject({
          data: { action: "run", ok: true, value: 42 },
          metadata: { action: "run", stateless: true },
        })

        const rejected = yield* Effect.promise(() =>
          client.callTool({
            name: "capability",
            arguments: {
              action: "call",
              namespace: "openfork",
              capability: "code",
              contract: descriptor.contract,
              args: { action: "run", code: "x".repeat(MAX_SOURCE_BYTES + 1) },
            },
          }),
        )
        expect(rejected.isError).toBe(true)
        expect(rejected.structuredContent).toMatchObject({
          error: { code: "OXP_INVALID_ARGUMENT", retryable: false },
        })
        expect(rejected.content.find((item) => item.type === "text")?.text).toContain(
          `${MAX_SOURCE_BYTES}-byte source limit`,
        )
      } finally {
        yield* Effect.promise(() => client.close().catch(() => undefined))
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
    { timeout: 20_000 },
  )


  it.live(
    "arms a changed runtime trial only after the real MCP response finishes",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const server = yield* OxpServer.Service
      const runtimeID = `sha256:${"a".repeat(64)}`
      const candidateID = `sha256:${"b".repeat(64)}`
      let refreshCalls = 0
      let armCalls = 0

      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, process: true })
      OxpRuntimeRefresh.install({
        status: async () => ({
          refreshable: true,
          state: "stable",
          runtimeID,
          activationGeneration: 7,
          activatedAt: 123,
        }),
        refresh: async (input) => {
          refreshCalls += 1
          expect(input.expectedRuntimeID).toBe(runtimeID)
          expect(armCalls).toBe(0)
          return {
            action: "refresh",
            changed: true,
            status: {
              refreshable: true,
              state: "scheduled",
              runtimeID,
              activationGeneration: 7,
              activatedAt: 123,
              trial: {
                id: "response-barrier-e2e",
                previousRuntimeID: runtimeID,
                candidateRuntimeID: candidateID,
                phase: "scheduled",
              },
            },
          }
        },
        arm: async (trialID) => {
          expect(trialID).toBe("response-barrier-e2e")
          armCalls += 1
        },
        accept: async () => {
          throw new Error("accept must not run")
        },
        rollback: async () => {
          throw new Error("rollback must not run")
        },
      })

      const endpoint = yield* server.start()
      const client = new ModernClient(
        { name: "oxp-runtime-refresh-e2e", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )
      try {
        yield* Effect.promise(() =>
          client.connect(
            new ModernStreamableHTTPClientTransport(new URL(endpoint.url)),
          ),
        )

        const status = yield* Effect.promise(() =>
          client.callTool({
            name: "openfork_info",
            arguments: { action: "status" },
          }),
        )
        expect(status.isError).not.toBe(true)
        const statusText =
          status.content.find((item) => item.type === "text")?.text ?? ""
        const statusData = JSON.parse(statusText) as {
          runtime?: { refreshable?: boolean; runtimeID?: string }
        }
        expect(statusData.runtime).toMatchObject({
          refreshable: true,
          runtimeID,
        })
        expect(statusText).not.toContain("runtimeModuleUrl")
        expect(statusText).not.toContain("dist/node/node.js")

        const described = yield* Effect.promise(() =>
          client.callTool({
            name: "capability",
            arguments: {
              action: "describe",
              namespace: "openfork",
              capability: "runtime.refresh",
            },
          }),
        )
        expect(described.isError).not.toBe(true)
        const descriptorText =
          described.content.find((item) => item.type === "text")?.text ?? "{}"
        const descriptor = JSON.parse(descriptorText) as {
          contract: string
          capability: { id: string; authority: string; workspaceTier: number }
        }
        expect(descriptor).toMatchObject({
          capability: {
            id: "runtime.refresh",
            authority: "process",
            workspaceTier: 0,
          },
        })
        expect(descriptor.contract).toMatch(/^broker-v1:[0-9a-f]{24}$/)

        const refreshed = yield* Effect.promise(() =>
          client.callTool({
            name: "capability",
            arguments: {
              action: "call",
              namespace: "openfork",
              capability: "runtime.refresh",
              contract: descriptor.contract,
              args: {
                action: "refresh",
                expectedRuntimeID: runtimeID,
              },
            },
          }),
        )
        expect(refreshed.isError).not.toBe(true)
        expect(refreshCalls).toBe(1)
        expect(armCalls).toBe(1)
        expect(refreshed.structuredContent).toMatchObject({
          data: {
            action: "refresh",
            changed: true,
            status: {
              runtimeID,
              state: "scheduled",
              trial: {
                id: "response-barrier-e2e",
                candidateRuntimeID: candidateID,
                phase: "scheduled",
              },
            },
          },
          mutation: {
            attempted: true,
            committed: true,
          },
        })
        expect(JSON.stringify(refreshed.structuredContent)).not.toContain("afterResponse")
      } finally {
        OxpRuntimeRefresh.install(undefined)
        yield* Effect.promise(() => client.close().catch(() => undefined))
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
    { timeout: 20_000 },
  )

  it.live(
    "keeps incident retrieval available when config-backed OXP calls become unavailable",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const server = yield* OxpServer.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const endpoint = yield* server.start()
      const client = new ModernClient(
        { name: "oxp-independent-diagnostics-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )
      try {
        yield* Effect.promise(() =>
          client.connect(new ModernStreamableHTTPClientTransport(new URL(endpoint.url))),
        )

        const incidentID = OxpDiagnostics.record({
          cause: new TypeError("private error detail must not be returned"),
          phase: "tool_boundary",
          tool: "openfork_info",
          action: "capabilities",
          surfaceFingerprint: OxpSurface.FINGERPRINT,
        }).id

        // This diagnostic read is authorized by the secret local OXP endpoint
        // itself and remains available when config-backed authority checks fail.
        yield* config.setEnabled(false)
        const unavailableInfo = yield* Effect.promise(() =>
          client.callTool({ name: "openfork_info", arguments: { action: "status" } }),
        )
        expect(unavailableInfo.isError).toBe(true)
        const diagnostics = yield* Effect.promise(() =>
          client.callTool({
            name: "openfork_diagnostics",
            arguments: { incidentID },
          }),
        )
        expect(diagnostics.isError).not.toBe(true)
        const report = diagnostics.structuredContent as {
          data?: {
            incidents?: Array<{ id: string; errorName: string }>
            latency?: {
              toolCall: { count: number; p95UpperMs?: number }
              dispatch: { count: number }
              activityBegin: { count: number }
              mcpTransport: { count: number }
            }
          }
        }
        expect(report.data?.incidents).toMatchObject([{ id: incidentID }])
        expect(report.data?.incidents?.[0]?.errorName).toBe("TypeError")
        expect(report.data?.latency?.toolCall.count).toBeGreaterThanOrEqual(1)
        expect(report.data?.latency?.dispatch.count).toBeGreaterThanOrEqual(1)
        expect(report.data?.latency?.activityBegin.count).toBe(0)
        expect(report.data?.latency?.mcpTransport.count).toBeGreaterThanOrEqual(1)
        expect(report.data?.latency?.toolCall.p95UpperMs).toBeGreaterThan(0)
        expect(JSON.stringify(diagnostics)).not.toContain("private error detail must not be returned")
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
        expect(rows).toHaveLength(0)
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
    "status handshake registers the session title on the canonical activity row",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const server = yield* OxpServer.Service
      const activities = yield* OxpActivityInspection.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const endpoint = yield* server.start()
      const client = new ModernClient(
        { name: "oxp-session-title-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )
      const call = (openaiSession?: string, sessionTitle?: string) =>
        client.callTool({
          name: "openfork_info",
          arguments: {
            action: "status",
            ...(sessionTitle !== undefined ? { sessionTitle } : {}),
          },
          ...(openaiSession ? { _meta: { "openai/session": openaiSession } } : {}),
        })

      try {
        yield* Effect.promise(() =>
          client.connect(new ModernStreamableHTTPClientTransport(new URL(endpoint.url))),
        )
        expect(client.getProtocolEra()).toBe("modern")

        const anonymous = yield* Effect.promise(() => call("conv-anon"))
        expect(anonymous.isError).not.toBe(true)
        // The static manifest fingerprint can remain unchanged when only
        // on-demand capability ranking, guidance or activity recovery changes.
        // A real MCP status reply must declare those implementation revisions.
        const status = anonymous.structuredContent as { data?: { implementation?: { ax?: unknown } } }
        expect(status.data?.implementation?.ax ?? (anonymous.structuredContent as any)?.implementation?.ax)
          .toEqual(AX_IMPLEMENTATION)
        expect(JSON.stringify(anonymous.structuredContent)).toContain('"sessionTitle":null')
        expect(JSON.stringify(anonymous.structuredContent)).toContain('"sessionPersisted":false')
        expect(yield* activities.list()).toHaveLength(0)

        const titled = yield* Effect.promise(() => call("conv-title-a", "Design GitHub Tool"))
        expect(titled.isError).not.toBe(true)
        expect(JSON.stringify(titled.structuredContent)).toContain('"sessionTitle":"Design GitHub Tool"')
        expect(JSON.stringify(titled.structuredContent)).toContain('"sessionPersisted":true')
        expect(yield* activities.list()).toHaveLength(1)
        expect((yield* activities.list())[0]?.title).toBe("Design GitHub Tool")

        yield* Effect.promise(() => call("conv-title-a", "ArcFit Hardening"))
        const refreshed = yield* activities.list()
        expect(refreshed).toHaveLength(1)
        expect(refreshed[0]?.title).toBe("ArcFit Hardening")

        yield* Effect.promise(() => call("conv-title-b", "Vectorizer Research Corpus"))
        expect(yield* activities.list()).toHaveLength(2)

        const blank = yield* Effect.promise(() => call("conv-title-a", "   "))
        expect(blank.isError).toBe(true)
        expect(JSON.stringify(blank)).toContain("sessionTitle is required")

        const wrongAction = yield* Effect.promise(() =>
          client.callTool({
            name: "openfork_info",
            arguments: { action: "capabilities", sessionTitle: "X" },
          }),
        )
        expect(wrongAction.isError).toBe(true)
        expect(JSON.stringify(wrongAction)).toContain("sessionTitle is only valid")
      } finally {
        yield* Effect.promise(() => client.close().catch(() => undefined))
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
    { timeout: 20_000 },
  )

  it.live(
    "keeps ordinary calls independent of a malformed correlation key and contains browser binding failures",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const roots = yield* OxpRoot.Service
      const server = yield* OxpServer.Service
      const rootDir = path.join(suite, "correlation-key-workspace")
      yield* Effect.promise(() => fs.mkdir(rootDir))
      yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "hello.txt"), "correlated read succeeded\n"))
      const root = yield* roots.approve(rootDir)
      yield* Effect.promise(() => fs.writeFile(path.join(configDir, "oxp-activity.key"), "malformed-correlation-key\n"))
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true, process: true, sessionSupervision: "approved-roots" })
      const endpoint = yield* server.start()
      const client = new ModernClient(
        { name: "oxp-correlation-failure-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )

      try {
        yield* Effect.promise(() =>
          client.connect(new ModernStreamableHTTPClientTransport(new URL(endpoint.url))),
        )

        const status = yield* Effect.promise(() =>
          client.callTool({
            name: "openfork_info",
            arguments: { action: "status" },
            _meta: { "openai/session": "correlation-key-unavailable" },
          }),
        )
        expect(status.isError).not.toBe(true)

        const capabilities = yield* Effect.promise(() =>
          client.callTool({
            name: "capability",
            arguments: { action: "list", namespace: "openfork", load: "default" },
            _meta: { "openai/session": "correlation-key-unavailable" },
          }),
        )
        expect(capabilities.isError).not.toBe(true)
        expect(capabilities.content.find((item) => item.type === "text")?.text).toContain("read")

        const read = yield* Effect.promise(() =>
          client.callTool({
            name: "read",
            arguments: { rootID: root.id, path: "hello.txt" },
            _meta: { "openai/session": "correlation-key-unavailable" },
          }),
        )
        expect(read.isError).not.toBe(true)
        expect(read.content.find((item) => item.type === "text")?.text).toContain("correlated read succeeded")

        const processDescriptor = yield* Effect.promise(() =>
          client.callTool({
            name: "capability",
            arguments: { action: "describe", namespace: "openfork", capability: "process" },
            _meta: { "openai/session": "correlation-key-unavailable" },
          }),
        )
        expect(processDescriptor.isError).not.toBe(true)
        const descriptor = JSON.parse(
          processDescriptor.content.find((item) => item.type === "text")?.text ?? "{}",
        ) as { contract?: string }
        expect(descriptor.contract).toMatch(/^broker-v1:[0-9a-f]{24}$/)

        const processCall = yield* Effect.promise(() =>
          client.callTool({
            name: "capability",
            arguments: {
              action: "call",
              namespace: "openfork",
              capability: "process",
              contract: descriptor.contract,
              args: {
                action: "start",
                rootID: root.id,
                argv: [process.execPath, "-e", "process.stdout.write('oxp-process-correlation-ok')"],
                mode: "foreground",
                yieldMs: 5_000,
              },
            },
            _meta: { "openai/session": "correlation-key-unavailable" },
          }),
        )
        expect(processCall.isError).not.toBe(true)
        expect(JSON.stringify(processCall.structuredContent)).toContain("oxp-process-correlation-ok")

        const sessions = yield* Effect.promise(() =>
          client.callTool({
            name: "openfork_session",
            arguments: { action: "list", rootID: root.id, limit: 10 },
            _meta: { "openai/session": "correlation-key-unavailable" },
          }),
        )
        expect(sessions.isError).not.toBe(true)
        expect(sessions.structuredContent).toMatchObject({
          data: { sessions: [], scanned: 0, truncated: false },
        })

        const browser = yield* Effect.promise(() =>
          client.callTool({
            name: "capability",
            arguments: {
              action: "call",
              namespace: "openfork",
              capability: "browser",
              contract: "broker-v1:000000000000000000000000",
              args: {},
            },
            _meta: { "openai/session": "correlation-key-unavailable" },
          }),
        )
        expect(browser.isError).toBe(true)
        expect(browser.structuredContent).toMatchObject({
          error: { code: "OXP_DEPENDENCY_UNAVAILABLE" },
        })
        expect(JSON.stringify(browser)).not.toContain("SECRET_KEY_MATERIAL")
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
    "preserves request isolation and bounded latency counters under 100 overlapping real MCP calls",
    Effect.gen(function* () {
      const config = yield* OxpConfig.Service
      const server = yield* OxpServer.Service
      yield* config.setEnabled(true)
      yield* config.setGrant({ read: true })
      const endpoint = yield* server.start()
      const client = new ModernClient(
        { name: "oxp-mcp-concurrency-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )
      try {
        yield* Effect.promise(() => client.connect(new ModernStreamableHTTPClientTransport(new URL(endpoint.url))))
        const count = 100
        const calls = Array.from({ length: count }, (_, index) =>
          client.callTool({
            name: index % 2 ? "openfork_diagnostics" : "openfork_info",
            arguments: index % 2 ? {} : { action: "status" },
          }),
        )
        const results = yield* Effect.promise(() => Promise.all(calls))
        expect(results).toHaveLength(count)
        for (let i = 0; i < results.length; i++) {
          expect(results[i]!.isError).not.toBe(true)
          const output = results[i]!.structuredContent as { data?: { schemaFingerprint?: string; incidents?: unknown[] } }
          if (i % 2) expect(Array.isArray(output.data?.incidents)).toBe(true)
          else expect(output.data?.schemaFingerprint).toBe(OxpSurface.FINGERPRINT)
        }
        const counters = server.metrics()
        expect(counters.calls).toBeGreaterThanOrEqual(count)
        expect(counters.latency?.toolCall.count).toBeGreaterThanOrEqual(count)
        expect(counters.latency?.dispatch.count).toBeGreaterThanOrEqual(count)
        expect(counters.latency?.activityBegin.count).toBe(0)
        expect(counters.latency?.mcpTransport.count).toBeGreaterThanOrEqual(count)
      } finally {
        yield* Effect.promise(() => client.close().catch(() => undefined))
        yield* Effect.promise(() => endpoint.stop({ forceAfterMs: 1_000 }))
      }
    }),
    { timeout: 30_000 },
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
