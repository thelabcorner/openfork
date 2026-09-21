import { describe, expect, test } from "bun:test"
import { GoalCreationPolicy } from "@opencode-ai/core/goal/creation-policy"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { currentWithHistory } from "@/tool/user-action-turn"
import { MessageID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_user_action_turn")

function user(id: string, text: string, provenance: SessionV1.User["provenance"]): SessionV1.WithParts {
  const messageID = MessageID.make(id)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      provenance,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test" as never, modelID: "model" as never },
    },
    parts: [
      {
        id: SessionV1.PartID.ascending(),
        sessionID,
        messageID,
        type: "text",
        text,
        synthetic: false,
      },
    ],
  }
}

const human = (id: string, text: string) =>
  user(id, text, SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt))

describe("user action turn history", () => {
  test("carries bounded prior human Goal intent into a later neutral human turn", () => {
    const turn = currentWithHistory([
      human("msg_goal_request", "Set a Goal for this refactor and start it."),
      human("msg_followup", "Continue with the next file."),
    ])

    expect(turn?.userMessageID).toBe("msg_followup")
    expect(turn?.priorUserTurns?.map((item) => item.userMessageID)).toEqual(["msg_goal_request"])
    expect(GoalCreationPolicy.authorize(turn)).toMatchObject({
      allowed: true,
      source: { userMessageID: "msg_goal_request" },
    })
  })

  test("never lets a host worker root borrow older human Goal consent", () => {
    const turn = currentWithHistory([
      human("msg_goal_request", "Create a Goal for this refactor."),
      user(
        "msg_host",
        "host continuation",
        SessionTurnProvenance.host(SessionTurnProvenance.Source.HostPrompt),
      ),
    ])
    expect(turn).toBeUndefined()
  })

  test("bounds retained human history instead of copying an unbounded transcript", () => {
    const messages = Array.from({ length: 80 }, (_, index) =>
      human(`msg_user_${String(index).padStart(3, "0")}`, `user turn ${index}`),
    )
    const turn = currentWithHistory(messages)
    expect(turn?.userMessageID).toBe("msg_user_079")
    expect(turn?.priorUserTurns).toHaveLength(63)
    expect(turn?.priorUserTurns?.[0]?.userMessageID).toBe("msg_user_078")
  })
})
