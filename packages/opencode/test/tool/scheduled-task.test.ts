import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ScheduledTaskAgent } from "@opencode-ai/core/scheduled-task/agent"
import { ScheduledTaskTool } from "../../src/tool/scheduled-task"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const captured: Array<Parameters<ScheduledTaskAgent.Interface["create"]>[2]> = []
const executed: Array<{
  sessionID: string
  input: ScheduledTaskAgent.Input
  turn: Parameters<ScheduledTaskAgent.Interface["execute"]>[2]
}> = []
const task = {
  id: "stk_tool",
  name: "Nightly audit",
  enabled: true,
  nextRunAt: 1_800_000_000_000,
} as any

const scheduled = Layer.succeed(
  ScheduledTaskAgent.Service,
  ScheduledTaskAgent.Service.of({
    create: (_sessionID, _input, turn) =>
      Effect.sync(() => {
        captured.push(turn)
        return { task, created: true }
      }) as any,
    execute: (sessionID, input, turn) =>
      Effect.sync(() => {
        captured.push(turn)
        executed.push({ sessionID: String(sessionID), input, turn })
        if (input.action === "set_enabled") {
          return {
            action: "set_enabled",
            task: { ...task, enabled: input.enabled, revision: input.expectedRevision + 1 },
          }
        }
        return { action: "create", task, created: true }
      }) as any,
  }),
)

const truncate = Layer.succeed(
  Truncate.Service,
  Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.succeed("unused"),
    writer: () =>
      Effect.succeed({
        outputPath: "unused.br",
        write: () => Effect.void,
        close: Effect.void,
        healthy: () => true,
      }),
    output: (text) => Effect.succeed({ content: text, truncated: false as const }),
    limits: () => Effect.succeed({ maxLines: 2_000, maxBytes: 50 * 1024 }),
  }),
)

const agent = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} } as any),
    list: () => Effect.succeed([]),
    defaultInfo: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} } as any),
    defaultAgent: () => Effect.succeed("build"),
    generate: () => Effect.die("unused"),
  }),
)

const it = testEffect(Layer.mergeAll(scheduled, truncate, agent))

describe("tool.scheduled_task", () => {
  it.effect("passes trusted current human-turn provenance to ScheduledTaskAgent creation", () =>
    Effect.gen(function* () {
      captured.length = 0
      executed.length = 0
      const info = yield* ScheduledTaskTool
      const tool = yield* info.init()
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_schedule"),
        messageID: MessageID.make("msg_schedule_assistant"),
        callID: "call_schedule_create",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [
          {
            info: { id: MessageID.make("msg_schedule_proposal"), role: "assistant" },
            parts: [{ type: "text", text: "Would you like me to schedule a daily task at 9am for this?" }],
          },
          {
            info: { id: MessageID.make("msg_schedule_confirm"), role: "user" },
            parts: [{ type: "text", text: "Yes, do it." }],
          },
        ] as any,
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const result = yield* tool.execute(
        {
          name: "Nightly audit",
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          timezone: "America/Chicago",
          prompt: "Run the dependency audit.",
        },
        ctx,
      )

      expect(captured).toEqual([
        {
          userMessageID: "msg_schedule_confirm",
          userText: "Yes, do it.",
          previousAssistantText: "Would you like me to schedule a daily task at 9am for this?",
        },
      ])
      expect(result.metadata).toMatchObject({
        action: "create",
        taskID: "stk_tool",
        created: true,
        enabled: true,
        nextRunAt: 1_800_000_000_000,
      })
    }),
  )

  it.effect("does not borrow stale human scheduling consent across a newer host worker root", () =>
    Effect.gen(function* () {
      captured.length = 0
      executed.length = 0
      const info = yield* ScheduledTaskTool
      const tool = yield* info.init()
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_schedule_host"),
        messageID: MessageID.make("msg_schedule_host_assistant"),
        callID: "call_schedule_host",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [
          {
            info: { id: MessageID.make("msg_old_user"), role: "user" },
            parts: [{ type: "text", text: "Schedule this every day at 9." }],
          },
          {
            info: {
              id: MessageID.make("msg_host_root"),
              role: "user",
              provenance: { owner: "host", source: "scheduled-task.run", ref: "str_host" },
            },
            parts: [{ type: "text", text: "Run scheduled work", synthetic: true }],
          },
        ] as any,
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      yield* tool.execute(
        {
          name: "Should be rejected by Core",
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          prompt: "Do work.",
        },
        ctx,
      )

      expect(captured).toEqual([undefined])
    }),
  )

  it.effect("forwards explicit management mutations and current human-turn provenance to ScheduledTaskAgent", () =>
    Effect.gen(function* () {
      captured.length = 0
      executed.length = 0
      const info = yield* ScheduledTaskTool
      const tool = yield* info.init()
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_schedule_manage"),
        messageID: MessageID.make("msg_schedule_manage_assistant"),
        callID: "call_schedule_disable",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [
          {
            info: { id: MessageID.make("msg_schedule_manage_user"), role: "user" },
            parts: [{ type: "text", text: "Disable the Nightly audit scheduled task." }],
          },
        ] as any,
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const result = yield* tool.execute(
        {
          action: "set_enabled",
          taskID: "stk_tool" as any,
          enabled: false,
          expectedRevision: 3,
        },
        ctx,
      )

      expect(executed).toHaveLength(1)
      expect(executed[0]).toEqual({
        sessionID: "ses_schedule_manage",
        input: {
          action: "set_enabled",
          taskID: "stk_tool" as any,
          enabled: false,
          expectedRevision: 3,
        },
        turn: {
          userMessageID: "msg_schedule_manage_user",
          userText: "Disable the Nightly audit scheduled task.",
          previousAssistantText: undefined,
        },
      })
      expect(result.metadata).toMatchObject({
        action: "set_enabled",
        taskID: "stk_tool",
        enabled: false,
      })
      expect(JSON.parse(result.output)).toMatchObject({
        action: "set_enabled",
        task: { id: "stk_tool", enabled: false, revision: 4 },
      })
    }),
  )
})
