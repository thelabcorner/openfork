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
import { Snapshot } from "@/snapshot"
import { isCanonicalFindToolMap } from "@/session/llm/tool-call-heal"
import * as Capability from "@/tool/capability"
import * as CodeService from "@/code/service"
import { Cause, Deferred, Effect, Exit, Layer, Schema } from "effect"
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
  transformChatMessages: (messages) => Effect.succeed(messages),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
  releaseExecution: () => Effect.void,
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  writer: () =>
    Effect.succeed({
      outputPath: "output.br",
      write: () => Effect.void,
      close: Effect.void,
      healthy: () => true,
      timelineHealthy: () => false,
    }),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  retainTimeline: () => Effect.succeed(false),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const fakeInterrupt = ToolInterrupt.Service.of({
  track: (input) => Effect.succeed(input.parent),
  kill: () => Effect.succeed(false),
  release: () => Effect.void,
} satisfies ToolInterrupt.Interface)

const fakeSnapshot = Snapshot.Service.of({
  init: () => Effect.void,
  cleanup: () => Effect.void,
  track: () => Effect.succeed(undefined),
  invalidate: () => Effect.void,
  withMutation: (effect) => effect,
  diagnostics: () =>
    Effect.succeed({
      revision: 0,
      captures: 0,
      cacheHits: 0,
      invalidations: 0,
      completedReuse: false,
      watcherOwnedRoot: false,
    }),
  patch: () => Effect.die("unused"),
  restore: () => Effect.die("unused"),
  revert: () => Effect.die("unused"),
  diff: () => Effect.die("unused"),
  diffSummary: () => Effect.die("unused"),
  diffFullBounded: () => Effect.die("unused"),
  diffFull: () => Effect.die("unused"),
} as Snapshot.Interface)

const layer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  Layer.succeed(ToolInterrupt.Service, fakeInterrupt),
  Layer.succeed(Snapshot.Service, fakeSnapshot),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing"]),
      all: () => Effect.succeed([lazySqlite, lazyRefactor]),
      named: () =>
        Effect.succeed({} as unknown as Effect.Success<ReturnType<ToolRegistry.Interface["named"]>>),
      capabilities: () => Effect.succeed({ generation: "test", entries: [] }),
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

it.effect("provider tool execution fails closed without a tool-call ID", () =>
  Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: processorStub(),
      authorizedAgentNames: new Set(),
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.timing?.execute
    if (!execute) throw new Error("timing tool is missing execute")
    const exit = yield* Effect.exit(
      Effect.promise(() =>
        execute({}, { toolCallId: "", messages: [], abortSignal: new AbortController().signal }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error instanceof Error ? error.message : String(error)).toContain("provider tool-call ID")
  }),
)

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

function findLayer(
  defs: Tool.Def[],
  overrides?: { permission?: Permission.Interface; interrupt?: ToolInterrupt.Interface },
) {
  return Layer.mergeAll(
    Layer.succeed(Plugin.Service, fakePlugin),
    Layer.succeed(Permission.Service, overrides?.permission ?? fakePermission),
    Layer.succeed(MCP.Service, fakeMcp()),
    Layer.succeed(Truncate.Service, fakeTruncate),
    Layer.succeed(ToolInterrupt.Service, overrides?.interrupt ?? fakeInterrupt),
    Layer.succeed(Snapshot.Service, fakeSnapshot),
    RuntimeFlags.layer(),
    Layer.succeed(
      ToolRegistry.Service,
      ToolRegistry.Service.of({
        ids: () => Effect.succeed(defs.map((item) => item.id)),
        all: () => Effect.succeed(defs),
        named: () => Effect.succeed({} as unknown as Effect.Success<ReturnType<ToolRegistry.Interface["named"]>>),
        capabilities: () => Effect.succeed({ generation: "test", entries: [] }),
        tools: () => Effect.succeed(defs),
        refreshCustom: () => Effect.succeed({ added: [], updated: [], removed: [] }),
      }),
    ),
  )
}

const permissionGateDef = {
  id: "permission-gate",
  description: "waits on a permission request before completing",
  parameters: Schema.Struct({}),
  jsonSchema: { type: "object", properties: {} },
  execute: (_args, ctx) =>
    Effect.gen(function* () {
      yield* ctx.ask({
        permission: "external_directory",
        patterns: ["/outside"],
        always: [],
        metadata: {},
      })
      return { title: "permission-gate", metadata: {}, output: "ok" }
    }),
} satisfies Tool.Def

function processorStub(): Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall"> {
  return {
    message: {
      id: MessageID.ascending(),
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
    },
    updateToolCall: () => Effect.die("unused"),
    completeToolCall: () => Effect.void,
  }
}

const canonicalFindDef = findDef("canonical find")
const canonicalFindIt = testEffect(findLayer([canonicalFindDef]))
const shadowedFindIt = testEffect(findLayer([canonicalFindDef, findDef("custom find")]))

const fanoutLeaf: Capability.Registration = {
  identity: Capability.nativeIdentity("fanout_leaf"),
  kind: "native",
  description: "Return the requested fan-out index.",
  inputSchema: {
    type: "object",
    properties: { index: { type: "number" } },
    required: ["index"],
    additionalProperties: false,
  },
  invokeSemantic: (args) =>
    Effect.succeed({
      title: "fanout_leaf",
      metadata: {},
      output: JSON.stringify(args),
      data: args,
    }),
  authorize: () => Effect.void,
  authorityBinding: "native:fanout_leaf:v1",
  classifyWorkspaceMutation: () => false,
  codeCallable: true,
  lifetime: "inline",
}

const codeFanoutDef = {
  id: "code",
  description: "Test-only Code root using the production CodeService gateway.",
  parameters: Schema.Struct({ count: Schema.Number }),
  jsonSchema: {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
    additionalProperties: false,
  },
  execute: (args, ctx) =>
    Effect.gen(function* () {
      if (!ctx.captureCapabilities) return yield* Effect.die("missing capability capture")
      const inventory = yield* ctx.captureCapabilities()
      const result = yield* CodeService.runInline({
        code: [
          "const pending = []",
          "for (let index = 0; index < input.count; index++) {",
          '  pending.push(call("native:fanout_leaf", { index }))',
          "}",
          "return await Promise.all(pending)",
        ].join("\n"),
        value: args,
        ctx,
        inventory,
        services: {
          permission: fakePermission,
          plugin: fakePlugin,
          snapshot: fakeSnapshot,
          interrupt: fakeInterrupt,
        },
      })
      return {
        title: "code",
        metadata: { trace: result.trace },
        output: JSON.stringify(result.envelope),
        data: result.envelope,
      }
    }),
} satisfies Tool.Def

const codePersistenceLayer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  Layer.succeed(ToolInterrupt.Service, fakeInterrupt),
  Layer.succeed(Snapshot.Service, fakeSnapshot),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["code"]),
      all: () => Effect.succeed([codeFanoutDef]),
      named: () => Effect.succeed({} as unknown as Effect.Success<ReturnType<ToolRegistry.Interface["named"]>>),
      capabilities: () =>
        Effect.succeed({
          generation: "fanout-test",
          entries: [fanoutLeaf],
          byRef: new Map([[fanoutLeaf.identity.ref, fanoutLeaf]]),
        }),
      tools: () => Effect.succeed([codeFanoutDef]),
      refreshCustom: () => Effect.succeed({ added: [], updated: [], removed: [] }),
    }),
  ),
)

const codePersistenceIt = testEffect(codePersistenceLayer)

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
      authorizedAgentNames: new Set(),
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
      authorizedAgentNames: new Set(),
      messages: [],
      promptOps: {} as never,
    })

    expect(Object.keys(tools)).toEqual(["find"])
    expect(isCanonicalFindToolMap(tools)).toBe(false)
    expect(tools.find.description).toBe("custom find")
  }),
)

codePersistenceIt.effect("keeps 1-leaf and 100-leaf Code roots on one durable ToolPart identity", () =>
  Effect.gen(function* () {
    for (const count of [1, 100]) {
      const rootCallID = `call-code-root-${count}`
      const rootPartID = PartID.ascending()
      let state: SessionV1.ToolPart = {
        id: rootPartID,
        sessionID,
        messageID,
        type: "tool",
        tool: "code",
        callID: rootCallID,
        state: { status: "running", input: { count }, time: { start: 100 } },
      }
      const persistedCallIDs: string[] = []
      const persistedPartIDs: string[] = []

      const processor = {
        ...processorStub(),
        message: { ...processorStub().message, id: messageID, sessionID },
        toolPartID: (toolCallID: string) => (toolCallID === rootCallID ? rootPartID : undefined),
        updateToolCall: (toolCallID: string, update: (part: SessionV1.ToolPart) => SessionV1.ToolPart) =>
          Effect.sync(() => {
            persistedCallIDs.push(toolCallID)
            state = update(state)
            persistedPartIDs.push(state.id)
            return state
          }),
      } satisfies Pick<
        SessionProcessor.Handle,
        "message" | "updateToolCall" | "completeToolCall" | "toolPartID"
      >

      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor,
        authorizedAgentNames: new Set(),
        messages: [],
        promptOps: {} as never,
      })
      const execute = tools.code.execute
      if (!execute) throw new Error("code tool is missing execute")

      const result = (yield* Effect.promise(() =>
        execute(
          { count },
          {
            toolCallId: rootCallID,
            abortSignal: new AbortController().signal,
            messages: [],
          },
        ),
      )) as { data?: unknown }

      expect((result.data as { ok?: boolean }).ok).toBe(true)
      expect(persistedCallIDs.length).toBeGreaterThan(0)
      expect(new Set(persistedCallIDs)).toEqual(new Set([rootCallID]))
      expect(new Set(persistedPartIDs)).toEqual(new Set([rootPartID]))
    }
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
    expect(context).toContain("Contract: broker-v1:")
    expect(context).toContain('"contract":"broker-v1:')
    expect(context).not.toContain("@missing")
    expect(context).not.toContain("Tool: @refactor")
  }),
)

it.effect("provides compact routing for direct @tool mentions without duplicating schemas", () =>
  Effect.gen(function* () {
    const context = yield* SessionTools.explicitLazyToolContext({
      agent,
      text: "Use @timing and @sqlite; user@example.com is an email, not a mention.",
      providerTools: { timing: { description: "Read timing metadata.\nAdditional internal instructions." }, tool: {} },
    })
    expect(context).toContain("Tool: @timing")
    expect(context).toContain("Description: Read timing metadata.")
    expect(context).toContain("provider-visible `timing` tool directly")
    expect(context).toContain("Tool: @sqlite")
    expect(context).toContain('"contract":"broker-v1:')
    expect(context).not.toContain("Additional internal instructions")
    expect(context).not.toContain("user@example.com")
    expect(context?.match(/Tool: @timing/g)).toHaveLength(1)
  }),
)

it.effect("resolves mentions against the actual native Session provider tool map", () =>
  Effect.gen(function* () {
    const providerTools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: processorStub(),
      authorizedAgentNames: new Set(),
      messages: [],
      promptOps: {} as never,
    })
    const context = yield* SessionTools.explicitToolMentionContext({
      agent,
      text: "Use @timing. Do not call @not_registered.",
      providerTools,
    })
    expect(context).toContain("Tool: @timing")
    expect(context).toContain("provider-visible `timing` tool directly")
    expect(context).not.toContain("Tool: @not_registered")
  }),
)

it.effect("does not advertise absent or permission-denied direct tools", () =>
  Effect.gen(function* () {
    const context = yield* SessionTools.explicitLazyToolContext({
      agent,
      text: "Use @timing @sqlite @general @missing",
      permission: [{ permission: "timing", pattern: "*", action: "deny" }],
      providerTools: { timing: { description: "Read timing metadata" } },
    })
    expect(context).not.toContain("Tool: @timing")
    expect(context).not.toContain("Tool: @general")
    expect(context).not.toContain("Tool: @missing")
    expect(context).toContain("Tool: @sqlite")
  }),
)

it.effect("does not mistake prototype keys for registered tools", () =>
  Effect.gen(function* () {
    const context = yield* SessionTools.explicitLazyToolContext({
      agent,
      text: "Do not invoke @constructor, @__proto__, or @toString.",
      providerTools: { timing: { description: "Read timing metadata." } },
    })
    expect(context).toBeUndefined()
  }),
)

it.effect("handles trailing punctuation while preserving registered dotted tool ids", () =>
  Effect.gen(function* () {
    const context = yield* SessionTools.explicitLazyToolContext({
      agent,
      text: "Use @sqlite. Then @vendor.inspect. Finally @vendor.inspect.",
      providerTools: { "vendor.inspect": { description: "Inspect a remote provider." } },
    })
    expect(context).toContain("Tool: @sqlite")
    expect(context).toContain("Tool: @vendor.inspect")
    expect(context?.match(/Tool: @vendor\.inspect/g)).toHaveLength(1)
    expect(context).not.toContain("Tool: @vendor.inspect.")
  }),
)

it.effect("excludes exactly structured file/agent mentions, not an identically named typed tool", () =>
  Effect.gen(function* () {
    const text = "Review @timing and ask @general; then use @timing."
    const fileStart = text.indexOf("@timing")
    const agentStart = text.indexOf("@general")
    const context = yield* SessionTools.explicitLazyToolContext({
      agent,
      text,
      providerTools: { timing: { description: "Read timing metadata." } },
      excludedMentions: [
        { value: "@timing", start: fileStart, end: fileStart + 7 },
        { value: "@general", start: agentStart, end: agentStart + 8 },
        { value: "@timing", start: 0, end: 7 }, // mismatched span must not exclude anything
      ],
    })
    expect(context).toContain("Tool: @timing")
    expect(context?.match(/Tool: @timing/g)).toHaveLength(1)
    expect(context).not.toContain("Tool: @general")
    const suppressed = yield* SessionTools.explicitLazyToolContext({
      agent,
      text: "Review @timing",
      providerTools: { timing: { description: "Read timing metadata." } },
      excludedMentions: [{ value: "@timing", start: 7, end: 14 }],
    })
    expect(suppressed).toBeUndefined()
  }),
)

it.effect("keeps direct tool routing even when the lazy broker itself is denied", () =>
  Effect.gen(function* () {
    const context = yield* SessionTools.explicitLazyToolContext({
      agent,
      text: "Use @timing and @sqlite.",
      permission: [{ permission: "tool", pattern: "*", action: "deny" }],
      providerTools: { timing: { description: "Read timing metadata." } },
    })
    expect(context).toContain("Tool: @timing")
    expect(context).not.toContain("Tool: @sqlite")
  }),
)

it.effect("falls back to lazy describe when a descriptor exceeds the request context budget", () =>
  Effect.gen(function* () {
    const original = yield* ToolRegistry.Service
    const oversized = {
      ...lazySqlite,
      id: "oversized",
      description: "Inspect large datasets. " + "a".repeat(49_000),
    } satisfies Tool.Def
    const registry = ToolRegistry.Service.of({
      ...original,
      all: () => Effect.succeed([oversized]),
    })
    const context = yield* SessionTools.explicitLazyToolContext({
      agent,
      text: "Please inspect with @oversized.",
      providerTools: { tool: {} },
    }).pipe(Effect.provideService(ToolRegistry.Service, registry))
    expect(context).toContain("Tool: @oversized")
    expect(context).toContain('"action":"describe","tool":"oversized"')
    expect(context).toContain("The descriptor was not pre-seeded")
    expect(context).not.toContain("Contract: broker-v1:")
    expect(context!.length).toBeLessThan(3_000)
  }),
)

it.effect("does not hydrate the tool registry on turns without valid tool tokens", () =>
  Effect.gen(function* () {
    const current = yield* ToolRegistry.Service
    const guarded = ToolRegistry.Service.of({
      ...current,
      all: () => Effect.die(new Error("unused registry enumeration")),
    })
    for (const text of ["Review this code.", "Email user@example.com about it.", "See /home/@sqlite/config"]) {
      const context = yield* SessionTools.explicitLazyToolContext({
        agent,
        text,
        providerTools: { timing: {} },
      }).pipe(Effect.provideService(ToolRegistry.Service, guarded))
      expect(context).toBeUndefined()
    }
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
      authorizedAgentNames: new Set(),
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
      authorizedAgentNames: new Set(),
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


it.effect("propagates the parent tool AbortSignal into the detached Effect root", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const controller = new AbortController()
    let finalized = false
    const blockingDef = {
      id: "blocking",
      description: "blocks until the tool root is interrupted",
      parameters: Schema.Struct({}),
      jsonSchema: { type: "object", properties: {} },
      execute: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true
            }),
          ),
        ),
    } satisfies Tool.Def

    yield* Effect.gen(function* () {
      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor: processorStub(),
        authorizedAgentNames: new Set(),
        messages: [],
        promptOps: {} as never,
      })
      const execute = tools.blocking.execute
      if (!execute) throw new Error("blocking tool is missing execute")

      const pending = execute(
        {},
        {
          toolCallId: "blocking-call",
          abortSignal: controller.signal,
          messages: [],
        },
      ).then(
        () => "resolved" as const,
        () => "rejected" as const,
      )

      yield* Deferred.await(started)
      controller.abort()

      expect(yield* Effect.promise(() => pending)).toBe("rejected")
      expect(finalized).toBe(true)
    }).pipe(Effect.provide(findLayer([blockingDef])))
  }),
)

it.effect("per-tool kill interrupts a pending permission wait without aborting the parent turn", () =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<void>()
    const parent = new AbortController()
    const child = new AbortController()
    let permissionFinalized = false

    const permission = Permission.Service.of({
      ask: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(asked, undefined)
          return yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              permissionFinalized = true
            }),
          ),
        ),
      reply: () => Effect.void,
      list: () => Effect.succeed([]),
      releaseExecution: () => Effect.void,
    } satisfies Permission.Interface)
    const interrupt = ToolInterrupt.Service.of({
      track: () => Effect.succeed(child.signal),
      kill: () =>
        Effect.sync(() => {
          if (child.signal.aborted) return false
          child.abort()
          return true
        }),
      release: () => Effect.void,
    } satisfies ToolInterrupt.Interface)

    yield* Effect.gen(function* () {
      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session: { id: sessionID, permission: [] } as unknown as Session.Info,
        processor: processorStub(),
        authorizedAgentNames: new Set(),
        messages: [],
        promptOps: {} as never,
      })
      const execute = tools[permissionGateDef.id].execute
      if (!execute) throw new Error("permission-gate tool is missing execute")

      const pending = execute(
        {},
        {
          toolCallId: "permission-call",
          abortSignal: parent.signal,
          messages: [],
        },
      ).then(
        () => "resolved" as const,
        () => "rejected" as const,
      )

      yield* Deferred.await(asked)
      expect(parent.signal.aborted).toBe(false)
      expect(yield* interrupt.kill({ sessionID, callID: "permission-call" })).toBe(true)

      expect(yield* Effect.promise(() => pending)).toBe("rejected")
      expect(permissionFinalized).toBe(true)
      expect(parent.signal.aborted).toBe(false)
    }).pipe(Effect.provide(findLayer([permissionGateDef], { permission, interrupt })))
  }),
)
