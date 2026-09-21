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
})
