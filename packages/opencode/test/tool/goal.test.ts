import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { GoalAgent } from "@opencode-ai/core/goal/agent"
import { GoalTool } from "../../src/tool/goal"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const captured: Array<Parameters<GoalAgent.Interface["execute"]>[2]> = []
const detail = {
  goal: {
    id: "goal_v1_provenance",
    revision: 1,
    status: "active",
  },
  criteria: [],
  steps: [],
} as any

const goal = Layer.succeed(
  GoalAgent.Service,
  GoalAgent.Service.of({
    execute: (_sessionID, _input, turn) =>
      Effect.sync(() => {
        captured.push(turn)
        return { action: "create", goal: detail }
      }) as any,
  }),
)

const truncate = Layer.succeed(
  Truncate.Service,
  Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.succeed("unused"),
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

const it = testEffect(Layer.mergeAll(goal, truncate, agent))

describe("tool.goal", () => {
  it.effect("passes trusted V1 user-turn provenance to GoalAgent creation", () =>
    Effect.gen(function* () {
      captured.length = 0
      const info = yield* GoalTool
      const tool = yield* info.init()
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_goal_v1"),
        messageID: MessageID.make("msg_goal_v1_assistant"),
        callID: "call_goal_create",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [
          {
            info: { id: MessageID.make("msg_goal_proposal"), role: "assistant" },
            parts: [{ type: "text", text: "This is multi-step work. Should I create a Goal and start it for you?" }],
          },
          {
            info: { id: MessageID.make("msg_goal_confirm"), role: "user" },
            parts: [{ type: "text", text: "Yes, do it." }],
          },
        ] as any,
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      yield* tool.execute(
        { action: "create", objective: "Finish the work", criteria: ["The work is verified"] },
        ctx,
      )

      expect(captured).toEqual([
        {
          userMessageID: "msg_goal_confirm",
          userText: "Yes, do it.",
          previousAssistantText: "This is multi-step work. Should I create a Goal and start it for you?",
        },
      ])
    }),
  )
})
