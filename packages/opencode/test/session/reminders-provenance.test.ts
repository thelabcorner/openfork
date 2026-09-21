import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { targetWorkerTurn } from "@/session/reminders"
import { MessageID, SessionID } from "@/session/schema"

const turn = (
  id: string,
  provenance: SessionV1.User["provenance"],
): SessionV1.WithParts =>
  ({
    info: {
      id: MessageID.make(id),
      sessionID: SessionID.make("ses_reminders_provenance"),
      role: "user",
      provenance,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test" as never, modelID: "model" as never },
    },
    parts: [],
  }) satisfies SessionV1.WithParts

describe("SessionReminders provenance", () => {
  test("historical semantic users cannot become the live reminder target", () => {
    const live = turn(
      "msg_live",
      SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
    )
    const historical = turn("msg_imported", {
      ...SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
      lifetime: "historical",
    })

    expect(targetWorkerTurn([live, historical])?.info.id).toBe(live.info.id)
  })

  test("host STATE remains transparent while a trusted host worker root may own reminders", () => {
    const host = turn(
      "msg_host",
      SessionTurnProvenance.host(SessionTurnProvenance.Source.HostPrompt),
    )
    const state = turn(
      "msg_state",
      SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalProgress, {
        ref: "goal-state:reminders",
      }),
    )

    expect(targetWorkerTurn([host, state])?.info.id).toBe(host.info.id)
  })
})
