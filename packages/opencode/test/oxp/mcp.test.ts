import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { OxpCapability } from "@/oxp/capability"
import { OxpConfig } from "@/oxp/config"
import { OxpMcpControl } from "@/oxp/mcp-control"
import { OxpRoot } from "@/oxp/root"
import { OxpSessionControl } from "@/oxp/session-control"
import { OxpSystemOneControl } from "@/oxp/system-one-control"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-mcp-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")

const readTool: OxpMcpControl.Tool = {
  server: "alpha/server",
  name: "lookup/item",
  description: "Look up one item",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  readOnlyHint: true,
}

const mutationTool: OxpMcpControl.Tool = {
  server: "writer",
  name: "publish",
  description: "Publish an item",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  readOnlyHint: false,
}

let catalog: OxpMcpControl.Tool[] = []
let calls: Array<{
  server: string
  tool: string
  args: unknown
}> = []
let beforeCommit: (() => Promise<void>) | undefined
let callFailure: Error | undefined

const controlLayer = Layer.succeed(
  OxpMcpControl.Service,
  OxpMcpControl.Service.of({
    list: () => Effect.succeed(catalog.map((item) => ({ ...item }))),
    call: (target, input) =>
      Effect.tryPromise({
        try: async () => {
          await beforeCommit?.()
          await target.commitGuard?.()
          calls.push({
            server: input.server,
            tool: input.tool,
            args: input.args,
          })
          if (callFailure) throw callFailure
          return {
            content: [
              { type: "text", text: "native text" },
              { type: "image", mimeType: "image/png", data: "OMITTED" },
            ],
            structuredContent: { ok: true },
          }
        },
        catch: (cause) =>
          cause instanceof Error ? cause : new Error("mock MCP call failed"),
      }),
  }),
)
const noSystemOneControl = Layer.succeed(
  OxpSystemOneControl.Service,
  OxpSystemOneControl.Service.of({
    infer: () => Effect.die("OXP MCP tests must not enter System One runtime control"),
  }),
)
const noSessionControl = Layer.succeed(
  OxpSessionControl.Service,
  OxpSessionControl.Service.of({
    pause: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    resume: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    abort: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    archive: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    unarchive: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    delete: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    setSelection: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    send: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    turn: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    backgroundSubagents: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    todoGet: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    todoSet: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    checkpoint: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
    goal: () => Effect.die("OXP MCP tests must not enter Session runtime control"),
  }),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([
    CrossSpawnSpawner.node,
    OxpCapability.node,
    OxpRoot.node,
    OxpConfig.node,
  ]),
  [
    [Global.node, Global.layerWith({ config: configDir, state: stateDir })],
    [OxpMcpControl.node, controlLayer],
    [OxpSystemOneControl.node, noSystemOneControl],
    [OxpSessionControl.node, noSessionControl],
  ],
)
const it = testEffect(layer)

beforeEach(async () => {
  catalog = []
  calls = []
  beforeCommit = undefined
  callFailure = undefined
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})

afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

const prepare = Effect.fnUntraced(function* () {
  const config = yield* OxpConfig.Service
  const roots = yield* OxpRoot.Service
  const directory = path.join(suite, "workspace")
  yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
  const root = yield* roots.approve(directory)
  yield* config.setEnabled(true)
  yield* config.setGrant({ integrations: true })
  return { config, roots, root, directory }
})

describe("OXP external MCP capability broker", () => {
  it.live(
    "requires explicit root + integrations authority before dynamic discovery",
    Effect.gen(function* () {
      const { config, root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      catalog = [readTool]

      const missingRoot = yield* capability
        .execute({ action: "list", namespace: "mcp" })
        .pipe(Effect.flip)
      expect(missingRoot._tag).toBe("OXP_ROOT_REQUIRED")

      yield* config.setGrant({ integrations: false })
      const denied = yield* capability
        .execute({
          action: "list",
          namespace: "mcp",
          rootID: root.id,
        })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OXP_AUTH_DENIED")
    }),
  )

  it.live(
    "lists collision-free canonical server/tool IDs without expanding schemas",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      catalog = [
        readTool,
        {
          ...readTool,
          server: "beta",
          name: "lookup/item",
          description: "Same native tool name on another server",
        },
      ]

      const result = yield* capability.execute({
        action: "list",
        namespace: "mcp",
        rootID: root.id,
      })
      const rows = JSON.parse(result.output) as Array<{
        id: string
        server: string
        tool: string
      }>
      expect(rows.map((row) => row.id)).toEqual([
        "alpha%2Fserver/lookup%2Fitem",
        "beta/lookup%2Fitem",
      ])
      expect(JSON.stringify(rows)).not.toContain("inputSchema")
      expect(JSON.stringify(rows)).not.toContain("properties")
    }),
  )

  it.live(
    "bounds external MCP catalog prose while preserving a fuller describe-time explanation",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      const verbose = `  Detailed lookup guidance\n${"x".repeat(500)}  `
      catalog = [{ ...readTool, description: verbose }]

      const listed = yield* capability.execute({
        action: "list",
        namespace: "mcp",
        rootID: root.id,
      })
      const rows = JSON.parse(listed.output) as Array<{ description: string }>
      expect(rows[0]!.description.length).toBeLessThanOrEqual(220)
      expect(rows[0]!.description).not.toContain("\n")
      expect(rows[0]!.description.endsWith("...")).toBe(true)

      const described = yield* capability.execute({
        action: "describe",
        namespace: "mcp",
        rootID: root.id,
        capability: "alpha%2Fserver/lookup%2Fitem",
      })
      const descriptor = JSON.parse(described.output) as { description: string; capability: { description: string } }
      expect(descriptor.description.length).toBeGreaterThan(descriptor.capability.description.length)
      expect(descriptor.description.length).toBeLessThanOrEqual(2_000)
      expect(descriptor.description).not.toContain("\n")

      catalog = [{ ...readTool, server: "blank", name: "noop", description: "   " }]
      const fallback = yield* capability.execute({
        action: "list",
        namespace: "mcp",
        rootID: root.id,
      })
      expect(fallback.output).toContain("External MCP tool blank/noop. Inspect its schema before calling.")
    }),
  )

  it.live(
    "rejects ambiguous bare tool names and accepts canonical IDs",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      catalog = [
        { ...mutationTool, server: "one" },
        { ...mutationTool, server: "two" },
      ]

      const ambiguous = yield* capability
        .execute({
          action: "describe",
          namespace: "mcp",
          rootID: root.id,
          capability: "publish",
        })
        .pipe(Effect.flip)
      expect(ambiguous._tag).toBe("OXP_CONFLICT")
      expect(ambiguous.detail).toContain("one/publish")
      expect(ambiguous.detail).toContain("two/publish")

      const described = yield* capability.execute({
        action: "describe",
        namespace: "mcp",
        rootID: root.id,
        capability: "two/publish",
      })
      const data = JSON.parse(described.output)
      expect(data.capability).toMatchObject({
        id: "two/publish",
        server: "two",
        tool: "publish",
        mutation: "write",
      })
      expect(data.protocol).toBe("broker-descriptor-v1")
      expect(data.inputSchema).toMatchObject({
        type: "object",
        required: ["value"],
      })
    }),
  )

  it.live(
    "invalidates a descriptor contract when the native MCP schema changes",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      catalog = [mutationTool]

      const described = yield* capability.execute({
        action: "describe",
        namespace: "mcp",
        rootID: root.id,
        capability: "writer/publish",
      })
      const descriptor = JSON.parse(described.output)

      catalog = [
        {
          ...mutationTool,
          inputSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ]
      const stale = yield* capability
        .execute({
          action: "call",
          namespace: "mcp",
          rootID: root.id,
          capability: "writer/publish",
          contract: descriptor.contract,
          args: { value: 1 },
        })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(stale.detail).toContain("descriptor contract")
      expect(calls).toEqual([])
    }),
  )

  it.live(
    "rejects non-object MCP arguments before any external invocation",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      catalog = [mutationTool]
      const described = JSON.parse(
        (
          yield* capability.execute({
            action: "describe",
            namespace: "mcp",
            rootID: root.id,
            capability: "writer/publish",
          })
        ).output,
      )

      const rejected = yield* capability
        .execute({
          action: "call",
          namespace: "mcp",
          rootID: root.id,
          capability: "writer/publish",
          contract: described.contract,
          args: "not-an-object",
        })
        .pipe(Effect.flip)
      expect(rejected._tag).toBe("OXP_INVALID_ARGUMENT")
      expect(calls).toEqual([])
    }),
  )

  it.live(
    "executes a mutation exactly once and omits non-text payload bytes from OXP output",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      catalog = [mutationTool]
      const described = JSON.parse(
        (
          yield* capability.execute({
            action: "describe",
            namespace: "mcp",
            rootID: root.id,
            capability: "writer/publish",
          })
        ).output,
      )

      const result = yield* capability.execute({
        action: "call",
        namespace: "mcp",
        rootID: root.id,
        capability: "writer/publish",
        contract: described.contract,
        args: { value: "hello" },
      })

      expect(calls).toEqual([
        {
          server: "writer",
          tool: "publish",
          args: { value: "hello" },
        },
      ])
      expect(result.output).toBe("native text")
      expect(result.output).not.toContain("OMITTED")
      expect(result.structured).toEqual({ ok: true })
      expect(result.metadata).toMatchObject({
        omittedNonTextItems: 1,
        declaredReadOnlyHint: false,
      })
      expect(result.mutation).toEqual({
        attempted: true,
        committed: true,
      })
    }),
  )

  it.live(
    "never retries an ambiguous external mutation failure",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      catalog = [mutationTool]
      callFailure = new Error("connection dropped after send")
      const described = JSON.parse(
        (
          yield* capability.execute({
            action: "describe",
            namespace: "mcp",
            rootID: root.id,
            capability: "writer/publish",
          })
        ).output,
      )

      const failed = yield* capability
        .execute({
          action: "call",
          namespace: "mcp",
          rootID: root.id,
          capability: "writer/publish",
          contract: described.contract,
          args: { value: "hello" },
        })
        .pipe(Effect.flip)
      expect(failed._tag).toBe("OXP_AMBIGUOUS_EXTERNAL_RESULT")
      expect(calls).toHaveLength(1)
    }),
  )

  it.live(
    "preserves live authority revocation at the final network commit guard",
    Effect.gen(function* () {
      const { config, root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      catalog = [mutationTool]
      const described = JSON.parse(
        (
          yield* capability.execute({
            action: "describe",
            namespace: "mcp",
            rootID: root.id,
            capability: "writer/publish",
          })
        ).output,
      )
      beforeCommit = () =>
        Effect.runPromise(
          config
            .setGrant({ integrations: false })
            .pipe(Effect.asVoid),
        )

      const revoked = yield* capability
        .execute({
          action: "call",
          namespace: "mcp",
          rootID: root.id,
          capability: "writer/publish",
          contract: described.contract,
          args: { value: "hello" },
        })
        .pipe(Effect.flip)
      expect(revoked._tag).toBe("OXP_AUTH_REVOKED")
      expect(calls).toEqual([])
    }),
  )

  it.live(
    "preserves approved-root revocation at the final network commit guard",
    Effect.gen(function* () {
      const { roots, root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      catalog = [mutationTool]
      const described = JSON.parse(
        (
          yield* capability.execute({
            action: "describe",
            namespace: "mcp",
            rootID: root.id,
            capability: "writer/publish",
          })
        ).output,
      )
      beforeCommit = () => Effect.runPromise(roots.remove(root.id))

      const revoked = yield* capability
        .execute({
          action: "call",
          namespace: "mcp",
          rootID: root.id,
          capability: "writer/publish",
          contract: described.contract,
          args: { value: "hello" },
        })
        .pipe(Effect.flip)
      expect(revoked._tag).toBe("OXP_AUTH_REVOKED")
      expect(calls).toEqual([])
    }),
  )

  it.live(
    "does not trust a server readOnlyHint for external retry semantics",
    Effect.gen(function* () {
      const { root } = yield* prepare()
      const capability = yield* OxpCapability.Service
      catalog = [readTool]
      callFailure = new Error("temporary read outage")
      const described = JSON.parse(
        (
          yield* capability.execute({
            action: "describe",
            namespace: "mcp",
            rootID: root.id,
            capability: "alpha%2Fserver/lookup%2Fitem",
          })
        ).output,
      )

      const failed = yield* capability
        .execute({
          action: "call",
          namespace: "mcp",
          rootID: root.id,
          capability: "alpha%2Fserver/lookup%2Fitem",
          contract: described.contract,
          args: { id: "x" },
        })
        .pipe(Effect.flip)
      expect(failed._tag).toBe("OXP_AMBIGUOUS_EXTERNAL_RESULT")
      expect(calls).toHaveLength(1)
    }),
  )
})
