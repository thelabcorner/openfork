export * as ScheduledTaskCreationPolicy from "./creation-policy"

export interface TurnProvenance {
  readonly userMessageID: string
  readonly userText: string
  readonly previousAssistantText?: string
}

export type Authorization =
  | { readonly allowed: true; readonly reason: "explicit-user-request" | "confirmed-agent-proposal" }
  | { readonly allowed: false; readonly reason: string }

export type ManagementAction = "update" | "remove" | "set_enabled" | "run_now" | "acknowledge"

const SCHEDULE_NOUN =
  /\b(?:scheduled?\s+tasks?|recurring\s+(?:tasks?|jobs?)|automations?|reminders?)\b/i
const PERIODIC_NOUN = /\b(?:daily|nightly|hourly|weekly|monthly)\b[^.!?\n]{0,50}\b(?:tasks?|jobs?|automations?)\b/i
const SCHEDULE_VERB = /\b(?:schedule|reschedule)\b/i
const CREATE = /\b(?:create|make|set\s*up|setup|add|start|enable|run)\b/i
const REMIND = /\bremind\s+me\b/i
const RECURRING = /\b(?:make|set)\b[^.!?\n]{0,80}\brecurring\b/i
const CADENCE =
  /\b(?:every|each)\s+(?:minute|hour|day|night|morning|afternoon|evening|weekday|weekend|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i
const PERIODIC_ACTION =
  /\b(?:run|check|review|summari[sz]e|send|notify|report|execute|do|scan|monitor|remind|update|build|test)\b/i
const NEGATED =
  /\b(?:do\s+not|don['’]?t|dont|never)\b[^.!?\n]{0,100}\b(?:schedule|scheduled|recurring|automation|remind(?:er)?)\b/i
const INFORMATIONAL =
  /^\s*(?:how\s+(?:do|can|would)\s+(?:i|you)|what\s+is|what\s+does|explain|tell\s+me\s+(?:about|how))\b/i
const AFFIRMATIVE =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|do\s+it|go\s+ahead|please\s+do|sounds\s+good|make\s+it\s+so|set\s+it\s+up|schedule\s+it)(?:\b|[.!?])/i
const PROPOSAL =
  /\b(?:should\s+i|shall\s+i|would\s+you\s+like|want\s+me\s+to|i\s+(?:can|could)\s+(?:schedule|create|make|set\s*up|add))\b/i
const MANAGE_NOUN = /\b(?:scheduled?\s+tasks?|schedules?|automations?|reminders?)\b/i
const MANAGEMENT_VERB: Readonly<Record<ManagementAction, RegExp>> = {
  update: /\b(?:update|edit|change|modify|rename|reschedule)\b/i,
  remove: /\b(?:delete|remove|cancel|stop)\b/i,
  set_enabled: /\b(?:enable|disable|pause|resume|turn\s+(?:on|off))\b/i,
  run_now: /\b(?:run|start|trigger|execute)\b[^.!?\n]{0,40}\b(?:now|immediately|once)\b/i,
  acknowledge: /\b(?:acknowledge|mark)\b[^.!?\n]{0,50}\b(?:read|seen|notification|run|result)\b/i,
}
const MANAGEMENT_PROPOSAL =
  /\b(?:should\s+i|shall\s+i|would\s+you\s+like|want\s+me\s+to|i\s+(?:can|could))\b/i

function normalized(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? ""
}

export function explicitlyRequestsSchedule(value: string) {
  const text = normalized(value)
  if (!text || NEGATED.test(text) || INFORMATIONAL.test(text)) return false
  return (
    SCHEDULE_VERB.test(text) ||
    REMIND.test(text) ||
    RECURRING.test(text) ||
    (SCHEDULE_NOUN.test(text) && CREATE.test(text)) ||
    (PERIODIC_NOUN.test(text) && CREATE.test(text)) ||
    (CADENCE.test(text) && PERIODIC_ACTION.test(text))
  )
}

export function confirmsScheduleProposal(userText: string, previousAssistantText: string | undefined) {
  const user = normalized(userText)
  const assistant = normalized(previousAssistantText)
  if (!AFFIRMATIVE.test(user) || !assistant) return false
  const mentionsSchedule =
    SCHEDULE_VERB.test(assistant) ||
    SCHEDULE_NOUN.test(assistant) ||
    REMIND.test(assistant) ||
    RECURRING.test(assistant)
  return mentionsSchedule && (PROPOSAL.test(assistant) || assistant.includes("?"))
}

export function authorize(turn: TurnProvenance | undefined): Authorization {
  if (!turn) return { allowed: false, reason: "Scheduled task creation requires a current human user turn" }
  if (explicitlyRequestsSchedule(turn.userText)) return { allowed: true, reason: "explicit-user-request" }
  if (confirmsScheduleProposal(turn.userText, turn.previousAssistantText)) {
    return { allowed: true, reason: "confirmed-agent-proposal" }
  }
  return {
    allowed: false,
    reason:
      "The current user turn did not explicitly request scheduling or confirm an immediately preceding scheduling proposal. Ask the user before creating durable future automation.",
  }
}

export function explicitlyRequestsManagement(action: ManagementAction, value: string) {
  const text = normalized(value)
  if (!text || NEGATED.test(text) || INFORMATIONAL.test(text)) return false
  const verb = MANAGEMENT_VERB[action]
  if (!verb.test(text)) return false
  if (action === "run_now" && /\b(?:scheduled?\s+task|schedule|automation|reminder|it|this|that)\b/i.test(text)) return true
  return MANAGE_NOUN.test(text) || /\btask\b/i.test(text)
}

export function confirmsManagementProposal(
  action: ManagementAction,
  userText: string,
  previousAssistantText: string | undefined,
) {
  const user = normalized(userText)
  const assistant = normalized(previousAssistantText)
  if (!AFFIRMATIVE.test(user) || !assistant) return false
  return MANAGEMENT_PROPOSAL.test(assistant) && MANAGEMENT_VERB[action].test(assistant) &&
    (MANAGE_NOUN.test(assistant) || /\btask\b/i.test(assistant))
}

export function authorizeManagement(action: ManagementAction, turn: TurnProvenance | undefined): Authorization {
  if (!turn) return { allowed: false, reason: `Scheduled task ${action} requires a current human user turn` }
  if (explicitlyRequestsManagement(action, turn.userText)) return { allowed: true, reason: "explicit-user-request" }
  if (confirmsManagementProposal(action, turn.userText, turn.previousAssistantText)) {
    return { allowed: true, reason: "confirmed-agent-proposal" }
  }
  return {
    allowed: false,
    reason:
      `The current user turn did not explicitly request scheduled task ${action.replaceAll("_", " ")} or confirm an immediately preceding proposal. Ask the user before mutating durable scheduled automation.`,
  }
}

export function explicitlyRequestsDisabled(value: string) {
  const text = normalized(value)
  return (
    /\bdraft\b/i.test(text) ||
    /\b(?:keep|leave)\b[^.!?\n]{0,60}\bdisabled\b/i.test(text) ||
    /\b(?:do\s+not|don['’]?t|dont)\s+enable\b/i.test(text) ||
    /\bwithout\s+enabling\b/i.test(text)
  )
}
