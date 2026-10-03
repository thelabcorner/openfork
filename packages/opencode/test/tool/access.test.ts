import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { ToolRegistry } from "@/tool/registry"
import { TOOL_ACCESS_ID } from "../../src/tool/access"
import { BUILTIN_LAZY_TOOL_IDS } from "../../src/tool/exposure"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node])))

const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
const lazyIDs = [...BUILTIN_LAZY_TOOL_IDS]

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_lazy_tools"),
  messageID: MessageID.make("msg_lazy_tools"),
  callID: "call_lazy_tools",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("optional tool access", () => {
  it.instance("heavy tools stay registered but are omitted from the default model toolset", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      for (const id of lazyIDs) expect(ids).toContain(id)

      const tools = yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })
      const visible = tools.map((tool) => tool.id)
      expect(visible).toContain(TOOL_ACCESS_ID)
      for (const id of lazyIDs) expect(visible).not.toContain(id)
    }),
  )

  it.instance("broker schema stays small and never embeds hidden tool schemas", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })
      const broker = tools.find((tool) => tool.id === TOOL_ACCESS_ID)
      expect(broker).toBeDefined()
      const schema = ToolJsonSchema.fromTool(broker!)
      const wire = JSON.stringify(schema)
      expect(wire.length).toBeLessThan(2000)
      expect((schema.properties?.args as { type?: string } | undefined)?.type).toBe("object")
      expect(wire).not.toContain("previewId")
      expect(wire).not.toContain("timeoutMs")
      expect(wire).not.toContain("attach")
    }),
  )

  it.instance("list discovers lazy capabilities without exposing their schemas", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({ providerID: "opencode" as any, modelID: "gpt-5" as any, agent })
      const broker = tools.find((tool) => tool.id === TOOL_ACCESS_ID)!
      const result = yield* broker.execute({ action: "list" }, ctx)
      for (const id of lazyIDs) expect(result.output).toContain(`- ${id}:`)
      expect(result.metadata.brokerAction).toBe("list")
    }),
  )

  it.instance("diagnoses delegated actions placed at the broker level without guessing or executing", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({ providerID: "opencode" as any, modelID: "gpt-5" as any, agent })
      const broker = tools.find((tool) => tool.id === TOOL_ACCESS_ID)!

      const exit = yield* Effect.exit(broker.execute({ action: "delegate" } as never, ctx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain('"delegate" is not a broker action')
        expect(message).toContain("list, describe, and call")
        expect(message).toContain('args={action:"delegate"')
        expect(message).toContain("No target tool or missing arguments were inferred or executed")
      }
    }),
  )

  it.instance("describe returns the hidden schema as result content without changing the manifest", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({ providerID: "opencode" as any, modelID: "gpt-5" as any, agent })
      const broker = tools.find((tool) => tool.id === TOOL_ACCESS_ID)!
      const result = yield* broker.execute({ action: "describe", tool: "sqlite" }, ctx)
      expect(result.output).toContain('"tool": "sqlite"')
      expect(result.output).toContain('"parameters"')
      expect(result.output).toContain('"contract": "broker-v1:')
      expect(result.output).toContain('contract set to the exact value above')

      const after = yield* registry.tools({ providerID: "opencode" as any, modelID: "gpt-5" as any, agent })
      expect(after.map((tool) => tool.id)).toEqual(tools.map((tool) => tool.id))
    }),
  )

  it.instance("call delegates through the real hidden tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({ providerID: "opencode" as any, modelID: "gpt-5" as any, agent })
      const broker = tools.find((tool) => tool.id === TOOL_ACCESS_ID)!
      const described = JSON.parse((yield* broker.execute({ action: "describe", tool: "sqlite" }, ctx)).output)
      const result = yield* broker.execute(
        {
          action: "call",
          tool: "sqlite",
          contract: described.contract,
          args: { action: "run", db: "lazy.db", sql: "CREATE TABLE t (x INTEGER)" },
        },
        ctx,
      )
      expect(result.metadata.delegatedTool).toBe("sqlite")
      expect(result.metadata.brokerAction).toBe("call")
      expect(result.metadata.action).toBe("run")
      expect(result.output).toContain("schema changed")
      expect(result.output).toContain("rolled back")
    }),
  )

  it.instance("call accepts a JSON-encoded object from models that stringify broker args", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({ providerID: "opencode" as any, modelID: "gpt-5" as any, agent })
      const broker = tools.find((tool) => tool.id === TOOL_ACCESS_ID)!
      const described = JSON.parse((yield* broker.execute({ action: "describe", tool: "sqlite" }, ctx)).output)
      const result = yield* broker.execute(
        {
          action: "call",
          tool: "sqlite",
          contract: described.contract,
          args: JSON.stringify({ action: "run", db: "lazy-string.db", sql: "CREATE TABLE t (x INTEGER)" }),
        },
        ctx,
      )
      expect(result.metadata.delegatedTool).toBe("sqlite")
      expect(result.metadata.brokerAction).toBe("call")
      expect(result.output).toContain("schema changed")
    }),
  )

  it.instance("refuses speculative calls that did not load the current hidden descriptor", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({ providerID: "opencode" as any, modelID: "gpt-5" as any, agent })
      const broker = tools.find((tool) => tool.id === TOOL_ACCESS_ID)!
      const exit = yield* Effect.exit(
        broker.execute(
          { action: "call", tool: "sqlite", args: { action: "query", db: "missing.db", sql: "SELECT 1" } },
          ctx,
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.pretty(exit.cause)
        expect(message).toContain("descriptor contract")
        expect(message).toContain('action="describe"')
      }
    }),
  )
})
