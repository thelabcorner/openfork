import { describe, expect, test } from "bun:test"
import { makeV1SpecialAgentAnchor } from "@/special-agent/v1-anchor"
import { SessionID } from "@/session/schema"
import { SpecialAgentSession } from "@opencode-ai/core/special-agent-session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

describe("special-agent V1 compatibility anchor", () => {
  test("stamps every registered special agent as host synthetic and never worker/Goal authority", () => {
    for (const agent of ["prompt_revisor", "goal_revisor", "session_title", "goal_auditor", "spad_auditor"] as const) {
      const info = makeV1SpecialAgentAnchor({
        sessionID: SessionID.make("ses_special_agent_anchor"),
        agent,
        model: { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") },
      })
      const message: SessionV1.WithParts = {
        info,
        parts: [
          {
            id: SessionV1.PartID.ascending(),
            sessionID: info.sessionID,
            messageID: info.id,
            type: "text",
            text: "provider-only special-agent request",
            synthetic: true,
          },
        ],
      }

      expect(info.provenance).toEqual({ owner: "host", source: SpecialAgentSession.SourceByKind[agent] })
      expect(SessionTurnProvenance.semanticKind(message)).toBe("synthetic")
      expect(SessionTurnProvenance.isWorkerPromptTurn(message)).toBe(false)
      expect(SessionTurnProvenance.isGoalAuthorizationTurn(message)).toBe(false)
    }
  })
})
