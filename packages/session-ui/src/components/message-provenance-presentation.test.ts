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

  test("gives scheduled work a specific automation identity", () => {
    expect(
      messageProvenancePresentation({
        role: "user",
        provenance: { owner: "host", source: SessionTurnProvenance.Source.ScheduledTaskRun, ref: "stk_1" },
      }),
    ).toMatchObject({ badgeDefault: "Scheduled task", previewDefault: "Scheduled task" })
  })

  test("covers every canonical synthetic provenance source with a timeline presentation", () => {
    for (const source of Object.values(SessionTurnProvenance.Source)) {
      const policy = SessionTurnProvenance.policy(source)
      if (policy?.kind !== "synthetic") continue

      expect(
        messageProvenancePresentation({
          role: "user",
          provenance: { owner: policy.owner, source },
        }),
      ).toBeDefined()
    }
  })

  test("keeps shell and compaction on their dedicated timeline presentations", () => {
    expect(
      messageProvenancePresentation({
        role: "user",
        provenance: { owner: "user", source: SessionTurnProvenance.Source.Shell },
      }),
    ).toBeUndefined()
    expect(
      messageProvenancePresentation({
        role: "user",
        provenance: { owner: "host", source: SessionTurnProvenance.Source.Compaction },
      }),
    ).toBeUndefined()
  })
})
