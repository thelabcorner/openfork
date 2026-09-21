import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskLease } from "@opencode-ai/core/scheduled-task/lease"
import { ScheduledTaskTable } from "@opencode-ai/core/scheduled-task/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { ForkCredentials } from "@/fork/credentials"
import { Git } from "@/git"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "@/question"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SystemPrompt } from "@/session/system"
import { Snapshot } from "@/snapshot"
import { Skill } from "@/skill"
import { Todo } from "@/session/todo"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { ToolInterrupt } from "@/tool/interrupt"
import { Image } from "@/image/image"
import { LSP } from "@/lsp/lsp"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ScheduledTaskExecutor } from "@/scheduled-task/executor"
import { ScheduledTaskRunner } from "@/scheduled-task/runner"
import { tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

/**
 * The end-to-end proof: a durable scheduled task actually fires unattended.
 *
 * Path exercised: ScheduledTask row -> runner due scan -> lease claim ->
 * recordRunStart -> executor (Tier 3 instance load) -> session create ->
 * hostPrompt -> fake provider reply -> settleRun -> cursor exhaustion.
 */
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

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    exactTools: () => Effect.succeed([]),
    invokeTool: () => Effect.die("unexpected MCP tool invocation in scheduled e2e test"),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in scheduled e2e test"),
    authenticate: () => Effect.die("unexpected MCP auth in scheduled e2e test"),
    finishAuth: () => Effect.die("unexpected MCP auth in scheduled e2e test"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const root = LayerNode.group([
  testLLMServerNode,
  SessionPrompt.node,
  Session.node,
  InstanceStore.node,
  ScheduledTask.node,
  ScheduledTaskLease.node,
  ScheduledTaskRunner.node,
  ScheduledTaskExecutor.node,
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
  ForkCredentials.node,
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

const it = testEffect(
  AppNodeBuilderV1.build(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, runtimeFlags],
  ]),
)

const assistantText = (messages: SessionV1.WithParts[]) =>
  messages
    .flatMap((message) => (message.info.role === "assistant" ? message.parts : []))
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")

describe("scheduled task end-to-end", () => {
  it.live(
    "fires unattended, prompts the model, and settles the run",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        // Configuration must exist before ScheduledTaskExecutor is allowed to
        // materialize the target Instance. Writing it after an .instance test
        // wrapper now races the real InstanceBootstrap config gate.
        const dir = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
        const tasks = yield* ScheduledTask.Service
        const sessions = yield* Session.Service
        const runner = yield* ScheduledTaskRunner.Service
        const { db } = yield* Database.Service

        const task = yield* tasks.create({
          targetDirectory: dir,
          name: "e2e-scheduled",
          enabled: true,
          schedule: { kind: "once", at: Date.now() + 60_000 },
          timezone: "UTC",
          action: {
            prompt: "say hello",
            agent: "build",
            model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
          },
        })

        // Make the durable cursor due now (within the on-time grace window)
        // instead of waiting for the scheduled instant.
        yield* db
          .update(ScheduledTaskTable)
          .set({ next_run_at: Date.now() - 5_000 })
          .where(eq(ScheduledTaskTable.id, task.id))
          .run()
          .pipe(Effect.orDie)

        yield* llm.text("hello from the scheduler")
        yield* runner.start({ startupGraceMs: 0 })
        yield* runner.poke()

        const run = yield* pollWithTimeout(
          Effect.gen(function* () {
            const rows = yield* tasks.listRuns({ taskID: task.id })
            const row = rows[0]
            return row && row.status !== "running" && row.status !== "queued" ? row : undefined
          }),
          "scheduled run never settled",
          "30 seconds",
        )
        expect(run).toMatchObject({ status: "succeeded" })
        expect(run.trigger).toBe("schedule")
        expect(run.sessionID).toBeDefined()
        yield* awaitWithTimeout(llm.wait(1), "model was never called", "10 seconds")

        // `once` is exhausted after firing: cursor null, task disabled.
        const after = yield* tasks.get(task.id)
        expect(after.nextRunAt).toBeUndefined()
        expect(after.enabled).toBe(false)
        expect(after.lastRunStatus).toBe("succeeded")

        // The run created a real session whose transcript contains the reply.
        const session = yield* sessions.get(run.sessionID!)
        expect(session.title).toContain("e2e-scheduled")
        const messages = yield* sessions.messages({ sessionID: run.sessionID! })
        expect(messages.length).toBeGreaterThan(0)
        expect(assistantText(messages)).toContain("hello from the scheduler")
        const scheduledTurn = messages.find(
          (message) =>
            message.info.role === "user" &&
            message.info.provenance?.owner === "host" &&
            message.info.provenance.source === SessionTurnProvenance.Source.ScheduledTaskRun &&
            message.info.provenance.ref === run.id,
        )
        expect(scheduledTurn).toBeDefined()
        expect(SessionTurnProvenance.semanticKind(scheduledTurn!)).toBe("synthetic")
        expect(SessionTurnProvenance.isWorkerPromptTurn(scheduledTurn!)).toBe(true)
        expect(SessionTurnProvenance.isGoalAuthorizationTurn(scheduledTurn!)).toBe(false)
        expect(SessionTurnProvenance.causalRootMessageID(scheduledTurn!)).toBe(scheduledTurn!.info.id)
      }),
    60_000,
  )

  it.live(
    "run now enqueues and executes a manual run for a disabled task",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const dir = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
        const tasks = yield* ScheduledTask.Service
        const runner = yield* ScheduledTaskRunner.Service

        const task = yield* tasks.create({
          targetDirectory: dir,
          name: "e2e-manual",
          enabled: false,
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          timezone: "UTC",
          action: {
            prompt: "say hello",
            agent: "build",
            model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
          },
        })

        yield* llm.text("hello from run-now")
        yield* runner.start({ startupGraceMs: 0 })
        const queued = yield* tasks.enqueueManualRun({ taskID: task.id, now: Date.now() })
        expect(queued.status).toBe("queued")
        yield* runner.poke()

        const run = yield* pollWithTimeout(
          Effect.gen(function* () {
            const rows = yield* tasks.listRuns({ taskID: task.id })
            const row = rows.find((item) => item.id === queued.id)
            return row && row.status !== "running" && row.status !== "queued" ? row : undefined
          }),
          "manual run never settled",
          "30 seconds",
        )
        expect(run).toMatchObject({ status: "succeeded" })
        expect(run.trigger).toBe("manual")
        // A manual run never enables or schedules the task.
        const after = yield* tasks.get(task.id)
        expect(after.enabled).toBe(false)
        expect(after.nextRunAt).toBeUndefined()
      }),
    60_000,
  )
})
