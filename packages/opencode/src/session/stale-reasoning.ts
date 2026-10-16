import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "./session"

const CRYPTO_KEYS = ["reasoningEncryptedContent", "encrypted_content", "encryptedContent", "itemId"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stripBox = (value: unknown) => {
  if (!isRecord(value)) return false
  let changed = false
  for (const key of CRYPTO_KEYS) {
    if (key in value) {
      delete value[key]
      changed = true
    }
  }
  if (isRecord(value.openai)) {
    if (stripBox(value.openai)) changed = true
    if (Object.keys(value.openai).length === 0) delete value.openai
  }
  return changed
}

/**
 * Strip caller-bound OpenAI reasoning replay handles from a reconstructed provider request.
 *
 * Visible reasoning text is intentionally retained. The encrypted payload / reasoning item
 * identity is continuation state issued to one provider caller and must not survive a caller
 * rotation, process restart, or gateway route change.
 */
export function stripRequest(messages: ModelMessage[]) {
  for (const message of messages) {
    if (message.role !== "assistant") continue
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue
      if (!("type" in part) || part.type !== "reasoning") continue
      const rec = part as unknown as Record<string, unknown>
      if (typeof rec.id === "string" && rec.id.startsWith("rs_")) delete rec.id
      stripBox(rec)
      stripBox(rec.providerOptions)
      stripBox(rec.providerMetadata)
      if (isRecord(rec.providerOptions) && Object.keys(rec.providerOptions).length === 0) delete rec.providerOptions
      if (isRecord(rec.providerMetadata) && Object.keys(rec.providerMetadata).length === 0) delete rec.providerMetadata
    }
  }
}

const stripKeys = (value: Record<string, unknown>): { next: Record<string, unknown>; changed: boolean } => {
  let changed = false
  const next: Record<string, unknown> = { ...value }
  for (const key of CRYPTO_KEYS) {
    if (key in next) {
      delete next[key]
      changed = true
    }
  }
  if (isRecord(next.openai)) {
    const openai = stripKeys(next.openai)
    if (openai.changed) {
      changed = true
      if (Object.keys(openai.next).length === 0) delete next.openai
      else next.openai = openai.next
    }
  }
  return { next, changed }
}

export function stripPart(part: SessionV1.ReasoningPart) {
  const metadata = part.metadata
  if (!isRecord(metadata)) return part
  const stripped = stripKeys(metadata)
  if (!stripped.changed) return part
  return {
    ...part,
    metadata: Object.keys(stripped.next).length === 0 ? undefined : stripped.next,
  }
}

/**
 * Remove stale replay handles from durable V1 reasoning parts so future turns,
 * restarts, and model/route switches do not resend them.
 *
 * `messages` must be durable history the turn owner already holds at the
 * request boundary. Recovery is rare but a transcript is not small, so this
 * deliberately never hydrates the whole Session here.
 */
export const persist = (session: Session.Interface, messages: readonly SessionV1.WithParts[]) =>
  Effect.gen(function* () {
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== "reasoning") continue
        const next = stripPart(part)
        if (next === part) continue
        yield* session.updatePart(next)
      }
    }
  })

export * as SessionStaleReasoning from "./stale-reasoning"
