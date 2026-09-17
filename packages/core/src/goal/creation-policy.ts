export * as GoalCreationPolicy from "./creation-policy"

export interface TurnProvenance {
  readonly userMessageID: string
  readonly userText: string
  readonly previousAssistantText?: string
}

export type Authorization =
  | { readonly allowed: true; readonly reason: "explicit-user-request" | "confirmed-agent-proposal" }
  | { readonly allowed: false; readonly reason: string }

const GOAL = /\bgoals?(?:\s+mode)?\b/i
const CREATE = /\b(?:create|make|set\s*up|setup|start|activate|enable|enter|switch|turn|convert|put|add|build|use|run)\b/i
const DIRECT_GOAL_VERB = /\bgoal\s+(?:this|that|it|the\s+(?:task|request|work))\b/i
const DIRECT_DESIRE = /\b(?:i\s+want|i(?:['’]d|\s+would)\s+like)\s+(?:a\s+)?goal(?:\s+mode)?\b/i
const NEGATED = /\b(?:do\s+not|don['’]?t|dont|never)\b[^.!?\n]{0,100}\bgoals?(?:\s+mode)?\b/i
const INFORMATIONAL = /^\s*(?:how\s+(?:do|can|would)\s+(?:i|you)|what\s+is|what\s+does|explain|tell\s+me\s+(?:about|how))\b/i
const AFFIRMATIVE = /^(?:yes|yeah|yep|yup|sure|ok|okay|do\s+it|go\s+ahead|please\s+do|sounds\s+good|make\s+it\s+so|set\s+it\s+up|create\s+it)(?:\b|[.!?])/i
const PROPOSAL = /\b(?:should\s+i|shall\s+i|would\s+you\s+like|want\s+me\s+to|i\s+(?:can|could)\s+(?:create|make|set\s*up|start))\b/i

function normalized(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? ""
}

export function explicitlyRequestsGoal(value: string) {
  const text = normalized(value)
  if (!text || NEGATED.test(text) || INFORMATIONAL.test(text)) return false
  return (GOAL.test(text) && CREATE.test(text)) || DIRECT_GOAL_VERB.test(text) || DIRECT_DESIRE.test(text)
}

export function confirmsGoalProposal(userText: string, previousAssistantText: string | undefined) {
  const user = normalized(userText)
  const assistant = normalized(previousAssistantText)
  if (!AFFIRMATIVE.test(user) || !assistant) return false
  return GOAL.test(assistant) && CREATE.test(assistant) && (PROPOSAL.test(assistant) || assistant.includes("?"))
}

export function authorize(turn: TurnProvenance | undefined): Authorization {
  if (!turn) return { allowed: false, reason: "Goal creation requires a current human user turn" }
  if (explicitlyRequestsGoal(turn.userText)) return { allowed: true, reason: "explicit-user-request" }
  if (confirmsGoalProposal(turn.userText, turn.previousAssistantText)) {
    return { allowed: true, reason: "confirmed-agent-proposal" }
  }
  return {
    allowed: false,
    reason:
      "The current user turn did not explicitly request Goal creation or confirm an immediately preceding Goal-creation proposal. Ask the user before creating durable Goal state.",
  }
}

export function explicitlyRequestsUnattended(value: string) {
  const text = normalized(value)
  return /\bunattended\b/i.test(text) && GOAL.test(text) && !NEGATED.test(text)
}

export function explicitlyRequestsDraft(value: string) {
  const text = normalized(value)
  return (
    /\bdraft\b/i.test(text) ||
    /\b(?:do\s+not|don['’]?t|dont)\s+start\b/i.test(text) ||
    /\bwithout\s+starting\b/i.test(text)
  )
}
