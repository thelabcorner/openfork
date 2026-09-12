import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { ToolInterrupt } from "@/tool/interrupt"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { isCanonicalFindToolMap } from "@/session/llm/tool-call-heal"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

const lazySqlite = {
  id: "sqlite",
  description: "Run bounded SQLite inspection operations.",
  parameters: Schema.Struct({ action: Schema.String, query: Schema.optional(Schema.String) }),
  jsonSchema: {
    type: "object",
    properties: { action: { type: "string" }, query: { type: "string" } },
    required: ["action"],
  },
  exposure: "lazy" as const,
  execute: () => Effect.succeed({ title: "sqlite", metadata: {}, output: "ok" }),
} satisfies Tool.Def

const lazyRefactor = {
  id: "refactor",
  description: "Perform structured refactoring operations.",
  parameters: Schema.Struct({ action: Schema.String }),
  jsonSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
  exposure: "lazy" as const,
  execute: () => Effect.succeed({ title: "refactor", metadata: {}, output: "ok" }),
} satisfies Tool.Def

const toolBroker = {
  id: "tool",
  description: "Access optional lazy tools.",
  parameters: Schema.Struct({ action: Schema.String }),
  jsonSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
  execute: () => Effect.succeed({ title: "tool", metadata: {}, output: "ok" }),
} satisfies Tool.Def

function fakeMcp() {
  return MCP.Service.of({
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const fakeInterrupt = ToolInterrupt.Service.of({
  track: (input) => Effect.succeed(input.parent),
  kill: () => Effect.succeed(false),
  release: () => Effect.void,
} satisfies ToolInterrupt.Interface)

const layer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  Layer.succeed(ToolInterrupt.Service, fakeInterrupt),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing"]),
      all: () => Effect.succeed([lazySqlite, lazyRefactor]),
      named: () =>
        Effect.succeed({} as unknown as Effect.Success<ReturnType<ToolRegistry.Interface["named"]>>),
      tools: (_model: Parameters<ToolRegistry.Interface["tools"]>[0]) =>
        Effect.succeed([
          toolBroker,
          {
            id: "timing",
            description: "updates metadata more than once",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.metadata({ metadata: { output: "first" } })
                // Progress metadata is throttled (wall-clock): sleep past the
                // window with a real timer — Effect.sleep would only advance
                // the TestClock, not Date.now().
                yield* Effect.promise(() => Bun.sleep(600))
                yield* ctx.metadata({ metadata: { output: "second" } })
                return { title: "timing", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
          {
            id: "burst",
            description: "fires rapid metadata updates like a chatty shell",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                for (let index = 0; index < 20; index++) {
                  yield* ctx.metadata({ metadata: { output: `chunk-${index}` } })
                }
                return { title: "burst", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
        ]),
      refreshCustom: () => Effect.succeed({ added: [], updated: [], removed: [] }),
    }),
  ),
)

const it = testEffect(layer)

function findDef(label: string): Tool.Def {
  return {
    id: "find",
    description: label,
    parameters: Schema.Struct({ glob: Schema.optional(Schema.String), grep: Schema.optional(Schema.String) }),
    jsonSchema: {
      type: "object",
      properties: { glob: { type: "string" }, grep: { type: "string" } },
    },
    execute: () => Effect.succeed({ title: label, metadata: {}, output: label }),
  }
}

function findLayer(defs: Tool.Def[]) {
  return Layer.mergeAll(
    Layer.succeed(Plugin.Service, fakePlugin),
    Layer.succeed(Permission.Service, fakePermission),
    Layer.succeed(MCP.Service, fakeMcp()),
    Layer.succeed(Truncate.Service, fakeTruncate),
    Layer.succeed(ToolInterrupt.Service, fakeInterrupt),
    RuntimeFlags.layer(),
    Layer.succeed(
      ToolRegistry.Service,
      ToolRegistry.Service.of({
        ids: () => Effect.succeed(defs.map((item) => item.id)),
        all: () => Effect.succeed(defs),
        named: () => Effect.succeed({} as unknown as Effect.Success<ReturnType<ToolRegistry.Interface["named"]>>),
        tools: () => Effect.succeed(defs),
        refreshCustom: () => Effect.succeed({ added: [], updated: [], removed: [] }),
      }),
    ),
  )
}

const canonicalFindDef = findDef("canonical find")
const canonicalFindIt = testEffect(findLayer([canonicalFindDef]))
const shadowedFindIt = testEffect(findLayer([canonicalFindDef, findDef("custom find")]))

it.effect("extracts intentional tool mentions without treating email or npm scopes as capabilities", () =>
  Effect.sync(() => {
    expect(
      SessionTools.explicitToolMentions(
        "Use @sqlite, mail user@example.com, install @scope/pkg@latest, then try (@refactor). Use @sqlite again.",
      ),
    ).toEqual(["sqlite", "refactor"])
  }),
)

canonicalFindIt.effect("marks SessionTools output only when builtin find remains the resolved find tool", () =>
  Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: {
        message: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: 1 },
        } satisfies SessionV1.Assistant,
        updateToolCall: () => Effect.die("unused"),
        completeToolCall: () => Effect.die("unused"),
      },
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })

    expect(Object.keys(tools)).toEqual(["find"])
    expect(isCanonicalFindToolMap(tools)).toBe(true)
  }),
)

shadowedFindIt.effect("does not mark SessionTools output when a custom find shadows builtin find", () =>
  Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: {
        message: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: 1 },
        } satisfies SessionV1.Assistant,
        updateToolCall: () => Effect.die("unused"),
        completeToolCall: () => Effect.die("unused"),
      },
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })

    expect(Object.keys(tools)).toEqual(["find"])
    expect(isCanonicalFindToolMap(tools)).toBe(false)
    expect(tools.find.description).toBe("custom find")
  }),
)

it.effect("pre-seeds an explicitly mentioned lazy tool schema for direct broker invocation", () =>
  Effect.gen(function* () {
    const context = yield* SessionTools.explicitLazyToolContext({
      agent,
      text: "Use @sqlite for this database inspection. Ignore @missing.",
    })

    expect(context).toContain("<explicit-tool-mention-context>")
    expect(context).toContain("Tool: @sqlite")
    expect(context).toContain('"action"')
    expect(context).toContain('"tool":"sqlite"')
    expect(context).not.toContain("@missing")
    expect(context).not.toContain("Tool: @refactor")
  }),
)

it.effect("does not pre-seed a lazy tool denied by the active agent", () =>
  Effect.gen(function* () {
    const context = yield* SessionTools.explicitLazyToolContext({
      agent: {
        ...agent,
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "sqlite", pattern: "*", action: "deny" },
        ],
      },
      text: "Use @sqlite.",
    })
    expect(context).toBeUndefined()
  }),
)

it.effect("does not pre-seed a lazy tool denied by the session ruleset", () =>
  Effect.gen(function* () {
    const context = yield* SessionTools.explicitLazyToolContext({
      agent,
      permission: [{ permission: "sqlite", pattern: "*", action: "deny" }],
      text: "Use @sqlite.",
    })
    expect(context).toBeUndefined()
  }),
)

it.effect("filters session-denied lazy tools from the discovery catalog", () =>
  Effect.gen(function* () {
    const catalog = yield* SessionTools.catalog({
      agent,
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("test-model"),
      permission: [{ permission: "sqlite", pattern: "*", action: "deny" }],
    })
    expect(catalog.some((item) => item.id === "sqlite")).toBe(false)
    expect(catalog.some((item) => item.id === "refactor")).toBe(true)
  }),
)

it.effect("preserves running tool start time across metadata updates", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    const updates: number[] = []
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          const next = update(state)
          state.state = next.state
          if (state.state.status === "running") updates.push(state.state.time.start)
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(updates).toEqual([100, 100])
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
    }
  }),
)

it.effect("coalesces rapid tool progress metadata updates", () =>
  Effect.gen(function* () {
    const seen: string[] = []
    const running: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "burst",
      callID,
      state: { status: "running", input: {}, time: { start: 100 } },
    }
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID: string, update: (_part: SessionV1.ToolPart) => SessionV1.ToolPart) =>
        Effect.sync(() => {
          const next = update(running)
          running.state = next.state
          if (next.state.status === "running" && "metadata" in next.state) {
            seen.push(JSON.stringify((next.state as { metadata: unknown }).metadata))
          }
          return next
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.burst.execute
    if (!execute) throw new Error("burst tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: "burst-call",
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    // 20 back-to-back progress updates on one call must not produce 20
    // publishes; the leading update always goes through immediately.
    expect(seen.length).toBeLessThan(20)
    expect(seen[0]).toBe(JSON.stringify({ output: "chunk-0" }))
  }),
)
