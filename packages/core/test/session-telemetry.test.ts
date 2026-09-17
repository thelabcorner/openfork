import { describe, expect } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionTelemetry.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

const SESSION_ID = "ses_telemetry_test"

const seed = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`
    INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
    VALUES ('prj_telemetry_test', '/repo', 1, 1, '[]')
  `)
  yield* db.run(sql`
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES (${SESSION_ID}, 'prj_telemetry_test', 'telemetry', '/repo', 'Telemetry', 'test', 1, 1)
  `)
})

describe("SessionTelemetry", () => {
  it.live("tracks provider phases and persists one compact settlement snapshot", () =>
    Effect.gen(function* () {
      yield* seed()
      const telemetry = yield* SessionTelemetry.Service

      yield* telemetry.begin({
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        requestSentAt: 1_000,
        model: { providerID: "openai", modelID: "gpt-test", variant: "high", contextLimit: 200_000 },
      })
      expect((yield* telemetry.snapshot([SESSION_ID]))[SESSION_ID]?.phase).toBe("requesting")

      yield* telemetry.observe({ sessionID: SESSION_ID, at: 1_100, event: LLMEvent.reasoningStart({ id: "r1" }) })
      yield* telemetry.observe({
        sessionID: SESSION_ID,
        at: 1_200,
        event: LLMEvent.reasoningDelta({ id: "r1", text: "think" }),
      })
      expect((yield* telemetry.snapshot([SESSION_ID]))[SESSION_ID]?.phase).toBe("reasoning")

      yield* telemetry.observe({ sessionID: SESSION_ID, at: 1_500, event: LLMEvent.reasoningEnd({ id: "r1" }) })
      yield* telemetry.observe({ sessionID: SESSION_ID, at: 1_600, event: LLMEvent.textStart({ id: "t1" }) })
      yield* telemetry.observe({
        sessionID: SESSION_ID,
        at: 1_700,
        event: LLMEvent.textDelta({ id: "t1", text: "hello world" }),
      })
      expect((yield* telemetry.snapshot([SESSION_ID]))[SESSION_ID]?.phase).toBe("generating")
      yield* telemetry.observe({ sessionID: SESSION_ID, at: 2_100, event: LLMEvent.textEnd({ id: "t1" }) })

      yield* telemetry.observe({
        sessionID: SESSION_ID,
        at: 2_200,
        event: LLMEvent.toolCall({ id: "tool_1", name: "read", input: { path: "README.md" } }),
      })
      expect((yield* telemetry.snapshot([SESSION_ID]))[SESSION_ID]?.phase).toBe("tool")
      yield* telemetry.streamed(SESSION_ID, 2_300)
      yield* telemetry.observe({
        sessionID: SESSION_ID,
        at: 2_700,
        event: LLMEvent.toolResult({
          id: "tool_1",
          name: "read",
          result: { type: "text", value: "ok" },
        }),
      })

      yield* telemetry.settle({
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        completedAt: 2_800,
        tokens: { input: 100, output: 40, reasoning: 20, cache: { read: 300, write: 5 } },
      })

      const settled = (yield* telemetry.snapshot([SESSION_ID]))[SESSION_ID]
      expect(settled).toMatchObject({
        sessionID: SESSION_ID,
        phase: "requesting",
        model: { providerID: "openai", modelID: "gpt-test", variant: "high", contextLimit: 200_000 },
        context: {
          model: { providerID: "openai", modelID: "gpt-test", variant: "high", contextLimit: 200_000 },
          tokens: { input: 100, output: 40, reasoning: 20, cache: { read: 300, write: 5 } },
        },
        step: {
          assistantMessageID: "msg_1",
          requestSentAt: 1_000,
          firstTokenAt: 1_100,
          streamedAt: 2_300,
          completedAt: 2_800,
          visibleChars: 11,
          reasoningChars: 5,
          generatedMs: 900,
          toolMs: 500,
          tokens: { input: 100, output: 40, reasoning: 20, cache: { read: 300, write: 5 } },
        },
        generatedMs: 900,
        toolMs: 500,
      })

      // Step settlement is not session settlement: an agent may immediately
      // continue into another provider turn. Only the runner knows when the
      // whole drain is actually idle.
      yield* telemetry.idle(SESSION_ID, 2_900)
      expect((yield* telemetry.snapshot([SESSION_ID]))[SESSION_ID]?.phase).toBe("idle")

      // A second step accumulates durations instead of rescanning old history.
      yield* telemetry.begin({
        sessionID: SESSION_ID,
        assistantMessageID: "msg_2",
        requestSentAt: 3_000,
        model: { providerID: "openai", modelID: "gpt-test", contextLimit: 200_000 },
      })
      yield* telemetry.observe({ sessionID: SESSION_ID, at: 3_100, event: LLMEvent.textStart({ id: "t2" }) })
      yield* telemetry.observe({
        sessionID: SESSION_ID,
        at: 3_200,
        event: LLMEvent.textDelta({ id: "t2", text: "done" }),
      })
      yield* telemetry.observe({ sessionID: SESSION_ID, at: 3_400, event: LLMEvent.textEnd({ id: "t2" }) })
      yield* telemetry.streamed(SESSION_ID, 3_450)
      yield* telemetry.settle({
        sessionID: SESSION_ID,
        assistantMessageID: "msg_2",
        completedAt: 3_500,
        tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 50, write: 0 } },
      })

      const second = (yield* telemetry.snapshot([SESSION_ID]))[SESSION_ID]
      expect(second?.generatedMs).toBe(1_200)
      expect(second?.toolMs).toBe(500)
      expect(second?.step?.tokens?.output).toBe(10)
    }),
  )
})
