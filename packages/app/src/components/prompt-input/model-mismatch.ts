import type { SessionTelemetry } from "@opencode-ai/schema/session-telemetry"
import { splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"

export type ModelIdentity = {
  providerID: string
  modelID: string
  accountID?: string
  variant?: string
}

function normalizedVariant(variant: string | undefined) {
  return variant === "default" ? "" : (variant ?? "")
}

/**
 * Canonical [provider, base model, account, variant] identity. The selector
 * encodes a per-account key pin as an account-neutral modelID plus a separate
 * accountID, while generation telemetry may carry the same pin as an
 * account-qualified modelID (`base@zen-…`). Normalize both spellings so a
 * pinned key cannot compare as a different model.
 */
export function modelIdentityKey(model: ModelIdentity | undefined) {
  if (!model) return undefined
  const parts = splitModelIDForProvider(model.modelID, model.providerID)
  return JSON.stringify([
    model.providerID,
    parts.baseModelID,
    model.accountID ?? parts.accountID ?? "",
    normalizedVariant(model.variant),
  ])
}

function generationIdentityKey(model: ModelIdentity) {
  const parts = splitModelIDForProvider(model.modelID, model.providerID)
  return JSON.stringify([model.providerID, parts.baseModelID, normalizedVariant(model.variant)])
}

function servingAccountID(model: ModelIdentity) {
  return model.accountID ?? splitModelIDForProvider(model.modelID, model.providerID).accountID
}

/**
 * The banner asks which model is running, not which key served it. A missing
 * accountID means the producer did not report the serving account, so an
 * account difference only refutes the same-model verdict when both identities
 * name an account. Key pinning alone is never a mismatch.
 */
function isGenerationModelMismatch(selected: ModelIdentity, active: ModelIdentity) {
  if (generationIdentityKey(selected) !== generationIdentityKey(active)) return true
  const selectedAccount = servingAccountID(selected)
  const activeAccount = servingAccountID(active)
  return selectedAccount !== undefined && activeAccount !== undefined && selectedAccount !== activeAccount
}

export function activeGenerationMismatch(input: {
  selected?: ModelIdentity
  telemetry?: SessionTelemetry.Info
  sessionID?: string
}) {
  const info = input.telemetry
  if (!input.sessionID || info?.sessionID !== input.sessionID) return
  if (info.isCompaction || !["requesting", "reasoning", "generating"].includes(info.phase)) return
  if (!info.model) return
  const selectedKey = modelIdentityKey(input.selected)
  const activeKey = modelIdentityKey(info.model)
  if (!selectedKey || !activeKey || selectedKey === activeKey) return
  if (input.selected && !isGenerationModelMismatch(input.selected, info.model)) return
  return {
    selectedKey,
    activeKey,
    attemptKey:
      info.step?.assistantMessageID && info.step.requestSentAt !== undefined
        ? `${info.step.assistantMessageID}:${info.step.requestSentAt}`
        : undefined,
    model: info.model,
  }
}

/**
 * Reverse-follow is only allowed for a newly observed provider attempt while
 * the user's selected model stayed put. A stale attempt cannot undo an explicit
 * selector change while the switch handoff is still being admitted.
 */
export function shouldFollowActiveModel(input: {
  enabled: boolean
  nextAttemptKey?: string
  previousAttemptKey?: string
  selectedKey?: string
  previousSelectedKey?: string
  activeKeyBefore?: string
  activeKey?: string
}) {
  return !!(
    input.enabled &&
    input.nextAttemptKey &&
    input.nextAttemptKey !== input.previousAttemptKey &&
    input.selectedKey &&
    input.selectedKey === input.previousSelectedKey &&
    input.activeKey &&
    input.activeKey !== input.activeKeyBefore &&
    input.activeKey !== input.selectedKey
  )
}
