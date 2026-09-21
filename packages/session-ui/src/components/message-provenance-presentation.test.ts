import { describe, expect, test } from "bun:test"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import { messageProvenancePresentation } from "./message-provenance-presentation"

describe("messageProvenancePresentation", () => {
  test("keeps genuine human prompts on the ordinary user-message path", () => {
    expect(
      messageProvenancePresentation({
        role: "user",
        provenance: { owner: "user", source: SessionTurnProvenance.Source.Prompt },
      }),
    ).toBeUndefined()
  })

  test("distinguishes peer mail from task assignment and continuation", () => {
    expect(
      messageProvenancePresentation({
        role: "user",
        provenance: { owner: "host", source: SessionTurnProvenance.Source.SwarmPeer, ref: "msg_1" },
      }),
    ).toMatchObject({ badgeDefault: "Swarm peer", previewDefault: "Peer message" })

    expect(
      messageProvenancePresentation({
        role: "user",
        provenance: { owner: "host", source: SessionTurnProvenance.Source.SwarmAssignment, ref: "run_1" },
      }),
    ).toMatchObject({ badgeDefault: "Swarm assignment", previewDefault: "Task assignment" })

    expect(
      messageProvenancePresentation({
        role: "user",
        provenance: {
          owner: "host",
          source: SessionTurnProvenance.Source.SwarmContinuation,
          sourceMessageID: "msg_root",
          ref: "run_1",
        },
      }),
    ).toMatchObject({ badgeDefault: "Swarm continuation", previewDefault: "Task continuation" })
  })

  test("keeps non-Swarm host turns explicit but generic", () => {
    expect(
      messageProvenancePresentation({
        role: "user",
        provenance: { owner: "host", source: SessionTurnProvenance.Source.ScheduledTaskRun, ref: "stk_1" },
      }),
    ).toMatchObject({ badgeDefault: "Automation", previewDefault: SessionTurnProvenance.Source.ScheduledTaskRun })
  })
})
