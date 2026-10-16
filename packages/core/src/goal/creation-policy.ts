export * as GoalCreationPolicy from "./creation-policy"
import { clauses, isExplanatory } from "./language"

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
const GOAL_QUALIFIER = /(?:(?:new|durable|persistent|active|automatic|autonomous|long[- ]running|ongoing|unattended|manual|draft|tracked)\s+){0,2}/
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
  /\b(?:how\s+about|why\s+don['’]?t\s+you|would\s+you\s+mind)\s+(?:(?:we|you)\s+)?(?:creating|making|setting\s+up|starting|create|make|set\s+up|start|using|use|turning|turn)\b[^.!?\n]{0,80}\bgoal(?:\s+mode)?\b/i,
  /\b(?:goalify|goal-ify)\s+(?:this|that|it|the\s+(?:task|work|project|request))\b/i,
  /\b(?:treat|track|keep|run|handle)\s+(?:this|that|it|the\s+(?:task|work|project|request))\s+as\s+(?:(?:a|an)\s+)?(?:durable|persistent|long[- ]running|ongoing)\s+(?:task|objective|goal)\b/i,
  /\b(?:keep|continue)\s+(?:working|iterating|going)\s+(?:on\s+(?:this|it)\s+)?(?:automatically|autonomously)\b[^.!?\n]{0,80}\buntil\b/i,
  /\b(?:automatically|autonomously)\s+(?:keep|continue)\s+(?:working|iterating|going)\b[^.!?\n]{0,80}\buntil\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:go\s+ahead\s+(?:and\s+)?)?(?:create|make|set(?:\s*up)?|turn|put|track|start|launch)\b[^.!?\n]{0,96}\bgoals?(?:\s+mode)?\b/i,
  /\b(?:please\s+)?set\s+(?:me|us)\s+up\s+(?:with\s+)?(?:(?:a|the|new|draft)\s+)?goal\b/i,
  /\b(?:i(?:['’]d|\s+would)\s+like|i\s+(?:really\s+)?(?:want|need))\b[^.!?\n]{0,48}\b(?:have|track|tracked|tracking|set\s+up)\b[^.!?\n]{0,72}\bgoals?\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?goal[- ]mode\b/i,
  /\b(?:track|treat|handle|run|put|turn)\b[^.!?\n]{0,96}\b(?:as|into|in)\s+(?:a\s+)?(?:(?:durable|tracked|persistent|new|standing)\s+)?goal\b/i,
  /\b(?:add|open)\s+(?:a\s+)?(?:new|fresh|another)\s+goal\b/i,
  /\b(?:create|make|start|launch|build)\s+(?:one\s+)?(?:(?:new|durable|persistent|tracked)\s+){0,2}goal\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?build\s+(?:a|the|new|durable|tracked)\s+goal\b/i,
  /\b(?:put|track|treat|handle|take)\b[^.!?\n]{0,72}\b(?:under|on\s+as|as)\s+(?:a\s+)?goal\b/i,
  /\b(?:this|that|it)\s+(?:needs?\s+to|should|has\s+to)\s+be\s+(?:tracked|handled|managed|run)\s+as\s+(?:a\s+)?goal\b/i,
  /\bbuild\s+(?:a|the|new)\s+(?:(?:durable|persistent|tracked|draft)\s+)?goal\b/i,
  /\b(?:make|turn|convert)\s+(?:(?:this|that|the|my|our)\s+)?(?:project|task|work|implementation|migration|refactor|feature|fix|job|request|plan|release|effort)\s+(?:a\s+)?(?:(?:new|durable|persistent|tracked|active|standing)\s+){0,2}goal\b/i,
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
  /^\s*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)?(?:explain|describe|define|show|teach|walk\s+me\s+through|tell\s+me\s+(?:about|how|why))\b/i,
  /^\s*(?:i|we)\s+(?:want|need|would\s+like|['’]d\s+like)\s+to\s+(?:understand|learn|know|discuss|hear)\b/i,
  /^\s*(?:let['’]?s|please)\s+(?:discuss|compare|consider|think\s+about|talk\s+about)\b/i,
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
  /\b(?:add|adding|append|appending|include|including|incorporate|incorporating)\b[^.!?\n]{0,96}\b(?:to|in|into)\s+(?:(?:the|this|my|our|current)\s+)?(?:acceptance\s+criteria|goal\s+(?:criteria|steps|constraints))\b/i,
  /\b(?:how\s+about|why\s+don['’]?t\s+you)\s+(?:adding|including|appending|revising|updating)\b[^.!?\n]{0,96}\bgoal\b/i,
  /\b(?:please\s+)?(?:make|have|let)\s+(?:(?:the|this|that|my|our|current|active)\s+){0,2}goal\b[^.!?\n]{0,96}\b(?:include|cover|require|ensure|track|test|verify|handle)\b/i,
  /\b(?:i(?:['’]d|\s+would)\s+like|i\s+(?:want|need))\b[^.!?\n]{0,64}\bgoal\b[^.!?\n]{0,64}\b(?:include|cover|require|ensure|track|test|verify|have)\b/i,
  /\b(?:goal\s+criteria|goal\s+objective)\b[^.!?\n]{0,64}\b(?:include|cover|require|ensure|track|test|verify)\b/i,
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
  /\b(?:should\s+i|shall\s+i|would\s+you\s+like(?:\s+me\s+to)?|do\s+you\s+want\s+me\s+to|want\s+me\s+to|i\s+(?:can|could))\b/i
const PROPOSED_ACTION =
  /\b(?:create|make|set(?:\s*up)?|start|enable|activate|use|put|track|run|launch|turn|convert|establish)\b[^.!?\n]{0,100}\bgoal(?:\s+mode)?\b/i
const PROPOSED_EXPLANATION = /\b(?:can|could|should|shall)\s+(?:explain|describe|discuss|teach|tell|show)\b[^.!?\n]{0,100}\bgoal\b/i
const DEFER_CONFIRMATION = /\b(?:not\s+yet|later|hold\s+off|wait|instead|don['’]?t|do\s+not|never)\b/i
const FUTURE_ONLY_CREATE = /\b(?:create|make|set\s+up|start)\b[^.!?;]{0,100}\bgoal\b[^.!?;]{0,80}\b(?:when\s+i\s+(?:ask|say)|if\s+i\s+(?:ask|say)|if\s+i\s+say\s+so)\b/i

const GOAL_MENTION = /(^|[\s([{"'])@goal\b/gi

function normalized(value: string | undefined) {
  return (value?.replace(GOAL_MENTION, "$1goal") ?? "").replace(/\s+/g, " ").trim()
}

function matchesAny(text: string, detectors: readonly RegExp[]) {
  return detectors.some((detector) => detector.test(text))
}

/** Interpret independently spoken directives, newest first within a human turn.
 * A later "actually, create it" supersedes an earlier "don't create it".
 * Examples and quoted instructions never acquire human-action provenance.
 */
function directives(value: string) {
  return clauses(value)
}

function isInformationalGoalDiscussion(text: string) {
  return (
    GOAL.test(text) &&
    !/^\s*(?:how\s+about|why\s+don['’]?t\s+you|would\s+you\s+mind)\b/i.test(text) &&
    (isExplanatory(text) || matchesAny(text, INFORMATIONAL_DETECTORS))
  )
}

function creationDirective(value: string): "create" | "decline" | undefined {
  let latest: "create" | "decline" | undefined
  for (const text of directives(value)) {
    if (/^(?:not\s+(?:right\s+)?now|never\s+mind|actually\s+no|no\s+thanks|forget\s+it|scratch\s+that|hold\s+off|later\s+instead)\b/i.test(text)) {
      if (latest === "create") latest = "decline"
      continue
    }
    if (
      isExplanatory(text) || isInformationalGoalDiscussion(text) ||
      /\b(?:is|was)\s+(?:(?:what\s+(?:this|the)\s+)?(?:code\s+sample|example|documentation)\s+(?:says?|means?)|only\s+an?\s+example)\b/i.test(text) ||
      FUTURE_ONLY_CREATE.test(text) ||
      /^(?:for\s+example|for\s+instance|e\.g\.|here\s+is\s+an\s+example|to\s+quote|(?:he|she|they)\s+(?:said|says|wrote)|the\s+(?:example|docs?|documentation)\s+(?:says?|reads?))\b/i.test(text)
    ) continue
    const request = matchesAny(text, REQUEST_DETECTORS)
    const decline = matchesAny(text, DECLINE_DETECTORS)
    // Refusing to start Goal Mode can be a draft request, not a refusal
    // to persist the Goal. Never override an explicit refusal to create.
    const draftOnly =
      explicitlyRequestsDraft(text) &&
      !/\b(?:do\s+not|don['’]?t|dont|never|no\s+need\s+to)\s+(?:create|make|set(?:\s*up)?)\b/i.test(text) &&
      /\b(?:create|make|set(?:\s*up)?|draft|save)\b[^.!?\n]{0,72}\bgoal\b/i.test(text)
    // "Create a Goal, but don't start Goal Mode" refers to the *same* turn:
    // retain the creation directive and persist it as a draft. By contrast
    // "Don't start a Goal" alone never grants creation authority.
    if (decline && !draftOnly && !(latest === "create" && explicitlyRequestsDraft(text))) latest = "decline"
    else if (request) latest = "create"
  }
  return latest
}

export function explicitlyRequestsGoal(value: string) {
  return creationDirective(value) === "create"
}

export function explicitlyDeclinesGoal(value: string) {
  return creationDirective(value) === "decline"
}

export function explicitlyRequestsGoalUpdate(value: string) {
  return updateDirective(value) === "update"
}

export function explicitlyDeclinesGoalUpdate(value: string) {
  return updateDirective(value) === "decline"
}

function updateDirective(value: string): "update" | "decline" | undefined {
  let latest: "update" | "decline" | undefined
  for (const text of directives(value)) {
    // "Add X to the acceptance criteria" refers unambiguously to the
    // focused Goal specification even without repeating the word Goal.
    const namesSpecification = /\b(?:acceptance\s+criteria|goal\s+(?:criteria|objective|steps|constraints))\b/i.test(text)
    if ((!GOAL.test(text) && !namesSpecification) || isExplanatory(text) || isInformationalGoalDiscussion(text)) continue
    if (/^\s*(?:should|can|could|would|do|did|will)\s+(?:i|we)\b/i.test(text)) continue
    if (matchesAny(text, UPDATE_DECLINE_DETECTORS)) latest = "decline"
    else if (matchesAny(text, UPDATE_REQUEST_DETECTORS)) latest = "update"
  }
  return latest
}

export function confirmsGoalProposal(userText: string, previousAssistantText: string | undefined) {
  const user = normalized(userText)
  if (!AFFIRMATIVE.test(user) || (DEFER_CONFIRMATION.test(user) && !explicitlyRequestsDraft(user))) return false
  if (/\b(?:do\s+not|don['’]?t|dont|never)\s+(?:create|make|set(?:\s*up)?)\b[^.!?\n]{0,64}\bgoal\b/i.test(user)) return false
  // "Yes, but ..." is not blanket approval of the preceding action. Require
  // an independent, explicit Goal directive after an adversative qualifier.
  if (/\b(?:but|however)\b/i.test(user) && !explicitlyRequestsGoal(userText) && !explicitlyRequestsDraft(userText)) return false
  // Mentioning Goal Mode, or merely asking a question about it, is not an
  // offer to create durable state. Evaluate real assistant utterances, not
  // quoted text, code samples, or an unrelated earlier explanatory sentence.
  return clauses(previousAssistantText).some(
    (assistant) => GOAL.test(assistant) && PROPOSAL.test(assistant) &&
      PROPOSED_ACTION.test(assistant) && !PROPOSED_EXPLANATION.test(assistant),
  )
}

export function authorize(turn: TurnProvenance | undefined): Authorization {
  if (!turn) return { allowed: false, reason: "Goal creation requires a current human user turn" }

  const candidates: readonly UserTurnProvenance[] = [turn, ...(turn.priorUserTurns ?? [])]
  for (const candidate of candidates) {
    const directive = creationDirective(candidate.userText)
    const confirms = candidate.previousAssistantText
      ? confirmsGoalProposal(candidate.userText, candidate.previousAssistantText)
      : false
    // The newest relevant human directive wins. This makes old consent durable
    // across ordinary follow-up turns while keeping revocation immediate.
    // "Yes, but don't start it" confirms creation *as a draft*. Do not treat
    // its activation refusal as revocation of the proposed Goal creation.
    if (confirms && explicitlyRequestsDraft(candidate.userText)) {
      return { allowed: true, reason: "confirmed-agent-proposal", source: candidate }
    }
    if (directive === "decline") {
      return {
        allowed: false,
        reason:
          "The most recent relevant human Goal directive declined Goal creation. A newer user request is required before creating durable Goal state.",
      }
    }
    if (directive === "create") {
      return { allowed: true, reason: "explicit-user-request", source: candidate }
    }
    if (confirms) {
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

export function explicitlyRequestsDraft(value: string) {
  const text = normalized(value)
  return (
    /\b(?:draft(?:\s+only)?|leave\s+(?:it|this|that)\s+as\s+(?:a\s+)?draft)\b/i.test(text) ||
    /\b(?:do\s+not|don['’]?t|dont|hold\s+off|wait)\b[^.!?\n]{0,32}\b(?:start(?:ing)?|activat(?:e|ing)|run(?:ning)?|launch(?:ing)?)\b/i.test(text) ||
    /\bwithout\s+(?:starting|activating|running|launching)\b/i.test(text) ||
    /\b(?:create|make|set(?:\s*up)?)\b[^.!?\n]{0,48}\bgoal\b[^.!?\n]{0,48}\b(?:but\s+)?not\s+yet\b/i.test(text)
  )
}
