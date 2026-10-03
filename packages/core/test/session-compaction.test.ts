import { expect, test } from "bun:test"
import { LLM, LLMEvent, Message, Model, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTurnProvenance } from "@opencode-ai/core/session/turn-provenance"
import { DateTime, Effect, Stream } from "effect"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction tool projection preserves both beginning and terminal failure context", () => {
  const input = "BEGIN\n" + "x".repeat(5_000) + "\nTERMINAL-FAILURE"
  const projected = SessionCompaction.compactToolOutput(input)
  expect(projected).toContain("BEGIN")
  expect(projected).toContain("TERMINAL-FAILURE")
  expect(projected).toContain("showing beginning + end")
  expect(Buffer.byteLength(projected, "utf-8")).toBeLessThanOrEqual(500)
})

test("compaction excludes mutable Goal state snapshots while retaining historical Goal continuation events", async () => {
  const sessionID = SessionSchema.ID.make("ses_compaction_goal_state")
  const rootID = SessionMessage.ID.make("msg_goal_root")
  const state = (id: string, source: string, text: string) =>
    SessionMessage.Synthetic.make({
      id: SessionMessage.ID.make(id),
      type: "synthetic",
      sessionID,
      text,
      provenance: SessionTurnProvenance.host(source, { ref: `goal-state:test:${id}` }),
      time: { created: DateTime.makeUnsafe(1) },
    })
  const continuation = SessionMessage.Synthetic.make({
    id: SessionMessage.ID.make("msg_goal_continuation_history"),
    type: "synthetic",
    sessionID,
    text: "HISTORICAL-GOAL-CONTINUATION",
    provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalContinuation, {
      sourceMessageID: rootID,
      ref: "reservation-test",
    }),
    time: { created: DateTime.makeUnsafe(2) },
  })
  const historicalState = SessionMessage.Synthetic.make({
    id: SessionMessage.ID.make("msg_goal_progress_imported"),
    type: "synthetic",
    sessionID,
    text: "IMPORTED-STALE-GOAL-PROGRESS",
    provenance: {
      ...SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalProgress, {
        ref: "goal-state:test:imported",
      }),
      lifetime: "historical",
    },
    time: { created: DateTime.makeUnsafe(2) },
  })
  const root = SessionMessage.User.make({
    id: rootID,
    type: "user",
    text: "ROOT-USER-REQUEST " + "x".repeat(24_000),
    provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
    time: { created: DateTime.makeUnsafe(0) },
  })
  const entries = [
    { seq: 1, message: state("msg_goal_spec_old", SessionTurnProvenance.Source.GoalSpecification, "STALE-GOAL-SPEC") },
    { seq: 2, message: state("msg_goal_progress_old", SessionTurnProvenance.Source.GoalProgress, "STALE-GOAL-PROGRESS") },
    { seq: 3, message: historicalState },
    { seq: 4, message: root },
    { seq: 5, message: continuation },
  ]
  const requests: LLMRequest[] = []
  const published: Array<{ definition: unknown; payload: unknown }> = []
  const model = Model.make({
    id: "compaction-test",
    provider: "test",
    route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
  })
  const compaction = SessionCompaction.make({
    events: {
      publish: ((definition: unknown, payload: unknown) => {
        published.push({ definition, payload })
        return Effect.succeed({ durable: { seq: published.length } })
      }) as never,
    } as never,
    llm: {
      stream: (request) => {
        requests.push(request)
        return Stream.fromIterable([
          LLMEvent.textStart({ id: "summary" }),
          LLMEvent.textDelta({ id: "summary", text: "summary" }),
          LLMEvent.textEnd({ id: "summary" }),
          LLMEvent.finish({ reason: "stop" }),
        ])
      },
    },
    // Deliberately smaller than the continuation itself. The active Goal
    // handoff must remain verbatim in the retained tail regardless of this
    // user-tunable compaction budget.
    config: [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          compaction: new ConfigCompaction.Info({
            keep: new ConfigCompaction.Keep({ tokens: 1 }),
          }),
        }),
      }),
    ],
  })
  const request = LLM.request({ model, system: [], messages: [Message.user("provider request")], tools: [] })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({ sessionID, entries, model, request, sourceMessageID: rootID }),
    ),
  ).toBe(true)
  expect(requests).toHaveLength(1)
  const summaryPrompt = JSON.stringify(requests[0]?.messages)
  expect(summaryPrompt).toContain("ROOT-USER-REQUEST")
  expect(summaryPrompt).not.toContain("STALE-GOAL-SPEC")
  expect(summaryPrompt).not.toContain("STALE-GOAL-PROGRESS")
  expect(summaryPrompt).not.toContain("IMPORTED-STALE-GOAL-PROGRESS")
  const ended = published.at(-1)?.payload as { recent?: string } | undefined
  expect(ended?.recent).toContain("HISTORICAL-GOAL-CONTINUATION")
  expect(ended?.recent).not.toContain("STALE-GOAL-SPEC")
  expect(ended?.recent).not.toContain("STALE-GOAL-PROGRESS")
})
