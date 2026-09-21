import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { assembleV1TitleContext } from "@/session/prompt"

const sessionID = SessionID.make("ses_title_context")

function user(
  id: string,
  text: string,
  source: SessionTurnProvenance.CanonicalUserSource | SessionTurnProvenance.CanonicalHostSource =
    SessionTurnProvenance.Source.Prompt,
): SessionV1.WithParts {
  const messageID = MessageID.make(id)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test" as never, modelID: "test" as never },
      provenance:
        source === SessionTurnProvenance.Source.Prompt
          ? SessionTurnProvenance.user(source)
          : SessionTurnProvenance.host(source as SessionTurnProvenance.CanonicalHostSource, { ref: `ref:${id}` }),
    },
    parts: [{ id: PartID.make(`prt_${id}`), sessionID, messageID, type: "text", text, synthetic: source !== SessionTurnProvenance.Source.Prompt }],
  }
}

function assistant(id: string, parentID: MessageID, text: string): SessionV1.WithParts {
  const messageID = MessageID.make(id)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID,
      time: { created: 2, completed: 3 },
      agent: "build",
      mode: "build",
      modelID: "test" as never,
      providerID: "test" as never,
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [{ id: PartID.make(`prt_${id}`), sessionID, messageID, type: "text", text }],
  }
}

describe("V1 title context", () => {
  test("is bounded, keeps the opening worker intent, and excludes Goal STATE", () => {
    const opening = user("msg_opening", "OPENING WORKER INTENT")
    const state = user("msg_state", "OBSOLETE GOAL STATE", SessionTurnProvenance.Source.GoalSpecification)
    const tail = Array.from({ length: 12 }, (_, index) =>
      assistant(`msg_tail_${index}`, opening.info.id, `tail-${index} ${"x".repeat(1500)}`),
    )
    const context = assembleV1TitleContext([opening, state, ...tail])

    expect(context.length).toBeLessThanOrEqual(SessionTitle.MAX_TITLE_CONTEXT_CHARS)
    expect(context).toContain("OPENING WORKER INTENT")
    expect(context).not.toContain("OBSOLETE GOAL STATE")
    expect(context).toContain("tail-11")
  })

  test("a compaction boundary supersedes pre-compaction history", () => {
    const opening = user("msg_before", "PRE-COMPACTION INTENT")
    if (opening.info.role !== "user") throw new Error("expected opening title-context turn to be user-role")
    const compactionID = MessageID.make("msg_compaction")
    const compaction: SessionV1.WithParts = {
      info: {
        ...opening.info,
        id: compactionID,
        time: { created: 10 },
        provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.Compaction, { sourceMessageID: opening.info.id }),
      },
      parts: [{ id: PartID.make("prt_compaction"), sessionID, messageID: compactionID, type: "compaction", auto: true }],
    }
    const summary = assistant("msg_summary", compactionID, "AUTHORITATIVE COMPACTION SUMMARY")
    const recent = user("msg_recent", "RECENT HUMAN STEER")
    const context = assembleV1TitleContext([opening, compaction, summary, recent])

    expect(context).not.toContain("PRE-COMPACTION INTENT")
    expect(context).toContain("AUTHORITATIVE COMPACTION SUMMARY")
    expect(context).toContain("RECENT HUMAN STEER")
  })
})
