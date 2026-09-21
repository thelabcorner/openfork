import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { clearPersistedMotifs } from "../../src/session/spad/pattern-store"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionTurnProvenance as CurrentTurnProvenance } from "@opencode-ai/core/session/turn-provenance"
import { SpecialAgentSession } from "@opencode-ai/core/special-agent-session"
import { SpadAuditor } from "@opencode-ai/core/spad-auditor"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { ToolInterrupt } from "@/tool/interrupt"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, buildLocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Goal } from "@opencode-ai/core/goal"
import { GoalContext } from "@opencode-ai/core/goal/context"
import { GoalProjection } from "@opencode-ai/core/goal/projection"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Model } from "@opencode-ai/llm"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      exactTools: () => Effect.succeed([]),
      invokeTool: () => Effect.die("unexpected MCP tool invocation in prompt-effect tests"),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

let goalAuditorBaseURL = "http://127.0.0.1:1/v1"
const goalAuditorModel = () =>
  Model.make({
    id: "test-model",
    provider: "test",
    route: OpenAICompatibleChat.route.with({
      endpoint: { baseURL: goalAuditorBaseURL },
      limits: { context: 100_000, output: 10_000 },
    }),
  })
const goalAuditorModels = SessionRunnerModel.layerWith(
  () => Effect.succeed(goalAuditorModel()),
  () => Effect.succeed(goalAuditorModel()),
)
const testLocationServiceMap = buildLocationServiceMap([[SessionRunnerModel.node, goalAuditorModels]])
const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Goal.node,
  GoalContext.node,
  GoalAutomation.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  ToolInterrupt.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

function makePrompt(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  return makePrompt(input)
}

function makeGoalHttp() {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  return LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
    [locationServiceMapNode, testLocationServiceMap],
  ] as const)
}

const it = testEffect(makeHttp())
const goalIt = testEffect(makeGoalHttp())
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

// Mirrors the SPAD gym's canonical-only drift fixture. It deterministically
// queues exactly one gray-zone `canonical-period` audit case without entering
// the destructive raw-repetition recovery lane.
function canonicalSpadAuditDrift(lines = 36) {
  let x = 0xc4110a1 >>> 0
  const random = () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x >>> 0
  }
  const base = "The controller should re anchor to the user request and continue differently."
  return Array.from({ length: lines }, () => {
    let out = ""
    for (const ch of base) {
      if (ch === " ") {
        const spaces = [" ", "  ", "\t", "\n", " \t "]
        out += spaces[random() % spaces.length]!
        continue
      }
      if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) {
        out += (random() & 1) === 0 ? ch.toLowerCase() : ch.toUpperCase()
        continue
      }
      out += ch
    }
    return out
  }).join("\n")
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function providerSystemText(body: Record<string, unknown>) {
  const messages = body.messages
  if (!Array.isArray(messages)) return ""
  return messages
    .filter((message): message is { role: string; content?: unknown } => !!message && typeof message === "object" && "role" in message)
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")))
    .join("\n")
}

function providerRoleTexts(body: Record<string, unknown>, role: string) {
  const messages = body.messages
  if (!Array.isArray(messages)) return [] as string[]
  return messages
    .filter(
      (message): message is { role: string; content?: unknown } =>
        !!message && typeof message === "object" && "role" in message,
    )
    .filter((message) => message.role === role)
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")))
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

noLLMServer.instance(
  "rejects direct user prompts to host-owned child Sessions before message admission",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({
        parentID: parent.id,
        title: "Goal Auditor child",
        metadata: { specialAgent: "goal_auditor", goalID: "goal_test" },
      })

      const exit = yield* prompt
        .prompt({
          sessionID: child.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "please change the implementation" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionPrompt.HostOwnedSessionError",
          sessionID: child.id,
          parentID: parent.id,
          kind: "goal_auditor",
        })
      }
      expect(yield* sessions.messages({ sessionID: child.id })).toHaveLength(0)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "scheduled-task root Sessions remain user-drivable while trusted host admission stays fenced",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Scheduled run",
        metadata: { scheduledTaskID: "stk_prompt_test", scheduledTaskRunID: "str_prompt_test" },
      })

      const hostExit = yield* prompt
        .hostPrompt({
          sessionID: chat.id,
          noReply: true,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "generic host takeover" }],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(hostExit)).toBe(true)
      if (Exit.isFailure(hostExit)) {
        expect(Cause.squash(hostExit.cause)).toMatchObject({
          _tag: "SessionPrompt.HostOwnedSessionError",
          kind: "scheduled_task",
        })
      }
      expect(yield* sessions.messages({ sessionID: chat.id })).toHaveLength(0)

      const admitted = yield* prompt.hostPrompt(
        {
          sessionID: chat.id,
          noReply: true,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "scheduled work" }],
        },
        { source: SessionTurnProvenance.Source.ScheduledTaskRun, ref: "str_prompt_test" },
      )
      expect(admitted.info.role).toBe("user")
      if (admitted.info.role !== "user") throw new Error("Expected scheduled host admission to produce a user-role turn")
      expect(admitted.info.provenance).toEqual({
        owner: "host",
        source: SessionTurnProvenance.Source.ScheduledTaskRun,
        ref: "str_prompt_test",
      })

      const user = yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "follow up on that scheduled work" }],
      })
      expect(user.info.role).toBe("user")
      if (user.info.role !== "user") throw new Error("Expected direct scheduled-session prompt to produce a user-role turn")
      expect(user.info.provenance).toEqual({
        owner: "user",
        source: SessionTurnProvenance.Source.Prompt,
      })
      expect(yield* sessions.messages({ sessionID: chat.id })).toHaveLength(2)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "malformed scheduled-task origin stays fail-closed for user prompting",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Malformed Scheduled run",
        // New task-owned Scheduled Sessions validly carry scheduledTaskID
        // without a run id. The corrupt case is a protected run correlation
        // with no owning task aggregate.
        metadata: { scheduledTaskRunID: "str_missing_task" },
      })

      const exit = yield* prompt
        .prompt({
          sessionID: chat.id,
          noReply: true,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "must not downgrade producer ownership" }],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionPrompt.HostOwnedSessionError",
          kind: "scheduled_task",
        })
      }
      expect(yield* sessions.messages({ sessionID: chat.id })).toHaveLength(0)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "derived host admission cannot resurrect a stale worker root",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Derived host causality" })

      const first = yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first objective" }],
      })
      const second = yield* prompt.prompt({
        sessionID: chat.id,
        noReply: true,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "newer objective" }],
      })

      const stale = yield* prompt
        .hostPrompt(
          {
            sessionID: chat.id,
            noReply: true,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "late background result" }],
          },
          {
            source: SessionTurnProvenance.Source.TaskSummary,
            sourceMessageID: first.info.id,
            ref: "ses_background_child",
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)
      if (Exit.isFailure(stale)) {
        expect(String(Cause.squash(stale.cause))).toContain("stale worker root")
      }

      const current = yield* prompt.hostPrompt(
        {
          sessionID: chat.id,
          noReply: true,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "current background result" }],
        },
        {
          source: SessionTurnProvenance.Source.TaskSummary,
          sourceMessageID: second.info.id,
          ref: "ses_background_child",
        },
      )
      if (current.info.role !== "user") throw new Error("expected host prompt to lower through the V1 user role")
      expect(current.info.provenance).toEqual({
        owner: "host",
        source: SessionTurnProvenance.Source.TaskSummary,
        sourceMessageID: second.info.id,
        ref: "ses_background_child",
      })
    }),
  { config: cfg },
)

noLLMServer.instance(
  "trusted Goal action admission is a retry-idempotent worker root without Goal-creation authority",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const chat = yield* sessions.create({ title: "Goal action admission" })
      const created = yield* goals
        .create({
          projectID: chat.projectID,
          title: "Retry reactivation",
          objective: "Repair blocked Goal state on idempotent user-action admission",
          criteria: ["The blocked Goal is reactivated"],
          continuationPolicy: { mode: "auto_continue" },
        })
        .pipe(Effect.orDie)
      const active = yield* goals
        .transition({ id: created.goal.id, expectedRevision: created.goal.revision, action: "start" })
        .pipe(Effect.orDie)
      yield* goals.focus({ goalID: active.goal.id, sessionID: chat.id }).pipe(Effect.orDie)
      yield* goals
        .transition({
          id: active.goal.id,
          expectedRevision: active.goal.revision,
          action: "block",
          blocker: "Waiting for the trusted user action",
        })
        .pipe(Effect.orDie)
      const messageID = MessageID.make("msg_goal_action_start_goal_test_7")
      const input = {
        sessionID: chat.id,
        messageID,
        noReply: true,
        agent: "build",
        model: ref,
        parts: [{ type: "text" as const, text: "Begin the focused Goal." }],
      }

      const first = yield* prompt.userActionPrompt(input, { source: SessionTurnProvenance.Source.GoalStart })
      expect((yield* goals.get(created.goal.id)).goal.status).toBe("active")
      const reblocked = yield* goals
        .transition({
          id: created.goal.id,
          expectedRevision: (yield* goals.get(created.goal.id)).goal.revision,
          action: "block",
          blocker: "A newer blocker established after the original user action",
        })
        .pipe(Effect.orDie)
      expect(reblocked.goal.status).toBe("blocked")
      const second = yield* prompt.userActionPrompt(input, { source: SessionTurnProvenance.Source.GoalStart })
      expect(first.info.id).toBe(messageID)
      expect(second.info.id).toBe(messageID)
      expect((yield* goals.get(created.goal.id)).goal).toMatchObject({
        status: "blocked",
        blocker: "A newer blocker established after the original user action",
      })

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const actions = messages.filter((message) => message.info.id === messageID)
      expect(actions).toHaveLength(1)
      expect(actions[0]?.parts).toHaveLength(1)
      expect(actions[0]?.parts[0]).toMatchObject({ type: "text", text: "Begin the focused Goal." })
      expect(actions[0] && SessionTurnProvenance.isWorkerPromptTurn(actions[0])).toBe(true)
      expect(actions[0] && SessionTurnProvenance.isGoalAuthorizationTurn(actions[0])).toBe(false)
      const action = actions[0]
      if (!action || action.info.role !== "user") throw new Error("expected Goal action to be a user-owned V1 turn")
      expect(action.info.provenance).toEqual({ owner: "user", source: SessionTurnProvenance.Source.GoalStart })
    }),
  { config: cfg },
)

noLLMServer.instance(
  "rejects direct worker-loop execution on a host-owned Goal Auditor child",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({
        parentID: parent.id,
        title: "Goal Auditor child",
        metadata: { specialAgent: "goal_auditor", goalID: "goal_test" },
      })

      const exit = yield* prompt.loop({ sessionID: child.id }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionPrompt.HostOwnedSessionError",
          sessionID: child.id,
          parentID: parent.id,
          kind: "goal_auditor",
        })
      }
    }),
  { config: cfg },
)

for (const kind of ["prompt_revisor", "goal_revisor", "session_title", "spad_auditor"] as const) {
  noLLMServer.instance(
    `rejects host worker-loop execution on a ${kind} special-agent child`,
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const child = yield* sessions.create({
          parentID: parent.id,
          title: kind,
          metadata: { specialAgent: kind },
        })

        const exit = yield* prompt.loop({ sessionID: child.id }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "SessionPrompt.HostOwnedSessionError",
            sessionID: child.id,
            parentID: parent.id,
            kind,
          })
        }
      }),
    { config: cfg },
  )
}

noLLMServer.instance(
  "fails closed when a future or malformed special-agent kind reaches worker admission",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({
        parentID: parent.id,
        title: "Future special agent",
        metadata: { specialAgent: "future_special_agent" },
      })

      const exit = yield* prompt.loop({ sessionID: child.id }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionPrompt.HostOwnedSessionError",
          sessionID: child.id,
          parentID: parent.id,
          kind: "special_agent",
        })
      }
    }),
  { config: cfg },
)

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

goalIt.instance(
  "Goal Mode: a genuine V1 user prompt reactivates a focused blocked Goal at admission even without a reply",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const chat = yield* sessions.create({ title: "Blocked Goal user reactivation" })
      const created = yield* goals
        .create({
          projectID: chat.projectID,
          title: "Reactivate from user prompt",
          objective: "Continue when the user provides new input",
          criteria: ["the blocked Goal becomes active on admission"],
          continuationPolicy: { mode: "auto_continue" },
        })
        .pipe(Effect.orDie)
      const active = yield* goals
        .transition({ id: created.goal.id, expectedRevision: created.goal.revision, action: "start" })
        .pipe(Effect.orDie)
      yield* goals.focus({ goalID: active.goal.id, sessionID: chat.id }).pipe(Effect.orDie)
      const blocked = yield* goals
        .transition({
          id: active.goal.id,
          expectedRevision: active.goal.revision,
          action: "block",
          blocker: "Waiting for new user input",
        })
        .pipe(Effect.orDie)
      expect(blocked.goal.status).toBe("blocked")

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "continue comprehensively" }],
      })

      expect((yield* goals.get(created.goal.id)).goal).toMatchObject({ status: "active", blocker: undefined })
    }),
  { config: cfg },
)

goalIt.instance(
  "Goal Mode: a completed worker turn runs the auditor, and the auditor's continuation re-drives the session until the auditor completes the Goal",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const { llm } = yield* useServerConfig(providerCfg)
      goalAuditorBaseURL = llm.url

      const chat = yield* sessions.create({
        title: "Goal loop",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const created = yield* goals
        .create({
          projectID: chat.projectID,
          title: "Goal loop proof",
          objective: "Prove worker -> auditor -> worker until complete",
          criteria: ["the auditor re-drives the session"],
          continuationPolicy: { mode: "auto_continue" },
          auditorPolicy: { maxAttempts: 1 },
        })
        .pipe(Effect.orDie)
      const active = yield* goals
        .transition({ id: created.goal.id, expectedRevision: created.goal.revision, action: "start" })
        .pipe(Effect.orDie)
      yield* goals.focus({ goalID: active.goal.id, sessionID: chat.id }).pipe(Effect.orDie)

      const criterionID = active.criteria[0]!.id
      const CONTINUATION = "AUDITOR-CONTINUATION-MARKER: take the next concrete step"

      const toolNames = (body: Record<string, unknown>) => {
        const tools = body.tools
        if (!Array.isArray(tools)) return [] as string[]
        return tools.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return []
          const record = entry as { name?: unknown; function?: { name?: unknown } }
          if (typeof record.name === "string") return [record.name]
          if (typeof record.function?.name === "string") return [record.function.name]
          return []
        })
      }
      const isAuditorRequest = (hit: { body: Record<string, unknown> }) => toolNames(hit.body).includes("audit_verdict")

      // Auditor turn 1: another bounded worker cycle, with an explicit handoff.
      yield* llm.pushMatch(
        isAuditorRequest,
        reply()
          .tool("audit_verdict", {
            decision: "continue",
            rationale: "The acceptance criterion is not yet verified.",
            progressMade: true,
            criteria: [{ criterionID, status: "pending", evidence: "not verified yet" }],
            continuationPrompt: CONTINUATION,
          })
          .item(),
      )
      // Auditor turn 2: the Goal is complete.
      yield* llm.pushMatch(
        isAuditorRequest,
        reply()
          .tool("audit_verdict", {
            decision: "complete",
            rationale: "The worker transcript verifies the acceptance criterion.",
            progressMade: true,
            criteria: [{ criterionID, status: "passed", evidence: "verified by transcript" }],
          })
          .item(),
      )
      // Worker cycle 1 deliberately reports `stop` while emitting a host tool.
      // The loop must execute the tool and send its result back to the worker
      // before Goal auditing begins.
      yield* llm.pushMatch(
        (hit) => !isAuditorRequest(hit),
        reply().tool("read", { filePath: fileURLToPath(import.meta.url) }).stop().item(),
      )
      yield* llm.pushMatch((hit) => !isAuditorRequest(hit), reply().text("worker step 1 complete").stop().item())
      // Worker cycle 2 is the auditor-authorized continuation.
      yield* llm.pushMatch((hit) => !isAuditorRequest(hit), reply().text("worker step 2 complete").stop().item())

      const run = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "start the goal" }],
        })
        .pipe(Effect.timeout(Duration.seconds(20)), Effect.option)
      expect((run as { _tag?: string })._tag).not.toBe("None")

      const hits = yield* llm.hits
      const auditorHits = hits.filter(isAuditorRequest)
      const workerHits = hits.filter((hit) => !isAuditorRequest(hit))

      // 1) Completing the worker turn auto-ran the independent auditor.
      expect(auditorHits.length).toBeGreaterThanOrEqual(2)
      // A provider `stop` that also contains a host tool is not a terminal Goal
      // cycle. The tool result must return to the worker before the first audit.
      expect(hits.findIndex(isAuditorRequest)).toBeGreaterThanOrEqual(2)
      // 2) The auditor's continuation re-drove the worker session.
      expect(workerHits.length).toBeGreaterThanOrEqual(3)
      expect(JSON.stringify(workerHits.at(-1)!.body)).toContain(CONTINUATION)
      const firstWorkerUsers = providerRoleTexts(workerHits[0]!.body, "user")
      const firstSpec = firstWorkerUsers.findIndex((text) => text.includes('<goal_spec state="current"'))
      const firstProgress = firstWorkerUsers.findIndex((text) => text.includes('<goal_progress state="current"'))
      const firstHuman = firstWorkerUsers.findIndex((text) => text.includes("start the goal"))
      expect(firstSpec).toBeGreaterThanOrEqual(0)
      expect(firstProgress).toBeGreaterThan(firstSpec)
      expect(firstHuman).toBeGreaterThan(firstProgress)

      // V1 persists a real user steer before the runner can reach its next safe
      // state-reconciliation boundary. The provider materialized view must still
      // keep current Goal state immediately before the active continuation, so
      // state cannot become a newer instruction merely because it was appended.
      const continuedUsers = providerRoleTexts(workerHits.at(-1)!.body, "user")
      const continuedSpec = continuedUsers.findIndex((text) => text.includes('<goal_spec state="current"'))
      const continuedProgress = continuedUsers.findIndex((text) => text.includes('<goal_progress state="current"'))
      const continuedTurn = continuedUsers.findIndex((text) => text.includes(CONTINUATION))
      expect(continuedSpec).toBeGreaterThanOrEqual(0)
      expect(continuedProgress).toBeGreaterThan(continuedSpec)
      expect(continuedTurn).toBeGreaterThan(continuedProgress)
      // The continuation is a durable host-authored turn boundary, not worker
      // system context. This is the role/cache isolation invariant: changing
      // auditor text may append to the transcript but must never mutate the
      // worker's privileged system prefix.
      expect(providerSystemText(workerHits.at(-1)!.body)).not.toContain(CONTINUATION)
      // Privileged auditor identity/reminder/protocol instructions belong only
      // to the host-owned auditor child. They must never leak into a worker
      // provider request, even when the worker receives an auditor-authored
      // continuation assessment as a synthetic host turn.
      for (const hit of workerHits) {
        const system = providerSystemText(hit.body)
        expect(system).toContain("<goal_mechanism>")
        expect(system).not.toContain("[GOAL AUDITOR")
        expect(system).not.toContain("Goal loop proof")
        expect(system).not.toContain("Prove worker -> auditor -> worker until complete")
        expect(system).not.toContain('<goal_spec state="current"')
        expect(system).not.toContain('<goal_progress state="current"')
      }
      const transcript = yield* sessions.messages({ sessionID: chat.id, limit: 100 }).pipe(Effect.orDie)
      const stateTurns = transcript.filter(SessionTurnProvenance.isStateProjectionTurn)
      const specTurns = stateTurns.filter(
        (message) =>
          message.info.role === "user" &&
          message.info.provenance?.owner === "host" &&
          message.info.provenance.source === SessionTurnProvenance.Source.GoalSpecification,
      )
      const progressTurns = stateTurns.filter(
        (message) =>
          message.info.role === "user" &&
          message.info.provenance?.owner === "host" &&
          message.info.provenance.source === SessionTurnProvenance.Source.GoalProgress,
      )
      expect(specTurns).toHaveLength(1)
      expect(progressTurns.length).toBeGreaterThanOrEqual(2)
      for (const stateTurn of stateTurns) {
        expect(stateTurn.info.role).toBe("user")
        expect(stateTurn.parts).toHaveLength(1)
        expect(stateTurn.parts[0]).toMatchObject({ type: "text", synthetic: true })
      }
      const finalProgress = progressTurns.toSorted((left, right) =>
        left.info.time.created !== right.info.time.created
          ? right.info.time.created - left.info.time.created
          : right.info.id.localeCompare(left.info.id),
      )[0]!
      expect(finalProgress.parts[0]?.type === "text" ? finalProgress.parts[0].text : "").toContain(
        "<status>completed</status>",
      )
      const continuationTurns = transcript.filter(
        (message) =>
          message.info.role === "user" &&
          message.info.provenance?.owner === "host" &&
          message.info.provenance.source === SessionTurnProvenance.Source.GoalContinuation &&
          typeof message.info.provenance.ref === "string" &&
          message.info.provenance.ref.length > 0 &&
          message.parts.some(
            (part) =>
              part.type === "text" &&
              part.synthetic === true &&
              part.text.includes(CONTINUATION),
          ),
      )
      expect(continuationTurns).toHaveLength(1)
      const continuationTurn = continuationTurns[0]!
      expect(continuationTurn.info.role).toBe("user")
      if (continuationTurn.info.role !== "user") throw new Error("Expected Goal continuation user-role turn")
      expect(continuationTurn.info.provenance?.owner).toBe("host")
      expect(continuationTurn.info.provenance?.source).toBe(SessionTurnProvenance.Source.GoalContinuation)
      if (continuationTurn.info.provenance?.owner !== "host") throw new Error("Expected host-owned Goal continuation")
      expect(typeof continuationTurn.info.provenance.ref).toBe("string")
      const continuationPart = continuationTurn.parts.find(
        (part) => part.type === "text" && part.synthetic === true && part.text.includes(CONTINUATION),
      )
      expect(continuationPart?.type).toBe("text")
      const userAuthoredTurns = transcript.filter(
        (message) => SessionTurnProvenance.isSemanticUserTurn(message),
      )
      expect(userAuthoredTurns).toHaveLength(1)
      expect(continuationTurn.info.provenance.sourceMessageID).toBe(userAuthoredTurns[0]!.info.id)
      expect(
        transcript.some(
          (message) => message.info.role === "assistant" && message.info.parentID === continuationTurn.info.id,
        ),
      ).toBe(true)
      // 3) The final auditor verdict settled the Goal.
      const focused = yield* goals.focused(chat.id)
      expect(focused?.detail.goal.status).toBe("completed")
      expect(focused?.detail.goal.auditorRuns).toBe(2)
    }),
  { config: cfg },
  30_000,
)

goalIt.instance(
  "Goal Mode: a recovered reservation repairs a message-only continuation publication without duplicating the turn",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const automation = yield* GoalAutomation.Service
      const { llm } = yield* useServerConfig(providerCfg)
      goalAuditorBaseURL = llm.url

      const chat = yield* sessions.create({
        title: "Goal continuation crash recovery",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const seeded = yield* seed(chat.id, { finish: "stop" })
      const created = yield* goals
        .create({
          projectID: chat.projectID,
          title: "Repair partial continuation publication",
          objective: "Recover exactly one complete continuation after a crash between message and part publication",
          criteria: ["the continuation is complete and not duplicated"],
          continuationPolicy: { mode: "auto_continue" },
          auditorPolicy: { maxAttempts: 1 },
        })
        .pipe(Effect.orDie)
      const active = yield* goals
        .transition({ id: created.goal.id, expectedRevision: created.goal.revision, action: "start" })
        .pipe(Effect.orDie)
      yield* goals.focus({ goalID: active.goal.id, sessionID: chat.id }).pipe(Effect.orDie)

      // Emulate the GoalProjection-specific crash boundary as well: the exact
      // deterministic goal.spec message committed, but its synthetic text part
      // did not. The same runner recovery that repairs the continuation below
      // must complete this row in place rather than append another spec state.
      const spec = GoalProjection.sections(active).find((section) => section.kind === "spec")!
      const partialSpecMessageID = MessageID.make(
        GoalProjection.publicationMessageID({ sessionID: chat.id as never, section: spec }),
      )
      yield* sessions.updateMessage({
        ...seeded.user,
        id: partialSpecMessageID,
        provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalSpecification, { ref: spec.ref }),
        time: { created: Date.now() },
      })

      const criterionID = active.criteria[0]!.id
      const reservationDecision = yield* automation.afterTurn({
        sessionID: chat.id,
        origin: "user",
        sourceMessageID: seeded.user.id,
        audit: {
          ok: true,
          verdict: {
            decision: "continue",
            rationale: "One more worker cycle is required.",
            progressMade: true,
            criteria: [{ criterionID, status: "pending", evidence: "recovery has not run yet" }],
            continuationPrompt: "RECOVERED-CONTINUATION-MARKER: finish the recovery proof.",
          },
        },
      })
      const reservation = reservationDecision.reservation
      expect(reservation?.sourceMessageID).toBe(seeded.user.id)
      if (!reservation) throw new Error("Expected a Goal continuation reservation")

      // Emulate the exact crash boundary: the reservation was claimed and its
      // MessageUpdated event committed, but PartUpdated never happened. Startup
      // recovery requeues the claim; the next loop must fill the missing part on
      // the same deterministic message id rather than append a second turn.
      const claimed = yield* automation.claim(chat.id)
      expect(claimed?.id).toBe(reservation.id)
      const continuationMessageID = MessageID.make(`msg_goal_continuation_${reservation.id}`)
      yield* sessions.updateMessage({
        ...seeded.user,
        id: continuationMessageID,
        provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalContinuation, {
          sourceMessageID: seeded.user.id,
          ref: reservation.id,
        }),
        time: { created: reservation.createdAt },
      })
      yield* automation.release({ sessionID: chat.id, reservationID: reservation.id })

      const toolNames = (body: Record<string, unknown>) => {
        const tools = body.tools
        if (!Array.isArray(tools)) return [] as string[]
        return tools.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return []
          const record = entry as { name?: unknown; function?: { name?: unknown } }
          if (typeof record.name === "string") return [record.name]
          if (typeof record.function?.name === "string") return [record.function.name]
          return []
        })
      }
      const isAuditorRequest = (hit: { body: Record<string, unknown> }) => toolNames(hit.body).includes("audit_verdict")
      yield* llm.pushMatch(
        isAuditorRequest,
        reply()
          .tool("audit_verdict", {
            decision: "complete",
            rationale: "The recovered continuation completed successfully.",
            progressMade: true,
            criteria: [{ criterionID, status: "passed", evidence: "recovered worker cycle completed" }],
          })
          .item(),
      )
      yield* llm.pushMatch((hit) => !isAuditorRequest(hit), reply().text("recovery proof complete").stop().item())

      yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.timeout(Duration.seconds(20)))

      const transcript = yield* sessions.messages({ sessionID: chat.id, limit: 100 }).pipe(Effect.orDie)
      const repairedSpec = transcript.filter(
        (message) =>
          message.info.id === partialSpecMessageID &&
          message.info.role === "user" &&
          message.info.provenance?.owner === "host" &&
          message.info.provenance.source === SessionTurnProvenance.Source.GoalSpecification,
      )
      expect(repairedSpec).toHaveLength(1)
      expect(repairedSpec[0]!.parts).toEqual([
        expect.objectContaining({ type: "text", synthetic: true, text: spec.text }),
      ])
      const correlated = transcript.filter(
        (message) =>
          message.info.role === "user" &&
          message.info.provenance?.owner === "host" &&
          message.info.provenance.source === SessionTurnProvenance.Source.GoalContinuation &&
          message.info.provenance.ref === reservation.id,
      )
      expect(correlated).toHaveLength(1)
      expect(correlated[0]!.info.id).toBe(continuationMessageID)
      expect(
        correlated[0]!.parts.filter(
          (part) => part.type === "text" && part.synthetic === true && part.text === reservation.prompt,
        ),
      ).toHaveLength(1)
      expect(
        transcript.some(
          (message) => message.info.role === "assistant" && message.info.parentID === continuationMessageID,
        ),
      ).toBe(true)
    }),
  { config: cfg },
  30_000,
)

goalIt.instance(
  "Goal Mode: a completed compaction resets effective state and reprojects unchanged Goal snapshots without another provider turn",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const { llm } = yield* useServerConfig(providerCfg)
      goalAuditorBaseURL = llm.url

      const chat = yield* sessions.create({
        title: "Goal projection compaction reset",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const goal = yield* goals
        .create({
          projectID: chat.projectID,
          title: "Reproject after compaction",
          objective: "Keep current Goal state live without fossilizing old snapshots",
          criteria: ["state is reprojected after reset"],
        })
        .pipe(Effect.orDie)
      yield* goals.focus({ goalID: goal.goal.id, sessionID: chat.id }).pipe(Effect.orDie)

      yield* llm.push(reply().text("baseline worker result").stop().item())
      const baseline = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "establish the baseline Goal context" }],
      })
      if (baseline.info.role !== "assistant") throw new Error("expected baseline assistant")

      let transcript = yield* sessions.messages({ sessionID: chat.id, limit: 100 }).pipe(Effect.orDie)
      const root = transcript.find(SessionTurnProvenance.isWorkerPromptTurn)
      if (!root || root.info.role !== "user") throw new Error("expected worker root")
      const before = transcript.filter(SessionTurnProvenance.isStateProjectionTurn)
      expect(before).toHaveLength(2)
      const beforeIDs = new Set(before.map((message) => message.info.id))
      const hitsBeforeReset = (yield* llm.hits).length

      const compactionID = MessageID.ascending()
      yield* sessions.updateMessage({
        ...root.info,
        id: compactionID,
        provenance: SessionTurnProvenance.hostDerived(SessionTurnProvenance.Source.Compaction, root.info),
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: compactionID,
        sessionID: chat.id,
        type: "compaction",
        auto: false,
      })
      const summaryID = MessageID.ascending()
      yield* sessions.updateMessage({
        ...baseline.info,
        id: summaryID,
        parentID: compactionID,
        mode: "compaction",
        agent: "compaction",
        summary: true,
        finish: "stop",
        error: undefined,
        time: { created: Date.now() + 1 },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryID,
        sessionID: chat.id,
        type: "text",
        text: "historical summary intentionally excludes Goal state",
      })

      // No prompt/continuation is pending. The loop should use its normal
      // effective-history load to reproject state at the new reset boundary and
      // then quiesce on the already-finished compaction summary.
      yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.timeout(Duration.seconds(20)))
      expect((yield* llm.hits).length).toBe(hitsBeforeReset)

      transcript = yield* sessions.messages({ sessionID: chat.id, limit: 100 }).pipe(Effect.orDie)
      const after = transcript.filter(SessionTurnProvenance.isStateProjectionTurn)
      const republished = after.filter((message) => !beforeIDs.has(message.info.id))
      expect(republished).toHaveLength(2)
      expect(
        republished
          .flatMap((message) =>
            message.info.role === "user" && message.info.provenance?.owner === "host"
              ? [message.info.provenance.source]
              : [],
          )
          .sort(),
      ).toEqual(
        [SessionTurnProvenance.Source.GoalProgress, SessionTurnProvenance.Source.GoalSpecification].sort(),
      )

      // A second reconciliation in the same reset epoch is a no-op.
      yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.timeout(Duration.seconds(20)))
      const finalTranscript = yield* sessions.messages({ sessionID: chat.id, limit: 100 }).pipe(Effect.orDie)
      expect(finalTranscript.filter(SessionTurnProvenance.isStateProjectionTurn)).toHaveLength(after.length)
      expect((yield* llm.hits).length).toBe(hitsBeforeReset)
    }),
  { config: cfg },
  30_000,
)

goalIt.instance(
  "Goal Mode: an orphaned verifying Goal can run the auditor directly without another worker turn",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const { llm } = yield* useServerConfig(providerCfg)
      goalAuditorBaseURL = llm.url

      const chat = yield* sessions.create({
        title: "Direct Goal audit",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Seed a normal completed worker exchange before the Goal exists. The
      // direct audit must inspect this transcript; it must not ask the worker
      // model for a synthetic/no-op turn merely to wake the auditor.
      yield* llm.push(reply().text("baseline worker result").stop().item())
      const baseline = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "produce the baseline result" }],
      })
      if (baseline.info.role !== "assistant") throw new Error("expected baseline assistant")
      // Reproduce a long-running campaign transcript where the latest bounded
      // history page contains only assistant/tool activity. Auditor model
      // provenance must still find the most recent user turn across pages.
      for (let index = 0; index < 12; index++) {
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          parentID: baseline.info.parentID,
          role: "assistant",
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          variant: baseline.info.variant,
          path: baseline.info.path,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: baseline.info.modelID,
          providerID: baseline.info.providerID,
          time: { created: Date.now() + index + 1, completed: Date.now() + index + 1 },
          finish: "stop",
        })
      }

      const created = yield* goals
        .create({
          projectID: chat.projectID,
          title: "Recover verifier",
          objective: "Audit the existing worker result without another worker turn",
          criteria: ["the existing worker result is independently verified"],
          continuationPolicy: { mode: "auto_continue" },
          auditorPolicy: { maxAttempts: 1 },
        })
        .pipe(Effect.orDie)
      const active = yield* goals
        .transition({ id: created.goal.id, expectedRevision: created.goal.revision, action: "start" })
        .pipe(Effect.orDie)
      yield* goals.focus({ goalID: active.goal.id, sessionID: chat.id }).pipe(Effect.orDie)
      const verifying = yield* goals
        .transition({ id: active.goal.id, expectedRevision: active.goal.revision, action: "request_verification" })
        .pipe(Effect.orDie)

      const criterionID = verifying.criteria[0]!.id
      yield* llm.pushMatch(
        (hit) => {
          const tools = hit.body.tools
          return Array.isArray(tools) && JSON.stringify(tools).includes("audit_verdict")
        },
        reply()
          .tool("audit_verdict", {
            decision: "complete",
            rationale: "The existing transcript is sufficient evidence.",
            progressMade: true,
            criteria: [{ criterionID, status: "passed", evidence: "verified from the existing worker transcript" }],
          })
          .item(),
      )

      const before = (yield* llm.hits).length
      yield* prompt.auditGoal(chat.id).pipe(Effect.timeout(Duration.seconds(20)))
      const hits = (yield* llm.hits).slice(before)

      expect(hits).toHaveLength(1)
      expect(JSON.stringify(hits[0]!.body.tools)).toContain("audit_verdict")
      expect((yield* goals.focused(chat.id))?.detail.goal.status).toBe("completed")
      expect((yield* goals.focused(chat.id))?.detail.goal.auditorRuns).toBe(1)
      expect(yield* (yield* GoalAutomation.Service).runtime(chat.id)).toBeUndefined()
    }),
  { config: cfg },
  30_000,
)

goalIt.instance(
  "Goal Mode: a user verification request preempts an in-flight worker generation before AUDITING begins",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const goals = yield* Goal.Service
      const automation = yield* GoalAutomation.Service
      const { llm } = yield* useServerConfig(providerCfg)
      goalAuditorBaseURL = llm.url

      const chat = yield* sessions.create({
        title: "Goal audit preemption",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const created = yield* goals
        .create({
          projectID: chat.projectID,
          title: "Preempt worker for verification",
          objective: "Stop active worker generation when the user requests independent verification",
          criteria: ["the independent auditor verifies the interrupted worker transcript"],
          continuationPolicy: { mode: "auto_continue" },
          auditorPolicy: { maxAttempts: 1 },
        })
        .pipe(Effect.orDie)
      const active = yield* goals
        .transition({ id: created.goal.id, expectedRevision: created.goal.revision, action: "start" })
        .pipe(Effect.orDie)
      yield* goals.focus({ goalID: active.goal.id, sessionID: chat.id }).pipe(Effect.orDie)

      const criterionID = active.criteria[0]!.id
      const auditorGate = yield* Deferred.make<void>()
      const toolNames = (body: Record<string, unknown>) => {
        const tools = body.tools
        if (!Array.isArray(tools)) return [] as string[]
        return tools.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return []
          const record = entry as { name?: unknown; function?: { name?: unknown } }
          if (typeof record.name === "string") return [record.name]
          if (typeof record.function?.name === "string") return [record.function.name]
          return []
        })
      }
      const isAuditorRequest = (hit: { body: Record<string, unknown> }) => toolNames(hit.body).includes("audit_verdict")

      // The worker emits visible text and then leaves the provider stream open.
      // Verification must interrupt this exact run instead of waiting for a
      // natural assistant completion.
      yield* llm.pushMatch((hit) => !isAuditorRequest(hit), reply().text("partial worker output").hang().item())
      // Keep the real auditor provider turn open after admission so the test can
      // observe the authoritative intermediate state: parent idle + live auditor
      // lease. Releasing the gate then commits the terminal verdict.
      yield* llm.pushMatch(
        isAuditorRequest,
        reply()
          .wait(deferredAsPromise(auditorGate))
          .tool("audit_verdict", {
            decision: "complete",
            rationale: "The interrupted worker transcript is sufficient for this regression proof.",
            progressMade: true,
            criteria: [{ criterionID, status: "passed", evidence: "auditor inspected the finalized interrupted turn" }],
          })
          .item(),
      )

      const worker = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "begin worker generation and keep going" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      const verify = yield* prompt.requestGoalAudit(chat.id).pipe(Effect.forkChild)
      yield* llm.wait(2)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const runtime = yield* automation.runtime(chat.id)
          const parentStatus = yield* status.get(chat.id)
          return runtime?.phase === "auditing" && parentStatus.type === "idle" ? runtime : undefined
        }),
        "timed out waiting for worker preemption and live auditor lease",
        "10 seconds",
      )

      expect((yield* status.get(chat.id)).type).toBe("idle")
      const running = yield* automation.runtime(chat.id)
      expect(running?.phase).toBe("auditing")
      if (running?.phase !== "auditing") throw new Error("expected live auditor lease")
      expect(yield* goals.auditorSessionFor({ parentSessionID: chat.id, goalID: active.goal.id })).toBe(
        running.auditorSessionID,
      )

      const interrupted = (yield* sessions.messages({ sessionID: chat.id })).findLast(
        (message) => message.info.role === "assistant",
      )
      expect(interrupted?.info.role).toBe("assistant")
      if (interrupted?.info.role === "assistant") {
        expect(interrupted.info.time.completed).toBeDefined()
        expect(interrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* Deferred.succeed(auditorGate, void 0)
      const verifyExit = yield* Fiber.await(verify)
      expect(Exit.isSuccess(verifyExit)).toBe(true)
      const workerExit = yield* Fiber.await(worker)
      expect(Exit.isSuccess(workerExit)).toBe(true)

      const focused = yield* goals.focused(chat.id)
      expect(focused?.detail.goal.status).toBe("completed")
      expect(focused?.detail.goal.auditorRuns).toBe(1)
      expect(yield* automation.runtime(chat.id)).toBeUndefined()
    }),
  { config: cfg },
  30_000,
)

goalIt.instance(
  "Goal Mode: a user verification request aborts an in-flight worker tool before the auditor starts",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const goals = yield* Goal.Service
      const automation = yield* GoalAutomation.Service
      const registry = yield* ToolRegistry.Service
      const { llm } = yield* useServerConfig(providerCfg)
      goalAuditorBaseURL = llm.url

      const { read } = yield* registry.named()
      const { ready: toolReady, aborted: toolAborted, restore } = yield* hangUntilAborted(read)
      yield* restore

      const chat = yield* sessions.create({
        title: "Goal tool preemption",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const created = yield* goals
        .create({
          projectID: chat.projectID,
          title: "Preempt worker tool for verification",
          objective: "Stop an active worker tool when the user requests independent verification",
          criteria: ["the independent auditor sees a finalized interrupted tool state"],
          continuationPolicy: { mode: "auto_continue" },
          auditorPolicy: { maxAttempts: 1 },
        })
        .pipe(Effect.orDie)
      const active = yield* goals
        .transition({ id: created.goal.id, expectedRevision: created.goal.revision, action: "start" })
        .pipe(Effect.orDie)
      yield* goals.focus({ goalID: active.goal.id, sessionID: chat.id }).pipe(Effect.orDie)

      const criterionID = active.criteria[0]!.id
      const auditorGate = yield* Deferred.make<void>()
      const toolNames = (body: Record<string, unknown>) => {
        const tools = body.tools
        if (!Array.isArray(tools)) return [] as string[]
        return tools.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return []
          const record = entry as { name?: unknown; function?: { name?: unknown } }
          if (typeof record.name === "string") return [record.name]
          if (typeof record.function?.name === "string") return [record.function.name]
          return []
        })
      }
      const isAuditorRequest = (hit: { body: Record<string, unknown> }) => toolNames(hit.body).includes("audit_verdict")

      // The provider delegates to a host-executed tool. The overridden read tool
      // blocks until its AbortSignal fires, proving that verification preemption
      // reaches the currently executing tool rather than merely cancelling the
      // provider stream around it.
      yield* llm.pushMatch(
        (hit) => !isAuditorRequest(hit),
        reply().tool("read", { filePath: fileURLToPath(import.meta.url) }).item(),
      )
      yield* llm.pushMatch(
        isAuditorRequest,
        reply()
          .wait(deferredAsPromise(auditorGate))
          .tool("audit_verdict", {
            decision: "complete",
            rationale: "The interrupted tool state is finalized and visible in the worker transcript.",
            progressMade: true,
            criteria: [{ criterionID, status: "passed", evidence: "the read tool was durably marked interrupted before audit" }],
          })
          .item(),
      )

      const worker = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "read the requested file and continue working" }],
        })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(toolReady), "timed out waiting for worker tool to start", "10 seconds")
      yield* waitForBusy(chat.id)

      const verify = yield* prompt.requestGoalAudit(chat.id).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(toolAborted), "timed out waiting for worker tool abort", "10 seconds")
      yield* llm.wait(2)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const runtime = yield* automation.runtime(chat.id)
          const parentStatus = yield* status.get(chat.id)
          return runtime?.phase === "auditing" && parentStatus.type === "idle" ? runtime : undefined
        }),
        "timed out waiting for finalized tool state and live auditor lease",
        "10 seconds",
      )

      const parentMessages = yield* sessions.messages({ sessionID: chat.id })
      const interruptedTool = parentMessages
        .flatMap((message) => message.parts)
        .find(
          (part) =>
            part.type === "tool" &&
            part.tool === "read" &&
            part.state.status === "error" &&
            part.state.metadata?.interrupted === true,
        )
      expect(interruptedTool?.type).toBe("tool")
      expect((yield* status.get(chat.id)).type).toBe("idle")
      const running = yield* automation.runtime(chat.id)
      expect(running?.phase).toBe("auditing")

      yield* Deferred.succeed(auditorGate, void 0)
      expect(Exit.isSuccess(yield* Fiber.await(verify))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.await(worker))).toBe(true)
      expect((yield* goals.focused(chat.id))?.detail.goal).toMatchObject({ status: "completed", auditorRuns: 1 })
      expect(yield* automation.runtime(chat.id)).toBeUndefined()
    }),
  { config: cfg },
  30_000,
)

goalIt.instance(
  "Goal Mode: manual verification preempts an in-flight auditor-authorized continuation without resurrecting it",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const goals = yield* Goal.Service
      const automation = yield* GoalAutomation.Service
      const { llm } = yield* useServerConfig(providerCfg)
      goalAuditorBaseURL = llm.url

      const chat = yield* sessions.create({
        title: "Goal continuation preemption",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const created = yield* goals
        .create({
          projectID: chat.projectID,
          title: "Preempt automatic continuation",
          objective: "Manual verification supersedes an already-running automatic Goal continuation",
          criteria: ["the stale automatic continuation cannot resurrect after user verification"],
          continuationPolicy: { mode: "auto_continue" },
          auditorPolicy: { maxAttempts: 1 },
        })
        .pipe(Effect.orDie)
      const active = yield* goals
        .transition({ id: created.goal.id, expectedRevision: created.goal.revision, action: "start" })
        .pipe(Effect.orDie)
      yield* goals.focus({ goalID: active.goal.id, sessionID: chat.id }).pipe(Effect.orDie)

      const criterionID = active.criteria[0]!.id
      const toolNames = (body: Record<string, unknown>) => {
        const tools = body.tools
        if (!Array.isArray(tools)) return [] as string[]
        return tools.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return []
          const record = entry as { name?: unknown; function?: { name?: unknown } }
          if (typeof record.name === "string") return [record.name]
          if (typeof record.function?.name === "string") return [record.function.name]
          return []
        })
      }
      const isAuditorRequest = (hit: { body: Record<string, unknown> }) => toolNames(hit.body).includes("audit_verdict")

      // Initial user worker cycle completes normally.
      yield* llm.pushMatch((hit) => !isAuditorRequest(hit), reply().text("initial worker cycle complete").stop().item())
      // First auditor authorizes an autonomous continuation.
      yield* llm.pushMatch(
        isAuditorRequest,
        reply()
          .tool("audit_verdict", {
            decision: "continue",
            rationale: "One more worker cycle is required.",
            progressMade: true,
            criteria: [{ criterionID, status: "pending", evidence: "more work remains" }],
            continuationPrompt: "Run the automatic continuation until the next concrete checkpoint.",
          })
          .item(),
      )
      // The auditor-authorized continuation starts, then hangs in generation.
      yield* llm.pushMatch((hit) => !isAuditorRequest(hit), reply().text("partial automatic continuation").hang().item())
      // The user-requested replacement audit completes the Goal.
      yield* llm.pushMatch(
        isAuditorRequest,
        reply()
          .tool("audit_verdict", {
            decision: "complete",
            rationale: "The finalized transcript now satisfies the regression criterion.",
            progressMade: true,
            criteria: [{ criterionID, status: "passed", evidence: "stale continuation was interrupted and did not resume" }],
          })
          .item(),
      )

      const original = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "start the automatic Goal" }],
        })
        .pipe(Effect.forkChild)

      // Three requests prove the second worker cycle is the claimed automatic
      // continuation: worker 1, auditor 1, worker 2 (hung).
      yield* llm.wait(3)
      yield* waitForBusy(chat.id, "10 seconds")
      const before = yield* llm.hits
      expect(before.filter(isAuditorRequest)).toHaveLength(1)
      expect(before.filter((hit) => !isAuditorRequest(hit))).toHaveLength(2)

      yield* prompt.requestGoalAudit(chat.id).pipe(Effect.timeout("15 seconds"))
      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* goals.focused(chat.id))?.detail.goal).toMatchObject({ status: "completed", auditorRuns: 2 })
      expect(yield* automation.runtime(chat.id)).toBeUndefined()

      const originalExit = yield* Fiber.await(original)
      expect(Exit.isSuccess(originalExit)).toBe(true)
      const hits = yield* llm.hits
      expect(hits.filter(isAuditorRequest)).toHaveLength(2)
      expect(hits.filter((hit) => !isAuditorRequest(hit))).toHaveLength(2)
      for (const hit of hits.filter((entry) => !isAuditorRequest(entry))) {
        expect(providerSystemText(hit.body)).not.toContain("[GOAL AUDITOR")
      }
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "loop exits for a completed parent turn with nonmonotonic message IDs",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const userID = MessageID.make("msg_z_user")
      const assistantID = MessageID.make("msg_a_assistant")
      yield* sessions.updateMessage({
        id: userID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: userID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 200, completed: 201 },
        finish: "stop",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.id).toBe(assistantID)
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("SPAD recovery truncates a repetitive tail and continues with a hidden re-anchor", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      experimental: { spad_recovery: true },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "SPAD recovery",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const motif = "The implementation should continue from the last stable state. "

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Continue implementing the feature." }],
    })
    yield* llm.text(motif.repeat(12))
    yield* llm.text("The recovery succeeded and the task can continue.")

    const result = yield* prompt.loop({ sessionID: session.id })
    const messages = yield* sessions.messages({ sessionID: session.id })
    const synthetic = messages.flatMap((message) => message.parts).find(
      (part) => part.type === "text" && part.synthetic === true && part.text.includes("repetitive output loop"),
    )
    const repetitive = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "text" && part.text.includes(motif))

    expect(result.parts.some((part) => part.type === "text" && part.text.includes("recovery succeeded"))).toBe(true)
    expect(synthetic).toBeDefined()
    expect(repetitive?.type).toBe("text")
    if (repetitive?.type === "text") expect(repetitive.text.length).toBeLessThan(motif.length * 12)
    expect(yield* llm.hits).toHaveLength(2)
  }),
)

it.instance("SPAD auditor persists host-owned synthetic provenance and a settled verdict", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      small_model: "test/test-model",
      experimental: { spad_recovery: false, spad_auditor: true },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "SPAD auditor provenance",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const drift = canonicalSpadAuditDrift()

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Compare the approaches and keep useful changes." }],
    })
    yield* llm.toolMatch(
      (hit) => JSON.stringify(hit.body).includes(SpadAuditor.VERDICT_TOOL),
      SpadAuditor.VERDICT_TOOL,
      { decision: "uncertain", confidence: 0.55, reason: "insufficient_evidence" },
    )
    yield* llm.text(drift)

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const transcriptID = SpecialAgentSession.sessionIDFor({
      ownerKind: SpecialAgentSession.OWNER_SESSION,
      ownerID: session.id,
      agent: "spad_auditor",
    })
    const { readDb } = yield* Database.Service
    const history = yield* pollWithTimeout(
      Effect.gen(function* () {
        const current = yield* SessionHistory.load(readDb, transcriptID)
        const prompts = current.filter(
          (message) =>
            message.type === "synthetic" &&
            message.provenance?.owner === "host" &&
            message.provenance.source === CurrentTurnProvenance.Source.SpadAuditor,
        )
        const tools = current.flatMap((message) =>
          message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
        )
        const settled = tools.some(
          (tool) => tool.name === SpadAuditor.VERDICT_TOOL && tool.state.status === "completed",
        )
        const dangling = tools.some((tool) => tool.state.status === "pending" || tool.state.status === "running")
        return prompts.length === 1 && settled && !dangling ? current : undefined
      }),
      "SPAD auditor child transcript did not settle",
      "10 seconds",
    )

    const prompts = history.filter(
      (message) =>
        message.type === "synthetic" &&
        message.provenance?.owner === "host" &&
        message.provenance.source === CurrentTurnProvenance.Source.SpadAuditor,
    )
    expect(prompts).toHaveLength(1)
    expect(prompts[0] && CurrentTurnProvenance.isWorkerPromptTurn(prompts[0])).toBe(false)
    expect(prompts[0] && CurrentTurnProvenance.isGoalAuthorizationTurn(prompts[0])).toBe(false)
    const tools = history.flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    )
    expect(tools.map((tool) => ({ name: tool.name, status: tool.state.status }))).toContainEqual({
      name: SpadAuditor.VERDICT_TOOL,
      status: "completed",
    })
    expect(tools.some((tool) => tool.state.status === "pending" || tool.state.status === "running")).toBe(false)
  }),
  20_000,
)

it.instance("SPAD disabled preserves repetitive output and avoids recovery", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      experimental: { spad_recovery: false, spad_auditor: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "SPAD disabled",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const motif = "The implementation should continue from the last stable state. "
    const loop = motif.repeat(12)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Continue implementing the feature." }],
    })
    yield* llm.text(loop)

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.parts.some((part) => part.type === "text" && part.text === loop)).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance("SPAD destructive recovery is disabled by default when the experimental flag is unset", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), experimental: { spad_auditor: false } }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "SPAD default off",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const motif = "The implementation should continue from the last stable state. "
    const loop = motif.repeat(12)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Continue implementing the feature." }],
    })
    yield* llm.text(loop)

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.parts.some((part) => part.type === "text" && part.text === loop)).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

// SPAD-R live degeneration patterns (SPAD-R-LIVE-RESEARCH.md §8.2), scripted
// through the mock LLM server. Each test clears the persisted-motif store so
// the cross-restart early path never pre-empts the detector under test.
const spadSession = Effect.fn("test.spadSession")(function* (title: string) {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  return { prompt, sessions, session }
})

const countOccurrences = (text: string, needle: string) => text.split(needle).length - 1

it.instance("SPAD observe-only mode preserves repetitive output without recovery", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      experimental: { spad_recovery: true, spad_observe_only: true },
    }))
    const { prompt, sessions, session } = yield* spadSession("SPAD observe-only")
    const motif = "The implementation should continue from the last stable state. "
    const loop = motif.repeat(12)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Continue implementing the feature." }],
    })
    yield* llm.text(loop)

    const result = yield* prompt.loop({ sessionID: session.id })
    const messages = yield* sessions.messages({ sessionID: session.id })
    const synthetic = messages.some((message) => message.parts.some((part) => part.type === "text" && part.synthetic === true))
    expect(result.parts.some((part) => part.type === "text" && part.text === loop)).toBe(true)
    expect(synthetic).toBe(false)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance("SPAD truncation keeps the healthy prefix across chunked deltas", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      experimental: { spad_recovery: true },
    }))
    const { prompt, sessions, session } = yield* spadSession("SPAD chunked truncation")
    const prefix = "Here is the plan for the next milestone. "
    const motif = "The implementation should continue from the last stable state. "

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Continue implementing the feature." }],
    })
    yield* llm.push(
      reply()
        .text(prefix)
        .text(motif.repeat(6))
        .text(motif.repeat(6))
        .stop(),
    )
    yield* llm.text("The recovery succeeded and the task can continue.")

    const result = yield* prompt.loop({ sessionID: session.id })
    const messages = yield* sessions.messages({ sessionID: session.id })
    const truncated = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "text" && part.text.includes(prefix))
    const synthetic = messages
      .flatMap((message) => message.parts)
      .some((part) => part.type === "text" && part.synthetic === true && part.text.includes("repetitive output loop"))

    expect(truncated?.type).toBe("text")
    if (truncated?.type === "text") {
      expect(truncated.text.startsWith(prefix)).toBe(true)
      expect(countOccurrences(truncated.text, motif)).toBeLessThan(12)
    }
    expect(synthetic).toBe(true)
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("recovery succeeded"))).toBe(true)
    expect(yield* llm.hits).toHaveLength(2)
  }),
)

it.instance("SPAD expansion lane recovers a growing restatement ledger", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      experimental: { spad_recovery: true },
    }))
    const { prompt, sessions, session } = yield* spadSession("SPAD expansion")
    const incidents = Array.from({ length: 16 }, (_, i) => `${i + 1}. sensor-${(i % 5) + 1} reported a transient read timeout`)
    const ledger = Array.from(
      { length: 16 },
      (_, c) => [`=== INCIDENT LEDGER (after cycle ${c + 1}) ===`, ...incidents.slice(0, c + 1), ""].join("\n"),
    ).join("\n")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Maintain the cumulative incident ledger across all cycles." }],
    })
    yield* llm.text(ledger)
    yield* llm.text("The ledger is complete; all incidents are recorded.")

    const result = yield* prompt.loop({ sessionID: session.id })
    const messages = yield* sessions.messages({ sessionID: session.id })
    const synthetic = messages
      .flatMap((message) => message.parts)
      .some((part) => part.type === "text" && part.synthetic === true && part.text.includes("repetitive output loop"))
    const truncated = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "text" && part.text.includes("INCIDENT LEDGER"))

    expect(synthetic).toBe(true)
    expect(truncated?.type).toBe("text")
    if (truncated?.type === "text") expect(truncated.text.length).toBeLessThan(ledger.length)
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("all incidents are recorded"))).toBe(true)
    expect(yield* llm.hits).toHaveLength(2)
  }),
)

it.instance("SPAD canonical lane recovers whitespace and case drift loops", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      experimental: { spad_recovery: true },
    }))
    const { prompt, sessions, session } = yield* spadSession("SPAD canonical drift")
    const base = "The build step failed and must be retried"
    const drift = Array.from({ length: 60 }, (_, i) => {
      const casing = i % 3 === 0 ? base.toUpperCase() : i % 3 === 1 ? base : base.toLowerCase()
      return casing + "." + " ".repeat(1 + (i % 7))
    }).join("\n")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Investigate the failing build." }],
    })
    yield* llm.text(drift)
    yield* llm.text("The investigation finished with a concrete fix.")

    const result = yield* prompt.loop({ sessionID: session.id })
    const messages = yield* sessions.messages({ sessionID: session.id })
    const synthetic = messages
      .flatMap((message) => message.parts)
      .some((part) => part.type === "text" && part.synthetic === true && part.text.includes("repetitive output loop"))
    const truncated = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "text" && part.text.toUpperCase().includes("BUILD STEP FAILED"))

    expect(synthetic).toBe(true)
    expect(truncated?.type).toBe("text")
    if (truncated?.type === "text") expect(truncated.text.length).toBeLessThan(drift.length)
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("concrete fix"))).toBe(true)
    expect(yield* llm.hits).toHaveLength(2)
  }),
)

it.instance("SPAD aborts after a second relapse of the same motif", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      experimental: { spad_recovery: true },
    }))
    const { prompt, sessions, session } = yield* spadSession("SPAD relapse abort")
    const motif = "The implementation should continue from the last stable state. "

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Continue implementing the feature." }],
    })
    yield* llm.text(motif.repeat(12))
    yield* llm.text(motif.repeat(12))
    yield* llm.text(motif.repeat(12))

    const result = yield* prompt.loop({ sessionID: session.id })
    const messages = yield* sessions.messages({ sessionID: session.id })
    const aborted = messages.find(
      (message) => message.info.role === "assistant" && (JSON.stringify((message.info as { error?: unknown }).error) ?? "").includes("Repetitive"),
    )

    expect(aborted).toBeDefined()
    expect((JSON.stringify((result.info as { error?: unknown }).error) ?? "")).toContain("Repetitive")
    expect(yield* llm.hits).toHaveLength(3)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("SPAD intent gate skips recovery when the user explicitly requests repetition", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      experimental: { spad_recovery: true },
    }))
    const { prompt, sessions, session } = yield* spadSession("SPAD intent gate")
    const loop = "banana\n".repeat(400)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Print the following word exactly 1000 times: banana" }],
    })
    yield* llm.text(loop)

    const result = yield* prompt.loop({ sessionID: session.id })
    const messages = yield* sessions.messages({ sessionID: session.id })
    const synthetic = messages.some((message) => message.parts.some((part) => part.type === "text" && part.synthetic === true))

    expect(result.parts.some((part) => part.type === "text" && part.text === loop)).toBe(true)
    expect(synthetic).toBe(false)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

// Blocked by a pre-existing event-schema bug unrelated to SPAD: persisting a
// user message with a json_schema format fails validation inside
// Session.updateMessage ("Expected OutputFormatJsonSchema") even though the
// value decodes cleanly against the Format schema standalone. The
// observe-only gate itself is covered by the spad unit suite
// (makeTurnPolicy with json_schema forces observeOnly). Re-enable once the
// format round-trip is fixed.
it.instance.skip("SPAD structured output stays observe-only under json_schema format", () => Effect.void)

it.instance("SPAD thrash lane recovers cross-turn tool stagnation without truncation", () =>
  Effect.gen(function* () {
    clearPersistedMotifs()
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      experimental: { spad_recovery: true },
    }))
    const { prompt, sessions, session } = yield* spadSession("SPAD thrash")
    const narration = "Let me check the benchmark file again before deciding anything further. "
    // Three distinct non-mutating reads per generation whose resource keys all
    // collapse to the "benchmark.ts" basename, so the thrash lane sees pure
    // re-access. Distinct paths avoid the doom-loop permission gate and the
    // adapter merging identical calls.
    const readInputs = ["alpha", "beta", "gamma"].map(
      (dir) => ({ filePath: path.join(path.dirname(fileURLToPath(import.meta.url)), dir, "benchmark.ts") }),
    )

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "Profile the benchmark and report findings." }],
    })
    for (let gen = 0; gen < 3; gen++) {
      yield* llm.push(
        reply()
          .text(narration)
          .tool("read", readInputs[0])
          .tool("read", readInputs[1])
          .tool("read", readInputs[2]),
      )
    }
    yield* llm.text("Profiling is complete; the bottleneck is the matcher hot loop.")

    const result = yield* prompt.loop({ sessionID: session.id })
    const messages = yield* sessions.messages({ sessionID: session.id })
    const synthetic = messages
      .flatMap((message) => message.parts)
      .some((part) => part.type === "text" && part.synthetic === true && part.text.includes("repeated the same exploration"))
    const narrations = messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text" && part.text.includes(narration.trim()))

    expect(synthetic).toBe(true)
    expect(narrations.length).toBeGreaterThan(0)
    for (const part of narrations) if (part.type === "text") expect(part.text).toContain(narration.trim())
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("bottleneck"))).toBe(true)
    expect(yield* llm.hits).toHaveLength(4)
  }),
  { timeout: 30000 },
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("loop continues when finish is unknown", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }

    // Continuation context (#43892): the N+1 generation must be told why it is
    // running (previous response ended "unknown"), instead of appearing as a
    // blank/phantom user turn. The continuation is now a durable host-owned
    // synthetic turn, matching the V2 semantic-message model.
    const hits = yield* llm.hits
    const firstBody = JSON.stringify(hits[0]?.body)
    expect(firstBody).not.toContain("AUTOMATIC CONTINUATION")
    const secondMessages = ((hits[1]?.body as { messages?: Array<{ role: string; content: unknown }> })
      ?.messages ?? []) as Array<{ role: string; content: unknown }>
    const lastUserTurn = secondMessages.findLast((m) => m.role === "user")
    expect(JSON.stringify(lastUserTurn?.content)).toContain("AUTOMATIC CONTINUATION")
    const finalMsgs = yield* sessions.messages({ sessionID: session.id })
    const continuations = finalMsgs.filter(
      (message) =>
        message.info.role === "user" &&
        message.info.provenance?.owner === "host" &&
        message.info.provenance.source === SessionTurnProvenance.Source.UnknownFinishContinuation,
    )
    expect(continuations).toHaveLength(1)
    const continuation = continuations[0]!
    expect(SessionTurnProvenance.semanticKind(continuation)).toBe("synthetic")
    expect(continuation.parts.some((part) => part.type === "text" && part.text.includes("AUTOMATIC CONTINUATION"))).toBe(
      true,
    )
    if (continuation.info.role !== "user") throw new Error("expected synthetic provider-user turn")
    expect(continuation.info.provenance?.owner).toBe("host")
    if (continuation.info.provenance?.owner !== "host") throw new Error("expected host provenance")
    const source = finalMsgs.find(SessionTurnProvenance.isWorkerPromptTurn)
    expect(source).toBeDefined()
    expect(continuation.info.provenance.sourceMessageID).toBe(source?.info.id)
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      const cancelStarted = Date.now()
      yield* prompt.cancel(chat.id)
      console.log("busy-idle cancel ms", Date.now() - cancelStarted)
      const awaitStarted = Date.now()
      yield* Fiber.await(fiber)
      console.log("busy-idle await ms", Date.now() - awaitStarted)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

it.instance(
  "cancel propagates from slash command subtask and finalizes parent tool state",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")

      const settled = yield* MessageV2.filterCompactedEffect(chat.id)
      const settledTask = settled.find((item) => item.info.role === "assistant" && item.info.id === taskMsg?.info.id)
      expect(settledTask?.info.role).toBe("assistant")
      if (!settledTask || settledTask.info.role !== "assistant") return
      const settledTool = toolPart(settledTask.parts)
      expect(settledTool?.state.status).not.toBe("running")
      expect(settledTask.info.time.completed).toBeDefined()
      expect(settledTask.info.finish).toBeDefined()
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )
    const pending = yield* SessionInput.findEntry(db, SessionMessage.ID.make(id))
    expect(pending?.admissionClass).toBe("user")
    expect(pending?.promotedSeq).toBeUndefined()

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)
    const promoted = yield* SessionInput.findEntry(db, SessionMessage.ID.make(id))
    expect(promoted?.promotedSeq).toBeDefined()

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
  15_000,
)

it.instance(
  "human prompt steers an active scheduled-task root at the next safe provider cycle",
  () =>
    Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const chat = yield* sessions.create({
      title: "Active Scheduled run",
      metadata: { scheduledTaskID: "stk_active_steer", scheduledTaskRunID: "str_active_steer" },
    })

    yield* llm.hold("scheduled-first", deferredAsPromise(gate))
    yield* llm.text("human-second")

    const scheduled = yield* prompt
      .hostPrompt(
        {
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "scheduled objective" }],
        },
        { source: SessionTurnProvenance.Source.ScheduledTaskRun, ref: "str_active_steer" },
      )
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const humanID = MessageID.ascending()
    const human = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: humanID,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "human takes focus" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      SessionInput.findEntry(db, SessionMessage.ID.make(humanID)).pipe(
        Effect.map((entry) => (entry?.admissionClass === "user" ? entry : undefined)),
      ),
      "timed out waiting for Scheduled human focus frontier",
    )
    expect((yield* SessionInput.findEntry(db, SessionMessage.ID.make(humanID)))?.promotedSeq).toBeUndefined()
    expect(yield* SessionInput.latestUserSeq(db, SessionSchema.ID.make(chat.id))).toBe(
      (yield* SessionInput.findEntry(db, SessionMessage.ID.make(humanID)))?.admittedSeq,
    )

    yield* Deferred.succeed(gate, void 0)

    const [scheduledExit, humanExit] = yield* Effect.all([Fiber.await(scheduled), Fiber.await(human)])
    expect(Exit.isSuccess(scheduledExit)).toBe(true)
    expect(Exit.isSuccess(humanExit)).toBe(true)
    expect(yield* llm.calls).toBe(2)
    expect((yield* SessionInput.findEntry(db, SessionMessage.ID.make(humanID)))?.promotedSeq).toBeDefined()

    const messages = yield* llm.inputs
    expect(messages).toHaveLength(2)
    const second = messages.at(-1)?.messages
    if (!Array.isArray(second)) throw new Error("expected second LLM input")
    expect(second.at(-1)).toEqual({ role: "user", content: "human takes focus" })

    const transcript = yield* sessions.messages({ sessionID: chat.id })
    const final = transcript.filter((message) => message.info.role === "assistant").at(-1)
    if (!final || final.info.role !== "assistant") throw new Error("expected final Scheduled assistant")
    expect(final.info.parentID).toBe(humanID)
    expect(final.parts.some((part) => part.type === "text" && part.text === "human-second")).toBe(true)
    }),
  15_000,
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    const cancelStarted = Date.now()
    yield* prompt.cancel(chat.id)
    console.log("assert-busy cancel ms", Date.now() - cancelStarted)
    const awaitStarted = Date.now()
    yield* Fiber.await(fiber)
    console.log("assert-busy await ms", Date.now() - awaitStarted)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

if (process.platform === "win32") {
  it.instance(
    "shell executes configured cmd through the tested Node shell adapter",
    () =>
      Effect.gen(function* () {
        const cmd = process.env.COMSPEC || Bun.which("cmd.exe")
        if (!cmd) return
        yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: cmd,
        }))
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "echo configured-cmd",
        })
        const tool = completedTool(result.parts)
        expect(tool?.state.output).toContain("configured-cmd")
      }),
    30_000,
  )

  it.instance(
    "shell rejects multiline cmd before durable turn admission",
    () =>
      Effect.gen(function* () {
        const cmd = process.env.COMSPEC || Bun.which("cmd.exe")
        if (!cmd) return
        yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: cmd,
        }))
        const { prompt, sessions, chat } = yield* boot()
        const before = yield* sessions.messages({ sessionID: chat.id })
        const exit = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            command: "echo one\necho two",
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toContain("multiline cmd.exe program")
        }
        expect(yield* sessions.messages({ sessionID: chat.id })).toHaveLength(before.length)
      }),
    30_000,
  )

  it.instance(
    "shell rejects lossy inherited cmd expansion before process execution",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const key = "OPENFORK_CMD_ENV_LIMIT_SESSION"
          const previous = process.env[key]
          process.env[key] = "x".repeat(Shell.CMD_INHERITED_ENV_LIMIT + 1)
          return { key, previous }
        }),
        ({ key }) =>
          Effect.gen(function* () {
            const cmd = process.env.COMSPEC || Bun.which("cmd.exe")
            if (!cmd) return
            yield* useServerConfig((url) => ({
              ...providerCfg(url),
              shell: cmd,
            }))
            const { prompt, sessions, chat } = yield* boot()
            const exit = yield* prompt
              .shell({
                sessionID: chat.id,
                agent: "build",
                command: `if "%${key}%"=="" (echo SILENT-WRONG-BRANCH) else (echo expected)`,
              })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(String(Cause.squash(exit.cause))).toContain("Cannot execute this cmd.exe script faithfully")
            }
          }),
        ({ key, previous }) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env[key]
            else process.env[key] = previous
          }),
      ),
    30_000,
  )

  it.instance(
    "shell transports large Git Bash source without the old MSYS argv ceiling",
    () =>
      withSh(() =>
        Effect.gen(function* () {
          if (!(yield* hasBash)) return
          yield* useServerConfig((url) => ({
            ...providerCfg(url),
            shell: "bash",
          }))
          const { prompt, sessions, chat } = yield* boot()
          const before = yield* sessions.messages({ sessionID: chat.id })
          const size = 100_000
          const source = "X=" + "x".repeat(size) + "; printf '%s' \"\${#X}\""

          const result = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: source })
          const tool = completedTool(result.parts)
          expect(tool?.state.output.trim()).toBe(String(size))
          const after = yield* sessions.messages({ sessionID: chat.id })
          expect(after).toHaveLength(before.length + 2)
        }),
      ),
    30_000,
  )

  it.instance(
    "shell transports Git Bash source beyond the old MSYS argv boundary",
    () =>
      withSh(() =>
        Effect.gen(function* () {
          if (!(yield* hasBash)) return
          yield* useServerConfig((url) => ({
            ...providerCfg(url),
            shell: "bash",
          }))
          const { prompt, chat } = yield* boot()
          const source = "printf '%s' '" + "x".repeat(10_000) + "' | wc -c"
          const result = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: source })
          const tool = completedTool(result.parts)
          if (!tool) return
          expect(tool.state.output.trim()).toBe("10000")
        }),
      ),
    30_000,
  )


  it.instance(
    "shell transports oversized Windows PowerShell source beyond the native argv boundary",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const key = Shell.POWERSHELL_SCRIPT_SOURCE_ENV_PREFIX + "9999"
          const previous = process.env[key]
          process.env[key] = "stale-transport-value"
          return { key, previous }
        }),
        () =>
          Effect.gen(function* () {
            const pwsh = Bun.which("pwsh") || Bun.which("powershell")
            if (!pwsh) return
            yield* useServerConfig((url) => ({
              ...providerCfg(url),
              shell: pwsh,
            }))
            const { prompt, sessions, chat } = yield* boot()
            const before = yield* sessions.messages({ sessionID: chat.id })
            const source = [
              `#${"x".repeat(Shell.POWERSHELL_INLINE_SCRIPT_LIMIT + 5_000)}`,
              "Write-Output 'large-powershell-ok'",
              `Write-Output ([bool](Get-ChildItem Env:${Shell.POWERSHELL_SCRIPT_SOURCE_ENV_PREFIX}* -ErrorAction SilentlyContinue))`,
            ].join("\n")
            const result = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: source })
            const tool = completedTool(result.parts)
            expect(tool?.state.output.trim().replaceAll("\r\n", "\n")).toBe("large-powershell-ok\nFalse")
            const after = yield* sessions.messages({ sessionID: chat.id })
            expect(after).toHaveLength(before.length + 2)
          }),
        ({ key, previous }) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env[key]
            else process.env[key] = previous
          }),
      ),
    30_000,
  )

  it.instance(
    "shell rejects NUL source before durable turn admission",
    () =>
      Effect.gen(function* () {
        const pwsh = Bun.which("pwsh") || Bun.which("powershell")
        if (!pwsh) return
        yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: pwsh,
        }))
        const { prompt, sessions, chat } = yield* boot()
        const before = yield* sessions.messages({ sessionID: chat.id })
        const exit = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "Write-Output before\0after" })
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("NUL byte")
        const after = yield* sessions.messages({ sessionID: chat.id })
        expect(after).toHaveLength(before.length)
      }),
    30_000,
  )
}

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "command ! expansion uses configured shell over env shell across platforms",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf '%s' 'configured|$HOME|$(printf nested)|\\tail\\'`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        const messages = JSON.stringify(inputs.at(-1)?.messages)
        expect(messages).toContain("configured|$HOME|$(printf nested)|\\\\tail\\\\")
      }),
    ),
  30_000,
)

if (process.platform === "win32") {
  it.instance(
    "command ! expansion transports large Git Bash source before provider execution",
    () =>
      withSh(() =>
        Effect.gen(function* () {
          if (!(yield* hasBash)) return
          const size = 100_000
          const source = "X=" + "x".repeat(size) + "; printf '%s' \"\${#X}\""
          const { llm } = yield* useServerConfig((url) => ({
            ...providerCfg(url),
            shell: "bash",
            command: {
              probe: {
                template: `Probe: !\`${source}\``,
              },
            },
          }))

          const { prompt, chat } = yield* boot()
          yield* llm.text("done")
          const result = yield* prompt.command({
            sessionID: chat.id,
            command: "probe",
            arguments: "",
          })

          expect(result.info.role).toBe("assistant")
          const inputs = yield* llm.inputs
          const messages = JSON.stringify(inputs.at(-1)?.messages)
          expect(messages).toContain(`Probe: ${size}`)
          expect(messages).not.toContain("x".repeat(1_000))
        }),
      ),
    30_000,
  )

  it.instance(
    "command ! expansion transports Git Bash source beyond the old MSYS argv boundary",
    () =>
      withSh(() =>
        Effect.gen(function* () {
          if (!(yield* hasBash)) return
          const source = "printf '%s' '" + "x".repeat(10_000) + "' | wc -c"
          const { llm } = yield* useServerConfig((url) => ({
            ...providerCfg(url),
            shell: "bash",
            command: {
              probe: {
                template: "Probe: !`" + source + "`",
              },
            },
          }))

          const { prompt, chat } = yield* boot()
          yield* llm.text("done")
          yield* prompt.command({
            sessionID: chat.id,
            command: "probe",
            arguments: "",
          })
          const inputs = yield* llm.inputs
          expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("10000")
        }),
      ),
    30_000,
  )
}

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
