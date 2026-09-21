import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import type { Message, UserMessage } from "@opencode-ai/sdk/v2"

export function semanticKind(message: Message) {
  return SessionTurnProvenance.semanticKindInfo(message)
}

export function isSemanticUserMessage(message: Message): message is UserMessage {
  return message.role === "user" && SessionTurnProvenance.isSemanticUserInfo(message)
}

export function isWorkerPromptMessage(message: Message): message is UserMessage {
  return message.role === "user" && SessionTurnProvenance.isWorkerPromptInfo(message)
}

export function isStateProjectionMessage(message: Message): boolean {
  return message.role === "user" && SessionTurnProvenance.isStateProjectionInfo(message)
}

/** Historical/imported rows remain renderable history but can never describe a live in-flight turn. */
export function isHistoricalMessage(message: Message): boolean {
  return message.role === "user" && SessionTurnProvenance.resolveInfo(message)?.lifetime === "historical"
}
