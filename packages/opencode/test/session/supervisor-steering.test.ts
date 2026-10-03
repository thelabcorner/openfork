import { afterEach, describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Goal } from "@opencode-ai/core/goal"
import { GoalContext } from "@opencode-ai/core/goal/context"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { Ripgrep } from "@opencode-ai/core/ripgrep"

import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider/provider"
import { Question } from "../../src/question"
import { Session } from "@/session/session"

import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SystemPrompt } from "../../src/session/system"
import { SessionID } from "../../src/session/schema"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { Todo } from "../../src/session/todo"
import { ToolInterrupt } from "@/tool/interrupt"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { raw, TestLLMServer } from "../lib/llm-server"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

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

const mcp = Layer.mock(MCP.Service)({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    exactTools: () => Effect.succeed([]),
    invokeTool: () => Effect.die("unexpected MCP tool invocation in supervisor-steering tests"),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: {} }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected auth in supervisor-steering tests"),
    authenticate: () => Effect.die("unexpected auth in supervisor-steering tests"),
    finishAuth: () => Effect.die("unexpected auth in supervisor-steering tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated"),
})

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

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
        options: { ...cfg.provider.test.options, baseURL: url },
      },
    },
  }
}

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const steeringRoot = LayerNode.group([
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
  SessionExecutionOwner.node,
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

const compiled = LayerNode.compile(LayerNode.group([steeringRoot, testLLMServerNode]), [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, runtimeFlags],
])

const it = testEffect(compiled)

afterEach(async () => {
  await disposeAllInstances()
})

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* () {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...providerCfg(llm.url) }),
  )
  return { dir, llm }
})

const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "5 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const waitForRetry = (sessionID: SessionID, duration: Duration.Input = "10 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "retry" ? s : undefined
    }),
    `session ${sessionID} never entered retry recovery`,
    duration,
  )

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>) => Effect.runPromise(Deferred.await(deferred))

function lastUserText(message: SessionV1.WithParts) {
  const text = message.parts.findLast((part): part is SessionV1.TextPart => part.type === "text")
  return text?.text
}

function hostSyntheticTexts(messages: SessionV1.WithParts[]) {
  return messages
    .filter((message) => message.info.role === "user" && message.info.provenance?.owner === "host")
    .map((message) => lastUserText(message))
    .filter((text): text is string => text !== undefined)
}

function completedAssistants(messages: SessionV1.WithParts[]) {
  return messages.filter(
    (message) => message.info.role === "assistant" && message.info.time.completed !== undefined,
  )
}

function providerUserTexts(body: Record<string, unknown>) {
  const messages = body.messages
  if (!Array.isArray(messages)) return []
  return messages
    .filter(
      (message): message is { role: string; content?: unknown } => !!message && typeof message === "object" && "role" in message,
    )
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")))
}

const startWorker = Effect.fn("test.startWorker")(function* (sessionID: SessionID, text: string) {
  const prompt = yield* SessionPrompt.Service
  return yield* prompt
    .hostPrompt({
      sessionID,
      agent: "build",
      model: ref,
      parts: [{ type: "text", text }],
    })
    .pipe(Effect.forkChild)
})

const entries = Effect.fn("test.entries")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  return yield* db
    .select()
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, SessionSchema.ID.make(sessionID)))
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
})

const steerEntry = Effect.fn("test.steerEntry")(function* (sessionID: SessionID) {
  const row = (yield* entries(sessionID)).find((entry) => entry.delivery === "steer")
  if (!row) throw new Error("expected a durable steer input")
  return row
})

const waitPromoted = Effect.fn("test.waitPromoted")(function* (
  sessionID: SessionID,
  id: SessionMessage.ID,
  duration: Duration.Input = "10 seconds",
) {
  const { db } = yield* Database.Service
  return yield* pollWithTimeout(
    SessionInput.findEntry(db, id).pipe(
      Effect.map((entry) => (entry?.promotedSeq === undefined ? undefined : entry)),
    ),
    `session ${sessionID} input ${id} was never promoted`,
    duration,
  )
})

describe("supervisor soft steering", () => {
  it.instance(
    "steer stays in the same child session and admits a durable host+steer row that is not promoted mid-turn",
    () =>
      Effect.gen(function* () {
        yield* useServerConfig()
        const llm = yield* TestLLMServer
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const { db } = yield* Database.Service

        const parent = yield* sessions.create({ title: "Supervisor parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Supervised worker" })

        const gate = yield* Deferred.make<void>()
        yield* llm.hold("first-turn-body", deferredAsPromise(gate))
        yield* llm.text("after-steer-body")
        yield* startWorker(child.id, "implement the parser")
        yield* llm.wait(1)
        yield* waitForBusy(child.id)

        const beforeRows = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
        const admitted = yield* prompt.steer({
          sessionID: child.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "stop the custom parser; reuse the AST layer" }],
        })

        expect(admitted.info.sessionID).toBe(child.id)

        const afterRows = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
        expect(afterRows.map((row) => row.id).sort()).toEqual(beforeRows.map((row) => row.id).sort())
        expect(afterRows.filter((row) => row.id === child.id)).toHaveLength(1)
        const reloaded = yield* sessions.get(child.id)
        expect(reloaded.parentID).toBe(parent.id)

        const row = yield* steerEntry(child.id)
        expect(row.admission_class).toBe("host")
        expect(row.delivery).toBe("steer")
        expect(row.promoted_seq).toBeNull()
        expect(row.revoked_seq).toBeNull()

        yield* Deferred.succeed(gate, void 0)
        yield* waitPromoted(child.id, SessionMessage.ID.make(row.id))
      }),
    30_000,
  )

  it.instance(
    "steer preempts an unproven provider retry instead of queueing behind a stalled transport",
    () =>
      Effect.gen(function* () {
        yield* useServerConfig()
        const llm = yield* TestLLMServer
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const ownership = yield* SessionExecutionOwner.Service

        const parent = yield* sessions.create({ title: "Supervisor parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Supervised worker" })
        const gate = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, void 0).pipe(Effect.asVoid))

        yield* llm.error(503, { error: "transient upstream failure" })
        yield* llm.push(raw({ head: [], wait: deferredAsPromise(gate), hang: true }))
        yield* llm.text("after-retry-steer")

        const worker = yield* startWorker(child.id, "implement the parser")
        yield* llm.wait(2)
        const retry = yield* waitForRetry(child.id)
        expect(retry.attempt).toBe(1)
        const before = yield* ownership.snapshot(child.id)
        expect(before.ownerID).toBeDefined()

        const admitted = yield* prompt.steer({
          sessionID: child.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "supersede the stalled retry" }],
        })
        expect(admitted.info.sessionID).toBe(child.id)

        // A third provider request must start while gate is still unresolved.
        // If the old retry remains the serialization head this wait times out.
        yield* llm.wait(3)
        const row = yield* steerEntry(child.id)
        yield* waitPromoted(child.id, SessionMessage.ID.make(row.id))

        const workerExit = yield* Fiber.await(worker)
        expect(Exit.isSuccess(workerExit)).toBe(true)
        expect(yield* llm.calls).toBe(3)

        const inputs = yield* llm.inputs
        const thirdProviderTurn = providerUserTexts(inputs.at(-1)!)
        expect(thirdProviderTurn.at(-1)).toBe("supersede the stalled retry")

        const after = yield* ownership.snapshot(child.id)
        expect(after.generation).toBeGreaterThan(before.generation)
        const final = yield* sessions.messages({ sessionID: child.id })
        expect(hostSyntheticTexts(final)).toContain("supersede the stalled retry")
        const aborted = final.find(
          (message) => message.info.role === "assistant" && message.info.error !== undefined,
        )
        expect(aborted?.info.role).toBe("assistant")
        if (aborted?.info.role === "assistant") expect(aborted.info.time.completed).toBeDefined()
      }),
    30_000,
  )

  it.instance(
    "a steer admitted while the child turn is in flight is consumed at the next provider-cycle boundary, not after terminal completion",
    () =>
      Effect.gen(function* () {
        yield* useServerConfig()
        const llm = yield* TestLLMServer
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service

        const parent = yield* sessions.create({ title: "Supervisor parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Supervised worker" })

        const gate = yield* Deferred.make<void>()
        yield* llm.hold("first-turn-body", deferredAsPromise(gate))
        yield* llm.text("after-steer-body")
        yield* startWorker(child.id, "implement the parser")
        yield* llm.wait(1)
        yield* waitForBusy(child.id)

        yield* prompt.steer({
          sessionID: child.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "stop the custom parser; reuse the AST layer" }],
        })

        const midTurn = yield* sessions.messages({ sessionID: child.id })
        expect(hostSyntheticTexts(midTurn)).not.toContain("stop the custom parser; reuse the AST layer")
        expect(completedAssistants(midTurn)).toHaveLength(0)
        const row = yield* steerEntry(child.id)
        expect(row.promoted_seq).toBeNull()

        yield* Deferred.succeed(gate, void 0)
        yield* waitPromoted(child.id, SessionMessage.ID.make(row.id))
        yield* llm.wait(2)

        expect(yield* llm.calls).toBe(2)
        const inputs = yield* llm.inputs
        const secondProviderTurn = providerUserTexts(inputs.at(-1)!)
        expect(secondProviderTurn.at(-1)).toBe("stop the custom parser; reuse the AST layer")

        const final = yield* sessions.messages({ sessionID: child.id })
        expect(hostSyntheticTexts(final)).toContain("stop the custom parser; reuse the AST layer")
      }),
    30_000,
  )

  it.instance(
    "steer does not create a duplicate execution generation or a background job",
    () =>
      Effect.gen(function* () {
        yield* useServerConfig()
        const llm = yield* TestLLMServer
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const ownership = yield* SessionExecutionOwner.Service
        const background = yield* BackgroundJob.Service

        const parent = yield* sessions.create({ title: "Supervisor parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Supervised worker" })

        const gate = yield* Deferred.make<void>()
        yield* llm.hold("first-turn-body", deferredAsPromise(gate))
        yield* llm.text("after-steer-body")
        yield* startWorker(child.id, "implement the parser")
        yield* llm.wait(1)
        yield* waitForBusy(child.id)

        const running = yield* ownership.snapshot(SessionSchema.ID.make(child.id))
        expect(running.ownerID).toBeDefined()

        yield* prompt.steer({
          sessionID: child.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "audit the AST layer instead" }],
        })

        const row = yield* steerEntry(child.id)
        yield* Deferred.succeed(gate, void 0)
        yield* waitPromoted(child.id, SessionMessage.ID.make(row.id))
        yield* llm.wait(2)

        const after = yield* ownership.snapshot(SessionSchema.ID.make(child.id))
        expect(after.generation).toBe(running.generation)
        expect(yield* llm.calls).toBe(2)
        expect((yield* background.list()).filter((job) => job.id === child.id)).toHaveLength(0)
      }),
    30_000,
  )

  it.instance(
    "a steer admitted at the instant the child turn completes is never lost",
    () =>
      Effect.gen(function* () {
        yield* useServerConfig()
        const llm = yield* TestLLMServer
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service

        for (let attempt = 0; attempt < 3; attempt++) {
          const parent = yield* sessions.create({ title: `Supervisor parent ${attempt}` })
          const child = yield* sessions.create({ parentID: parent.id, title: `Supervised worker ${attempt}` })

          const gate = yield* Deferred.make<void>()
          yield* llm.hold("racing-body", deferredAsPromise(gate))
          yield* llm.text("raced-steer-body")
          yield* startWorker(child.id, "implement the parser")
          yield* llm.wait(1)
          yield* waitForBusy(child.id)

          const text = `race steer ${attempt}`
          const steerFiber = yield* prompt
            .steer({ sessionID: child.id, agent: "build", model: ref, parts: [{ type: "text", text }] })
            .pipe(Effect.forkChild)
          yield* Deferred.succeed(gate, void 0)
          const exit = yield* Fiber.await(steerFiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const row = yield* steerEntry(child.id)
          yield* waitPromoted(child.id, SessionMessage.ID.make(row.id))
          const final = yield* sessions.messages({ sessionID: child.id })
          expect(hostSyntheticTexts(final)).toContain(text)
        }
      }),
    30_000,
  )

  it.instance(
    "multiple steers preserve admitted order and promote in that order",
    () =>
      Effect.gen(function* () {
        yield* useServerConfig()
        const llm = yield* TestLLMServer
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service

        const parent = yield* sessions.create({ title: "Supervisor parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Supervised worker" })

        const gate = yield* Deferred.make<void>()
        yield* llm.hold("first-turn-body", deferredAsPromise(gate))
        yield* llm.text("after-steer-body")
        yield* startWorker(child.id, "implement the parser")
        yield* llm.wait(1)
        yield* waitForBusy(child.id)

        const texts = ["steer one", "steer two", "steer three"]
        for (const text of texts) {
          yield* prompt.steer({ sessionID: child.id, agent: "build", model: ref, parts: [{ type: "text", text }] })
        }

        const { db } = yield* Database.Service
        const admitted = (yield* entries(child.id)).filter((row) => row.delivery === "steer")
        const admittedSeqs = admitted.map((row) => row.admitted_seq)
        expect(admittedSeqs).toEqual([...admittedSeqs].sort((left, right) => left - right))
        expect(admitted).toHaveLength(3)
        const admittedTexts = yield* Effect.forEach(admitted, (row) =>
          SessionInput.findEntry(db, SessionMessage.ID.make(row.id)).pipe(
            Effect.map((entry) => (entry?.item.type === "synthetic" ? entry.item.content.text : undefined)),
          ),
        )
        expect(admittedTexts).toEqual(texts)

        yield* Deferred.succeed(gate, void 0)
        for (const row of admitted) {
          yield* waitPromoted(child.id, SessionMessage.ID.make(row.id))
        }
        yield* llm.wait(2)

        const final = yield* sessions.messages({ sessionID: child.id })
        const observed = hostSyntheticTexts(final).filter((text) => texts.includes(text))
        expect(observed).toEqual(texts)
      }),
    30_000,
  )

  it.instance(
    "steer never interrupts the child's in-flight execution",
    () =>
      Effect.gen(function* () {
        yield* useServerConfig()
        const llm = yield* TestLLMServer
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const status = yield* SessionStatus.Service

        const parent = yield* sessions.create({ title: "Supervisor parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Supervised worker" })

        const gate = yield* Deferred.make<void>()
        yield* llm.hold("in-flight-body", deferredAsPromise(gate))
        yield* llm.text("after-steer-body")
        const running = yield* startWorker(child.id, "implement the parser")
        yield* llm.wait(1)
        yield* waitForBusy(child.id)

        yield* prompt.steer({
          sessionID: child.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "keep going but document the AST reuse" }],
        })

        expect((yield* status.get(child.id)).type).toBe("busy")
        expect(yield* llm.calls).toBe(1)
        expect(yield* llm.pending).toBe(1)
        const afterSteer = yield* sessions.messages({ sessionID: child.id })
        expect(completedAssistants(afterSteer)).toHaveLength(0)
        expect(hostSyntheticTexts(afterSteer)).not.toContain("keep going but document the AST reuse")

        yield* Deferred.succeed(gate, void 0)
        const row = yield* steerEntry(child.id)
        yield* waitPromoted(child.id, SessionMessage.ID.make(row.id))
        yield* llm.wait(2)

        expect(Exit.isSuccess(yield* Fiber.await(running))).toBe(true)
        const final = yield* sessions.messages({ sessionID: child.id })
        const assistants = final.filter((message) => message.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        expect(assistants.every((message) => message.info.role !== "assistant" || !message.info.error)).toBe(true)
        const reloaded = yield* sessions.get(child.id)
        expect(reloaded.pausedAt).toBeUndefined()
        expect((yield* status.get(child.id)).type).not.toBe("aborted")
      }),
    30_000,
  )

  it.instance(
    "background continuation remains a sequential BackgroundJob.extend with a single generation",
    () =>
      Effect.gen(function* () {
        const background = yield* BackgroundJob.Service
        const started = yield* Deferred.make<void>()
        const firstRelease = yield* Deferred.make<void>()
        const secondRan = yield* Deferred.make<void>()

        const info = yield* background.start({
          id: "job_supervisor_background",
          type: "task",
          title: "background worker",
          metadata: { background: true },
          run: Effect.gen(function* () {
            yield* Deferred.succeed(started, void 0)
            yield* Deferred.await(firstRelease)
            return "first"
          }),
        })
        yield* Deferred.await(started)
        expect(info.generation).toBe(1)

        const extended = yield* background.extend({
          id: "job_supervisor_background",
          run: Effect.gen(function* () {
            yield* Deferred.succeed(secondRan, void 0)
            return "second"
          }),
        })
        expect(extended).toBe(true)
        expect(yield* background.wait({ id: "job_supervisor_background", timeout: 50 })).toMatchObject({
          timedOut: true,
        })

        yield* Deferred.succeed(firstRelease, void 0)
        yield* Deferred.await(secondRan)
        const settled = yield* background.wait({ id: "job_supervisor_background" })
        expect(settled.info?.status).toBe("completed")
        expect(settled.info?.generation).toBe(1)
        expect(settled.info?.output).toBe("second")

      }),
    30_000,
  )
})
