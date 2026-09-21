import { MessageID, type SessionID } from "@/session/schema"
import { SpecialAgentSession } from "@opencode-ai/core/special-agent-session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"

const AgentNameByKind = {
  goal_auditor: "goal-auditor",
  goal_revisor: "goal-revisor",
  prompt_revisor: "prompt-revisor",
  session_title: "title",
  spad_auditor: "spad-auditor",
} as const satisfies Record<SpecialAgentSession.Kind, string>

/**
 * V1 Session LLM requires a user-role anchor even when the actual request is a
 * host-owned special-agent operation supplied separately in `messages`.
 * Construct that compatibility object here so no special agent can accidentally
 * inherit the parent worker's human ownership, worker-root eligibility, Goal
 * authority, agent identity, or model identity.
 */
export function makeV1SpecialAgentAnchor(input: {
  readonly sessionID: SessionID
  readonly agent: SpecialAgentSession.Kind
  readonly model: SessionV1.User["model"]
}): SessionV1.User {
  return {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "user",
    provenance: SessionTurnProvenance.host(SpecialAgentSession.SourceByKind[input.agent]),
    time: { created: Date.now() },
    agent: AgentNameByKind[input.agent],
    model: input.model,
  }
}
