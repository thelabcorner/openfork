import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Plugin } from "@/plugin"
import { createToolAccessTool } from "@/tool/access"
import { withContractedBrokerArgsSchema } from "@/tool/broker-args"
import { BrokerContract } from "@/tool/broker-contract"
import { MessageID, SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    limit: { type: "integer" },
  },
  required: ["path"],
} as const

describe("compressed tool broker contract", () => {
  test("every opaque nested-args broker opts into the descriptor contract", async () => {
    const src = path.resolve(import.meta.dir, "../../src")
    const glob = new Bun.Glob("**/*.ts")
    const candidates: string[] = []

    for await (const file of glob.scan({ cwd: src, absolute: true })) {
      const text = await fs.readFile(file, "utf8")
      if (!text.includes("args: Schema.optional(Schema.Unknown)")) continue
      candidates.push(path.relative(src, file).replaceAll("\\", "/"))
      expect(text).toContain("BrokerContract.")
    }

    expect(candidates.toSorted()).toEqual(["oxp/capability.ts", "tool/access.ts", "tool/browser.ts"])
  })

  test("opaque broker args cannot be projected without a descriptor-contract field", () => {
    expect(() =>
      withContractedBrokerArgsSchema({
        type: "object",
        properties: { args: { type: "object" } },
      }),
    ).toThrow("descriptor contract")
  })

  test("is deterministic but changes with delegated instructions or schema", () => {
    const base = BrokerContract.make({
      broker: "tool",
      target: "example",
      description: "Read one thing",
      schema,
    })
    const reordered = BrokerContract.make({
      target: "example",
      broker: "tool",
      schema: {
        required: ["path"],
        properties: {
          limit: { type: "integer" },
          path: { type: "string" },
        },
        type: "object",
      },
      description: "Read one thing",
    })

    expect(base).toBe(reordered)
    expect(base).toMatch(/^broker-v1:[0-9a-f]{24}$/)
    expect(BrokerContract.make({ broker: "tool", target: "example", description: "Read TWO things", schema })).not.toBe(
      base,
    )
    expect(
      BrokerContract.make({
        broker: "tool",
        target: "example",
        description: "Read one thing",
        schema: { ...schema, required: ["path", "limit"] },
      }),
    ).not.toBe(base)
  })

  test("generic lazy broker refuses an undescribed call before touching the leaf", async () => {
    let executions = 0
    const target: Tool.Def = {
      id: "example",
      description: "Read one thing",
      parameters: Schema.Struct({ path: Schema.String }),
      execute: () => {
        executions += 1
        return Effect.succeed({ title: "example", metadata: {}, output: "ok" })
      },
    }
    const plugin = {
      trigger: () => Effect.void,
    } as unknown as Plugin.Interface
    const broker = createToolAccessTool([target], plugin)
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_broker_contract"),
      messageID: MessageID.make("msg_broker_contract"),
      callID: "call_broker_contract",
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }

    const undescribed = await Effect.runPromiseExit(
      broker.execute({ action: "call", tool: "example", args: { path: "a.txt" } }, ctx),
    )
    expect(undescribed._tag).toBe("Failure")
    expect(executions).toBe(0)

    const described = await Effect.runPromise(broker.execute({ action: "describe", tool: "example" }, ctx))
    const descriptor = JSON.parse(described.output) as {
      protocol: string
      contract: string
      inputSchema: unknown
      invocation: {
        action: string
        targetField: string
        target: string
        contractField: string
        argsField: string
      }
    }
    expect(descriptor.protocol).toBe("broker-descriptor-v1")
    expect(descriptor.inputSchema).toBeDefined()
    expect(descriptor.invocation).toEqual({
      action: "call",
      targetField: "tool",
      target: "example",
      contractField: "contract",
      argsField: "args",
    })
    const result = await Effect.runPromise(
      broker.execute({ action: "call", tool: "example", contract: descriptor.contract, args: { path: "a.txt" } }, ctx),
    )
    expect(result.output).toBe("ok")
    expect(executions).toBe(1)
  })


  test("delegated call uses the host capability gateway when the context provides one", async () => {
    let directExecutions = 0
    const delegated: Array<{ ref: string; args: unknown }> = []
    const target: Tool.Def = {
      id: "example_gateway",
      description: "Read through gateway",
      parameters: Schema.Struct({ path: Schema.String }),
      execute: () => {
        directExecutions += 1
        return Effect.succeed({ title: "direct", metadata: {}, output: "direct" })
      },
    }
    const plugin = {
      trigger: () => Effect.die("broker must not own delegated child hooks"),
    } as unknown as Plugin.Interface
    const broker = createToolAccessTool([target], plugin)
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_broker_gateway"),
      messageID: MessageID.make("msg_broker_gateway"),
      callID: "call_broker_gateway",
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
      invokeCapability: (ref, args) =>
        Effect.sync(() => {
          delegated.push({ ref, args })
          return { title: "gateway", metadata: { nested: true }, output: "gateway" }
        }),
    }

    const described = await Effect.runPromise(
      broker.execute({ action: "describe", tool: "example_gateway" }, ctx),
    )
    const contract = (JSON.parse(described.output) as { contract: string }).contract
    const result = await Effect.runPromise(
      broker.execute(
        {
          action: "call",
          tool: "example_gateway",
          contract,
          args: { path: "a.txt" },
        },
        ctx,
      ),
    )

    expect(result.output).toBe("gateway")
    expect(result.metadata).toEqual({
      nested: true,
      brokerAction: "call",
      delegatedTool: "example_gateway",
    })
    expect(directExecutions).toBe(0)
    expect(delegated).toEqual([
      { ref: "native:example_gateway", args: { path: "a.txt" } },
    ])
  })

  test("rejects a contract from another delegated descriptor", () => {
    const contract = BrokerContract.make({
      broker: "tool",
      target: "first",
      description: "First",
      schema,
    })
    expect(() =>
      BrokerContract.assertCurrent({
        broker: "tool",
        target: "second",
        description: "Second",
        schema,
        contract,
        discovery: "describe second",
      }),
    ).toThrow("descriptor contract")
  })

  test("broker descriptors project onto the shared canonical envelope", () => {
    const descriptor = BrokerContract.describe({
      broker: "tool",
      target: "example",
      targetField: "tool",
      description: "Read one thing",
      schema,
    })
    const canonical = BrokerContract.fromBrokerDescriptor(descriptor)
    expect(canonical).toEqual({
      protocol: "capability-descriptor-v1",
      ref: "tool:example",
      kind: "tool",
      description: "Read one thing",
      inputSchema: schema,
      invocation: {
        tool: "tool",
        action: "call",
        target: "example",
        argsField: "args",
        contractField: "contract",
      },
    })
  })

  test("canonical descriptors carry owner-defined kinds and hints", () => {
    const canonical = BrokerContract.toCanonicalDescriptor({
      ref: "github:api:GET /repos/{owner}/{repo}/issues",
      kind: "github-api",
      description: "List repository issues",
      inputSchema: { type: "object" },
      invocation: {
        tool: "github",
        action: "api",
        argsField: "endpoint",
        hint: '{"action":"api","endpoint":"repos/{owner}/{repo}/issues"}',
      },
    })
    expect(canonical.protocol).toBe("capability-descriptor-v1")
    expect(canonical.invocation.contractField).toBeUndefined()
  })

  test("lazy broker describe output carries the canonical envelope", async () => {
    const target: Tool.Def = {
      id: "example_canonical",
      description: "Read one canonical thing",
      parameters: Schema.Struct({ path: Schema.String }),
      execute: () => Effect.succeed({ title: "example", metadata: {}, output: "ok" }),
    }
    const plugin = {
      trigger: () => Effect.void,
    } as unknown as Plugin.Interface
    const broker = createToolAccessTool([target], plugin)
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_broker_canonical"),
      messageID: MessageID.make("msg_broker_canonical"),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }
    const described = await Effect.runPromise(broker.execute({ action: "describe", tool: "example_canonical" }, ctx))
    const descriptor = JSON.parse(described.output) as {
      protocol: string
      description: string
      inputSchema: unknown
      canonical: {
        protocol: string
        ref: string
        kind: string
        description: string
        inputSchema: unknown
        invocation: { tool: string; action: string; target: string; argsField: string; contractField: string }
      }
    }
    expect(descriptor.protocol).toBe("broker-descriptor-v1")
    expect(descriptor.canonical).toEqual({
      protocol: "capability-descriptor-v1",
      ref: "tool:example_canonical",
      kind: "tool",
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      invocation: {
        tool: "tool",
        action: "call",
        target: "example_canonical",
        argsField: "args",
        contractField: "contract",
      },
    })
  })

  test("registrations of every kind project onto the canonical envelope", () => {
    for (const [ref, kind] of [
      ["native:read", "native"],
      ["mcp:server/tool", "mcp"],
      ["mcp-resource:read", "mcp-resource"],
      ["saved:project/tool@sha256:abc", "saved"],
    ] as const) {
      const canonical = BrokerContract.fromRegistration({
        identity: { ref },
        kind,
        description: "Example capability",
        inputSchema: { type: "object" },
      })
      expect(canonical.protocol).toBe("capability-descriptor-v1")
      expect(canonical.ref).toBe(ref)
      expect(canonical.kind).toBe(kind)
      expect(canonical.invocation.tool).toBe("code")
    }
  })
})
