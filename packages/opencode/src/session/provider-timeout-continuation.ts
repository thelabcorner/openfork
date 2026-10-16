import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"

// Avoid five physical SDK retries against a silent five-minute stream.
// Recover via a bounded number of fresh, durable logical continuations instead.
export const MAX_PROVIDER_TIMEOUT_CONTINUATIONS = 2

export const PROVIDER_TIMEOUT_CONTINUATION_PROMPT =
  "The previous provider response stopped making progress and timed out. Continue the existing task from the last durable checkpoint. Completed tool results and changes are already complete: do not replay them. For any tool whose execution was interrupted or uncertain, inspect the current state before deciding whether to retry a side effect. Do not restart the task or repeat previous output."

type PreviousTurn = {
  readonly provenance?: { readonly source: string; readonly ref?: string }
}

/** The bounded retry count travels with the durable synthetic turn, never process memory. */
export function nextProviderTimeoutContinuationAttempt(previous: PreviousTurn): number | undefined {
  if (previous.provenance?.source !== SessionTurnProvenance.Source.ProviderTimeoutContinuation) return 1
  const match = /^(\d+):msg_/.exec(previous.provenance.ref ?? "")
  if (!match) return undefined // Unknown provenance must not reset the budget.
  const lastAttempt = Number(match[1])
  if (!Number.isSafeInteger(lastAttempt) || lastAttempt < 1 || lastAttempt >= MAX_PROVIDER_TIMEOUT_CONTINUATIONS)
    return undefined
  return lastAttempt + 1
}