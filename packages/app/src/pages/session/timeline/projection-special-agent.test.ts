import { expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { SessionMessageInfo } from "@/utils/session-message-info"
import { normalizeSessionMessages } from "@/utils/session-message"

// Keep this a projection-contract test, not a markdown worker/browser test.
// These are the same lightweight seams used by the current timeline row suite.
mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({
      type: "part" as const,
      key: ref.part.id,
      ref: { messageID: ref.messageID, partID: ref.part.id },
    })),
}))
mock.module("@/lib/text-layout", () => ({
  estimateTextHeight: () => undefined,
  prepareTextLayout: () => undefined,
  textLayoutMode: () => "off" as const,
}))

const { createTimelineProjection } = await import("./projection")
const { TimelineRow } = await import("./rows")

test("reactive projection renders the Goal Auditor prompt before its output", () => {
  createRoot((dispose) => {
    try {
      const source = [
        {
          id: "msg_auditor_system",
          type: "system",
          text: "[GOAL AUDIT CYCLE] Verify the worker result independently.",
          time: { created: 1 },
        },
        {
          id: "msg_auditor_skill",
          type: "skill",
          skill: "goal-verification",
          name: "Goal verification",
          text: "Apply the Goal verification rubric to the current worker result.",
          time: { created: 2 },
        },
        {
          id: "msg_auditor_prompt",
          type: "synthetic",
          text: "audit the latest Goal worker cycle",
          provenance: { owner: "host" as const, source: "special-agent.goal-auditor" },
          time: { created: 3 },
        },
        {
          id: "msg_auditor_assistant",
          type: "assistant",
          agent: "goal_auditor",
          model: { id: "auditor-model", providerID: "opencode" },
          content: [{ type: "text" as const, text: "Live auditor output" }],
          time: { created: 4 },
        },
      ] satisfies SessionMessageInfo[]
      const normalized = normalizeSessionMessages("ses_goal_auditor", source)
      const projection = createTimelineProjection({
        messages: () => normalized.messages,
        // There is deliberately no semantic human-user turn. The canonical
        // Current synthetic root is both the structural parent and the visible
        // automation boundary for this special-agent provider turn.
        userMessages: () => [],
        sessionMessages: () => source,
        parts: (messageID) => normalized.parts.get(messageID) ?? [],
        status: () => ({ type: "idle" }),
        showReasoningSummaries: () => true,
        showSystemInjections: () => false,
        inlineComments: () => false,
      })

      expect(projection.rows().map(TimelineRow.key)).toEqual([
        "context-message:msg_auditor_system",
        "context-message:msg_auditor_skill",
        "user-message:msg_auditor_prompt",
        "assistant-part:msg_auditor_prompt:msg_auditor_assistant:text:0",
      ])
    } finally {
      dispose()
    }
  })
})
