export * as GoalCreationPolicy from "./creation-policy"

export interface UserTurnProvenance {
  readonly userMessageID: string
  readonly userText: string
  readonly previousAssistantText?: string
}

export interface TurnProvenance extends UserTurnProvenance {
  /** Newest-first bounded human history supplied by the trusted V1 adapter. */
  readonly priorUserTurns?: readonly UserTurnProvenance[]
}

export type Authorization =
  | {
      readonly allowed: true
      readonly reason: "explicit-user-request" | "confirmed-agent-proposal" | "explicit-user-update-request"
      readonly source: UserTurnProvenance
    }
  | { readonly allowed: false; readonly reason: string }

const GOAL = /\bgoals?(?:\s+mode)?\b/i
const GOAL_OBJECT = /(?:this|that|it|the\s+(?:task|request|work|job|project|refactor|fix|implementation|migration|plan))/
const GOAL_CREATE_VERB =
  /(?:create|make|set(?:\s*up)?|setup|start|launch|initiate|open|establish|activate|enable|enter|use|run|begin|kick\s*off|spin\s*up)/
const GOAL_TRANSFORM_VERB = /(?:make|turn|convert|put|move|promote)/
const GOAL_AS_VERB = /(?:track|treat|handle|manage|run|work|keep)/
const GOAL_QUALIFIER = /(?:(?:new|durable|persistent|active|automatic|unattended|manual|draft|tracked)\s+){0,2}/
const GOAL_UPDATE_VERB = /(?:update|revise|amend|modify|change|expand|extend|adjust|edit|refine|strengthen|broaden)/

// Keep every detector linear and locally bounded. Goal history may evaluate
// dozens of prior user turns, so avoid backtracking-heavy catch-all patterns.
const REQUEST_DETECTORS: readonly RegExp[] = [
  new RegExp(
    `\\b${GOAL_CREATE_VERB.source}\\s+(?:(?:me|us)\\s+)?(?:(?:a|the|this|that|my|our)\\s+)?${GOAL_QUALIFIER.source}goals?(?:\\s+mode)?\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:please\\s+)?${GOAL_CREATE_VERB.source}\\s+${GOAL_OBJECT.source}\\s+(?:as|in|with)\\s+(?:a\\s+)?goal(?:\\s+mode)?\\b`,
    "i",
  ),
  new RegExp(
    `\\b${GOAL_TRANSFORM_VERB.source}\\s+${GOAL_OBJECT.source}\\s+(?:into|to|in|as)\\s+(?:a\\s+)?${GOAL_QUALIFIER.source}goal(?:\\s+mode)?\\b`,
    "i",
  ),
  new RegExp(
    `\\b${GOAL_AS_VERB.source}\\s+${GOAL_OBJECT.source}\\s+as\\s+(?:a\\s+)?goal\\b`,
    "i",
  ),
  new RegExp(`\\bgoal\\s+${GOAL_OBJECT.source}\\b`, "i"),
  /\b(?:turn|switch)\s+(?:goal\s+mode\s+on|(?:to|into)\s+goal\s+mode)\b/i,
  /\bgoal\s+mode\s+(?:on|now|please)\b/i,
  /\b(?:use|enable|activate|start|enter|run)\s+(?:the\s+)?goal\s+system\b/i,
  /\b(?:let['’]?s|we\s+should|we\s+need\s+to)\s+(?:create|make|set(?:\s*up)?|start|use|enable|activate|run|enter)\b[^.!?\n]{0,64}\bgoal(?:\s+mode)?\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:create|make|set(?:\s*up)?|start|use|enable|activate|run|enter|launch)\b[^.!?\n]{0,64}\bgoal(?:\s+mode)?\b/i,
  /\b(?:i\s+want|i\s+need|i(?:['’]d|\s+would)\s+(?:like|prefer))\s+(?:you\s+to\s+)?(?:create|make|set(?:\s*up)?|start|use|enable|activate|run|enter|launch)?\s*(?:a|the|this)?\s*goal(?:\s+mode)?\b/i,
  /\b(?:i\s+want|i\s+need|i(?:['’]d|\s+would)\s+like)\s+(?:this|that|it)\s+(?:to\s+be|as)\s+(?:a\s+)?goal\b/i,
  /\b(?:this|that|it)\s+(?:should|needs?\s+to|has\s+to)\s+be\s+(?:a\s+)?goal\b/i,
  /\b(?:make|set)\s+(?:this|that|it)\s+(?:as\s+)?(?:my|our|the|a)\s+goal\b/i,
  /\bgoal(?:\s+mode)?\s+(?:this|that|it)\b/i,
  /\b(?:goal\s+mode|a\s+goal)\s+please\b/i,
  /\b(?:we|i)\s+(?:need|want)\s+(?:the\s+)?goal\s+mode\b/i,
]

const DECLINE_DETECTORS: readonly RegExp[] = [
  /\b(?:do\s+not|don['’]?t|dont|never|please\s+don['’]?t)\s+(?:create|make|set(?:\s*up)?|start|use|enable|activate|enter|run|launch|goal)\b[^.!?\n]{0,64}\bgoal(?:\s+mode)?\b/i,
  /\b(?:no\s+need\s+to|do\s+not\s+need\s+to|don['’]?t\s+need\s+to|dont\s+need\s+to|needn['’]?t|don['’]?t\s+have\s+to)\b[^.!?\n]{0,64}\b(?:create|make|set(?:\s*up)?|start|use|enable|activate|run|launch)\b[^.!?\n]{0,64}\bgoal(?:\s+mode)?\b/i,
  /\b(?:i\s+do\s+not|i\s+don['’]?t|i\s+dont)\s+(?:want|need)\s+(?:a|the|this|that)?\s*goal(?:\s+mode)?\b/i,
  /\b(?:i\s+do\s+not|i\s+don['’]?t|i\s+dont|i(?:['’]d|\s+would)\s+rather\s+not)\s+(?:want\s+to\s+)?(?:create|make|set(?:\s*up)?|start|use|enable|activate|run|launch)\b[^.!?\n]{0,64}\bgoal(?:\s+mode)?\b/i,
  /\bi\s+(?:do\s+not|don['’]?t|dont)\s+think\b[^.!?\n]{0,96}\b(?:need|want|should\s+use|should\s+be)\b[^.!?\n]{0,64}\bgoal(?:\s+mode)?\b/i,
  /\b(?:no|without)\s+(?:a|the)?\s*goal(?:\s+mode)?\b/i,
  /\b(?:skip|avoid|disable|deactivate|drop|remove|stop\s+using|quit|leave\s+off|turn\s+off)\s+(?:the\s+)?goal(?:\s+mode)?\b/i,
  /\bgoal\s+mode\s+(?:off|disabled)\b/i,
  /\b(?:do\s+not|don['’]?t|dont)\s+(?:goal\s+)?(?:this|that|it)\b/i,
  /\b(?:this|that|it)\s+(?:should\s+not|shouldn['’]?t|must\s+not)\s+be\s+(?:a\s+)?goal\b/i,
  /\b(?:not|don['’]?t\s+want)\s+(?:this|that|it)\s+(?:as|to\s+be)\s+(?:a\s+)?goal\b/i,
  /\bnot\s+(?:in|with|as)\s+(?:a\s+)?goal(?:\s+mode)?\b/i,
]

const INFORMATIONAL_DETECTORS: readonly RegExp[] = [
  /^\s*(?:how|what|why|when|where|which|who)\b/i,
  /^\s*(?:should|can|could|would|do|did|will)\s+(?:i|we)\b/i,
  /^\s*shouldn['’]?t\s+we\b/i,
  /^\s*(?:is|are|does)\b[^.!?\n]{0,96}\bgoal(?:\s+mode)?\b/i,
  /^\s*(?:explain|describe|define|compare|tell\s+me\s+(?:about|how|what|why|when))\b/i,
  /^\s*(?:would|could|can)\s+(?:a|the)?\s*goal(?:\s+mode)?\b/i,
  /^\s*(?:if|when|suppose|assuming|imagine)\b[^.!?\n]{0,128}\bgoal(?:\s+mode)?\b/i,
  /^\s*(?:for\s+example|for\s+instance|e\.g\.)\b[^.!?\n]{0,128}\bgoal(?:\s+mode)?\b/i,
  /^\s*(?:i|we)\s+(?:can|could|might|may)\b[^.!?\n]{0,96}\b(?:create|make|start|use|enable|run)\b[^.!?\n]{0,64}\bgoal(?:\s+mode)?\b/i,
]

const UPDATE_REQUEST_DETECTORS: readonly RegExp[] = [
  new RegExp(
    `\\b(?:please\\s+)?${GOAL_UPDATE_VERB.source}\\s+(?:(?:the|this|that|my|our)\\s+)?(?:(?:current|active)\\s+)?goal(?:\\s+(?:objective|spec(?:ification)?|criteria|criterion|acceptance\\s+criteria|steps?|constraints?))?\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${GOAL_UPDATE_VERB.source}\\b[^.!?\\n]{0,80}\\bgoal\\b`,
    "i",
  ),
  new RegExp(
    `\\b${GOAL_UPDATE_VERB.source}\\s+(?:(?:the|this|that|my|our|current|active)\\s+)?(?:objective|spec(?:ification)?|criteria|criterion|acceptance\\s+criteria|steps?|constraints?)\\b[^.!?\\n]{0,48}\\b(?:of|for|in|on)\\s+(?:(?:the|this|that|my|our|current|active)\\s+)?goal\\b`,
    "i",
  ),
  /\b(?:add|append|include|incorporate|fold)\b[^.!?\n]{0,96}\b(?:to|into|in)\s+(?:the\s+|this\s+|my\s+|our\s+|current\s+|active\s+)?goal\b/i,
  /\b(?:goal|goal['’]s)\b[^.!?\n]{0,48}\b(?:should|must|needs?\s+to|has\s+to)\b[^.!?\n]{0,64}\b(?:include|cover|require|ensure|track|test|verify)\b/i,
  /\bmake\s+sure\b[^.!?\n]{0,80}\b(?:the\s+|this\s+|my\s+|our\s+|current\s+|active\s+)?goal\b[^.!?\n]{0,64}\b(?:includes?|covers?|requires?|ensures?|tracks?|tests?|verifies?)\b/i,
]

const UPDATE_DECLINE_DETECTORS: readonly RegExp[] = [
  new RegExp(
    `\\b(?:do\\s+not|don['’]?t|dont|never|stop|avoid)\\b[^.!?\\n]{0,48}\\b${GOAL_UPDATE_VERB.source}\\b[^.!?\\n]{0,48}\\bgoal\\b`,
    "i",
  ),
  /\b(?:leave|keep)\s+(?:the\s+|this\s+|my\s+|our\s+|current\s+|active\s+)?goal\s+(?:alone|unchanged|as[- ]is)\b/i,
]

const AFFIRMATIVE =
  /^(?:yes(?:\s+please)?|yeah|yep|yup|sure|absolutely|definitely|affirmative|correct|exactly|ok|okay|do\s+it|go\s+ahead|go\s+for\s+it|proceed(?:\s+with\s+it)?|please\s+do|sounds\s+good|sounds\s+right|that\s+works|let['’]?s\s+do\s+it|make\s+it\s+so|set\s+it\s+up|create\s+it)(?:\b|[.!?])/i
const PROPOSAL =
  /\b(?:should\s+i|shall\s+i|would\s+you\s+like|do\s+you\s+want|want\s+me\s+to|i\s+(?:can|could)\s+(?:create|make|set(?:\s*up)?|start|enable|activate|use|put|track|run|launch))\b/i

function normalized(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? ""
}

function matchesAny(text: string, detectors: readonly RegExp[]) {
  return detectors.some((detector) => detector.test(text))
}

function isInformationalGoalDiscussion(text: string) {
  return GOAL.test(text) && matchesAny(text, INFORMATIONAL_DETECTORS)
}

export function explicitlyRequestsGoal(value: string) {
  const text = normalized(value)
  if (!text || isInformationalGoalDiscussion(text) || explicitlyDeclinesGoal(text)) return false
  return matchesAny(text, REQUEST_DETECTORS)
}

export function explicitlyDeclinesGoal(value: string) {
  const text = normalized(value)
  return Boolean(text && !isInformationalGoalDiscussion(text) && matchesAny(text, DECLINE_DETECTORS))
}

export function explicitlyRequestsGoalUpdate(value: string) {
  const text = normalized(value)
  if (!text || explicitlyDeclinesGoalUpdate(text)) return false
  if (
    /^\s*(?:how|what|why|when|where|which|who)\b/i.test(text) ||
    /^\s*(?:should|can|could|would|do|did|will)\s+(?:i|we)\b/i.test(text) ||
    /^\s*(?:is|are|does)\b/i.test(text) ||
    /^\s*(?:if|when|suppose|assuming|imagine)\b/i.test(text)
  ) {
    return false
  }
  return matchesAny(text, UPDATE_REQUEST_DETECTORS)
}

export function explicitlyDeclinesGoalUpdate(value: string) {
  const text = normalized(value)
  return Boolean(text && matchesAny(text, UPDATE_DECLINE_DETECTORS))
}

export function confirmsGoalProposal(userText: string, previousAssistantText: string | undefined) {
  const user = normalized(userText)
  const assistant = normalized(previousAssistantText)
  if (!AFFIRMATIVE.test(user) || !assistant) return false
  return GOAL.test(assistant) && (matchesAny(assistant, REQUEST_DETECTORS) || PROPOSAL.test(assistant) || assistant.includes("?"))
}

export function authorize(turn: TurnProvenance | undefined): Authorization {
  if (!turn) return { allowed: false, reason: "Goal creation requires a current human user turn" }

  const candidates: readonly UserTurnProvenance[] = [turn, ...(turn.priorUserTurns ?? [])]
  for (const candidate of candidates) {
    // The newest relevant human directive wins. This makes old consent durable
    // across ordinary follow-up turns while keeping revocation immediate.
    if (explicitlyDeclinesGoal(candidate.userText)) {
      return {
        allowed: false,
        reason:
          "The most recent relevant human Goal directive declined Goal creation. A newer user request is required before creating durable Goal state.",
      }
    }
    if (explicitlyRequestsGoal(candidate.userText)) {
      return { allowed: true, reason: "explicit-user-request", source: candidate }
    }
    if (confirmsGoalProposal(candidate.userText, candidate.previousAssistantText)) {
      return { allowed: true, reason: "confirmed-agent-proposal", source: candidate }
    }
  }

  return {
    allowed: false,
    reason:
      "No current or recent unrevoked human user turn explicitly requested Goal creation or confirmed a Goal-creation proposal. Ask the user before creating durable Goal state.",
  }
}

/**
 * Specification mutation is intentionally current-turn scoped. Unlike Goal
 * creation, an old "update the goal" instruction is not durable permission to
 * keep rewriting the specification after the user has moved on to other work.
 */
export function authorizeUpdate(turn: TurnProvenance | undefined): Authorization {
  if (!turn) return { allowed: false, reason: "Goal updates require a current human user turn" }
  if (explicitlyDeclinesGoalUpdate(turn.userText)) {
    return { allowed: false, reason: "The current human user turn explicitly declined changing the Goal" }
  }
  if (explicitlyRequestsGoalUpdate(turn.userText)) {
    return { allowed: true, reason: "explicit-user-update-request", source: turn }
  }
  return {
    allowed: false,
    reason: "The current human user turn did not explicitly ask to update, revise, or extend the focused Goal",
  }
}

export function explicitlyRequestsUnattended(value: string) {
  const text = normalized(value)
  if (!text || explicitlyDeclinesUnattended(text)) return false
  return (
    /\bunattended\b/i.test(text) ||
    /\b(?:autonomous|autonomously|hands[- ]?off)\b/i.test(text) ||
    /\b(?:auto[- ]?continue|continue\s+automatically)\b/i.test(text) ||
    /\b(?:keep\s+going|continue|run|work)\b[^.!?\n]{0,64}\b(?:until|through\s+to)\b[^.!?\n]{0,40}\b(?:done|finished|complete|completion)\b/i.test(text) ||
    /\bwithout\s+(?:asking|waiting\s+for|checking\s+with|needing)\s+(?:me|my\s+(?:approval|confirmation|input))\b/i.test(text) ||
    /\b(?:don['’]?t|do\s+not)\s+(?:stop|pause|wait)\s+(?:to\s+)?(?:ask|check\s+in|confirm)\b/i.test(text)
  )
}

function explicitlyDeclinesUnattended(value: string) {
  const text = normalized(value)
  return /\b(?:do\s+not|don['’]?t|dont|never|no)\b[^.!?\n]{0,48}\b(?:unattended|autonomous|auto[- ]?continue)\b/i.test(text) ||
    /\b(?:ask|check\s+with|wait\s+for)\s+me\b[^.!?\n]{0,48}\b(?:before|between|each|every)\b/i.test(text)
}

export function explicitlyRequestsDraft(value: string) {
  const text = normalized(value)
  return (
    /\b(?:draft(?:\s+only)?|leave\s+(?:it|this|that)\s+as\s+(?:a\s+)?draft)\b/i.test(text) ||
    /\b(?:do\s+not|don['’]?t|dont|hold\s+off|wait)\b[^.!?\n]{0,32}\b(?:start(?:ing)?|activat(?:e|ing)|run(?:ning)?|launch(?:ing)?)\b/i.test(text) ||
    /\bwithout\s+(?:starting|activating|running|launching)\b/i.test(text) ||
    /\b(?:create|make|set(?:\s*up)?)\b[^.!?\n]{0,48}\bgoal\b[^.!?\n]{0,48}\b(?:but\s+)?not\s+yet\b/i.test(text)
  )
}
