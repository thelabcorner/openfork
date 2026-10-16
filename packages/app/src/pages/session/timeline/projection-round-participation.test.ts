import { expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { SessionMessageInfo } from "@/utils/session-message-info"
import { normalizeSessionMessages } from "@/utils/session-message"

// Same lightweight projection seams as projection-special-agent.test.ts: this
// suite is about WHICH recorded turn a worker/subagent card is associated with,
// not about markdown rendering or part grouping.
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

/**
 * Negative-invariant suite for "recorded round participation".
 *
 * OpenFork has no coordinator-style "round" object. A turn is the recorded unit,
 * and a worker/subagent's historical participation is provable only by the
 * durable `parentID` lineage that `normalizeSessionMessages` stamps from the
 * recorded message order. These tests pin the two properties the projection
 * must never lose:
 *
 *  1. a card is associated with a historical turn only when a recorded parent
 *     proves it, and
 *  2. current live state never retroactively populates a prior turn.
 *
 * If someone later reintroduces a live roster/member lookup to decorate history,
 * test 3 fails because the extra input cannot reach a historical turn.
 */
function project(source: SessionMessageInfo[], status: { type: string }) {
  const normalized = normalizeSessionMessages("ses_round_participation", source)
  return createTimelineProjection({
    messages: () => normalized.messages,
    // No separately-hydrated projected user messages: every turn root here comes
    // from the durable recorded stream under test.
    userMessages: () => [],
    sessionMessages: () => normalized.messages.map((message) => ({
      id: message.id,
      type: message.role === "user" ? "user" : "assistant",
    })) as SessionMessageInfo[],
    parts: (messageID) => normalized.parts.get(messageID) ?? [],
    status: () => status as never,
    showReasoningSummaries: () => false,
    showSystemInjections: () => false,
    inlineComments: () => false,
  })
}

const rowsOf = (projection: ReturnType<typeof createTimelineProjection>) => projection.rows().map(TimelineRow.key)

test("a worker card is associated with the historical turn its recorded parent names", () => {
  createRoot((dispose) => {
    try {
      const projection = project(
        [
          { id: "msg_user_1", type: "user", text: "first round", time: { created: 1 } },
          {
            id: "msg_assistant_1",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: [{ type: "text", text: "worker output for round one" }],
            time: { created: 2, completed: 3 },
          },
          { id: "msg_user_2", type: "user", text: "second round", time: { created: 4 } },
          {
            id: "msg_assistant_2",
            type: "assistant",
            agent: "review",
            model: { id: "model", providerID: "provider" },
            content: [{ type: "text", text: "worker output for round two" }],
            time: { created: 5, completed: 6 },
          },
        ],
        { type: "idle" },
      )

      // Recorded parentID lineage decides membership: neither card leaks across
      // the turn boundary the durable stream actually records. The turn gap is
      // the recorded inter-turn separator, so adjacency/pending-input ordering
      // stays exactly where the durable stream put it.
      expect(rowsOf(projection)).toEqual([
        "user-message:msg_user_1",
        "assistant-part:msg_user_1:msg_assistant_1:text:0",
        "turn-gap:msg_user_2",
        "user-message:msg_user_2",
        "assistant-part:msg_user_2:msg_assistant_2:text:0",
      ])
    } finally {
      dispose()
    }
  })
})

test("an assistant record with no recorded turn root is not associated with any round", () => {
  createRoot((dispose) => {
    try {
      // The worker record precedes every recorded turn root. There is no
      // recorded participation evidence for any round, so it must not be
      // painted into history by adjacency or by any live lookup.
      const projection = project(
        [
          {
            id: "msg_assistant_orphan",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: [{ type: "text", text: "unattributed worker output" }],
            time: { created: 1, completed: 2 },
          },
          { id: "msg_user_1", type: "user", text: "first round", time: { created: 3 } },
          {
            id: "msg_assistant_1",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: [{ type: "text", text: "worker output for round one" }],
            time: { created: 4, completed: 5 },
          },
        ],
        { type: "idle" },
      )

      const keys = rowsOf(projection)
      expect(keys.some((key) => key.includes("msg_assistant_orphan"))).toBe(false)
      expect(keys).toEqual(["user-message:msg_user_1", "assistant-part:msg_user_1:msg_assistant_1:text:0"])
    } finally {
      dispose()
    }
  })
})

test("live session state never retroactively populates a prior turn", () => {
  createRoot((dispose) => {
    try {
      const source: SessionMessageInfo[] = [
        { id: "msg_user_1", type: "user", text: "first round", time: { created: 1 } },
        {
          id: "msg_assistant_1",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [{ type: "text", text: "worker output for round one" }],
          time: { created: 2, completed: 3 },
        },
        { id: "msg_user_2", type: "user", text: "second round", time: { created: 4 } },
      ]

      const idle = project(source, { type: "idle" })
      const idleKeys = rowsOf(idle)

      // busy and retry are current-membership facts. They may only appear on the
      // active (latest) turn; a prior turn's rows must stay byte-identical.
      for (const live of [{ type: "busy" }, { type: "retry" }]) {
        const busy = project(source, live)
        const busyKeys = rowsOf(busy)

        const priorIdle = idleKeys.filter((key) => key.endsWith("msg_user_1:text:0") || key === "user-message:msg_user_1")
        const priorBusy = busyKeys.filter(
          (key) => key.endsWith("msg_user_1:text:0") || key === "user-message:msg_user_1",
        )
        expect(priorBusy).toEqual(priorIdle)

        // The live-only decoration lands on the newest recorded turn, never on
        // history.
        expect(busyKeys.slice(priorBusy.length)).not.toContain("retry:msg_user_1")
        expect(busyKeys.slice(priorBusy.length)).not.toContain("thinking:msg_user_1")
      }
    } finally {
      dispose()
    }
  })
})
