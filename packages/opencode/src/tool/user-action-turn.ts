import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"

export interface UserTurn {
  readonly userMessageID: string
  readonly userText: string
  readonly previousAssistantText?: string
}

export interface Turn extends UserTurn {
  /**
   * Newest-first bounded human history. This is deliberately opt-in so other
   * durable-action fences (for example Scheduled Tasks) keep current-turn-only
   * semantics unless their domain policy explicitly adopts persistent consent.
   */
  readonly priorUserTurns?: readonly UserTurn[]
}

const MAX_HISTORY_MESSAGES = 8_192
const MAX_HISTORY_USER_TURNS = 64
const MAX_HISTORY_CHARS = 64 * 1024
const MAX_ACTIVE_USER_CHARS = 32 * 1024
const MAX_HISTORICAL_USER_CHARS = 8 * 1024
const MAX_ASSISTANT_CHARS = 8 * 1024

function boundedText(message: SessionV1.WithParts, maxChars: number, includeSynthetic: boolean) {
  if (maxChars <= 0) return ""
  const texts = message.parts
    .filter(
      (part): part is SessionV1.TextPart =>
        part.type === "text" && (includeSynthetic || part.synthetic !== true),
    )
    .map((part) => part.text)

  if (texts.length === 0) return ""
  const total = texts.reduce((sum, text) => sum + text.length, Math.max(0, texts.length - 1))
  if (total <= maxChars) return texts.join("\n").trim()
  if (maxChars < 16) return texts[0]!.slice(0, maxChars).trim()

  const marker = "\n…\n"
  const payload = maxChars - marker.length
  const headBudget = Math.ceil(payload / 2)
  const tailBudget = payload - headBudget
  let head = ""
  for (const text of texts) {
    const separator = head ? "\n" : ""
    const remaining = headBudget - head.length
    if (remaining <= 0) break
    const chunk = `${separator}${text}`
    head += chunk.length <= remaining ? chunk : chunk.slice(0, remaining)
  }

  let tail = ""
  for (let index = texts.length - 1; index >= 0; index--) {
    const text = texts[index]!
    const separator = tail ? "\n" : ""
    const remaining = tailBudget - tail.length
    if (remaining <= 0) break
    const chunk = `${text}${separator}`
    tail = chunk.length <= remaining ? `${chunk}${tail}` : `${chunk.slice(-remaining)}${tail}`
  }
  return `${head}${marker}${tail}`.trim()
}

function previousAssistantText(messages: readonly SessionV1.WithParts[], beforeIndex: number) {
  const lower = Math.max(0, beforeIndex - MAX_HISTORY_MESSAGES)
  for (let index = beforeIndex - 1; index >= lower; index--) {
    const message = messages[index]
    if (message?.info.role !== "assistant") continue
    const text = boundedText(message, MAX_ASSISTANT_CHARS, true)
    return text || undefined
  }
  return undefined
}

function humanTurn(message: SessionV1.WithParts, previousAssistantText?: string, maxChars = MAX_ACTIVE_USER_CHARS): UserTurn {
  return {
    userMessageID: String(message.info.id),
    userText: boundedText(message, maxChars, false),
    ...(previousAssistantText ? { previousAssistantText } : {}),
  }
}

/**
 * Resolve the active human authorization root from the history already supplied
 * to the tool. Do not search for any older matching human turn: the latest
 * worker root owns the current causal execution, so a host/scheduled/subagent
 * root cannot borrow stale consent.
 */
export function current(messages: readonly SessionV1.WithParts[]): Turn | undefined {
  const rootIndex = messages.findLastIndex(SessionTurnProvenance.isWorkerPromptTurn)
  if (rootIndex < 0) return undefined
  const root = messages[rootIndex]
  if (!root || !SessionTurnProvenance.isDurableUserActionAuthorizationTurn(root)) return undefined
  if (root.info.role !== "user") return undefined
  return humanTurn(root, previousAssistantText(messages, rootIndex))
}

/**
 * Goal creation uses persistent human intent rather than requiring the model to
 * invoke the tool on the exact turn containing "create a Goal". The active
 * worker root must still be a real human authorization turn, which prevents
 * scheduled/host/subagent work from borrowing old consent.
 *
 * History traversal is bounded by message count, human-turn count and copied
 * text bytes. It only inspects the messages already supplied to the tool; there
 * is no database/history query and no model call on the hot path.
 */
export function currentWithHistory(messages: readonly SessionV1.WithParts[]): Turn | undefined {
  const rootIndex = messages.findLastIndex(SessionTurnProvenance.isWorkerPromptTurn)
  if (rootIndex < 0) return undefined
  const root = messages[rootIndex]
  if (!root || !SessionTurnProvenance.isDurableUserActionAuthorizationTurn(root)) return undefined
  if (root.info.role !== "user") return undefined

  const active = humanTurn(root, previousAssistantText(messages, rootIndex))
  const priorUserTurns: UserTurn[] = []
  let copiedChars = active.userText.length + (active.previousAssistantText?.length ?? 0)
  let pending: UserTurn | undefined
  const lower = Math.max(0, rootIndex - MAX_HISTORY_MESSAGES)

  for (let index = rootIndex - 1; index >= lower; index--) {
    const message = messages[index]
    if (!message) continue

    if (message.info.role === "assistant") {
      if (pending && !pending.previousAssistantText && copiedChars < MAX_HISTORY_CHARS) {
        const text = boundedText(
          message,
          Math.min(MAX_ASSISTANT_CHARS, MAX_HISTORY_CHARS - copiedChars),
          true,
        )
        if (text) {
          pending = { ...pending, previousAssistantText: text }
          copiedChars += text.length
        }
      }
      continue
    }

    if (!SessionTurnProvenance.isDurableUserActionAuthorizationTurn(message)) continue
    if (message.info.role !== "user") continue

    if (pending) {
      priorUserTurns.push(pending)
      if (priorUserTurns.length >= MAX_HISTORY_USER_TURNS - 1) {
        pending = undefined
        break
      }
    }
    if (copiedChars >= MAX_HISTORY_CHARS) {
      pending = undefined
      break
    }

    const maxChars = Math.min(MAX_HISTORICAL_USER_CHARS, MAX_HISTORY_CHARS - copiedChars)
    pending = humanTurn(message, undefined, maxChars)
    copiedChars += pending.userText.length
  }

  if (pending && priorUserTurns.length < MAX_HISTORY_USER_TURNS - 1) priorUserTurns.push(pending)
  return priorUserTurns.length === 0 ? active : { ...active, priorUserTurns }
}
