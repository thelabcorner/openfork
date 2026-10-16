import type { WithParts } from "@opencode-ai/schema/session-v1"
import type { SessionContext } from "@opencode-ai/schema/session-context"
import { estimateMessageTokens } from "./ledger"

/**
 * Preview the actual compiled effective context, not merely the overlay flags.
 *
 * A pinned+excluded message remains effective; edits/tool collapsing can alter
 * token estimates, and legacy invalid overlays may be rejected by the compiler.
 * Reuse the ledger's existing estimates for unchanged message references, so
 * only genuinely transformed messages need another content/token scan.
 *
 * Compiler output retains canonical input ordering. Merge the sorted effective
 * and excluded subsequences with history in one forward pass: O(history) time,
 * O(1) extra memory. Do not allocate two history-sized hash maps per preview.
 */
export function projectContextPreview(input: {
  messages: readonly WithParts[]
  ledger: SessionContext.Ledger
  compiled: { effective: readonly WithParts[]; excluded: readonly WithParts[] }
}) {
  const { messages, ledger, compiled } = input
  if (messages.length !== ledger.entries.length)
    throw new Error("Context preview and ledger do not share the same history")
  const beforeTokens = ledger.totals.estimatedTokens + ledger.totals.estimatedTokensExcluded

  let afterTokens = 0
  let removedTokens = 0
  let includedIndex = 0
  let excludedIndex = 0
  let earliestMutationIndex: number | undefined
  for (let i = 0; i < messages.length; i++) {
    const original = messages[i]!
    const entry = ledger.entries[i]!
    if (entry.messageID !== original.info.id)
      throw new Error("Context preview ledger ordering diverged from history")
    if (earliestMutationIndex === undefined && (entry.excluded || entry.pinned || entry.edited))
      earliestMutationIndex = i

    const removed = compiled.excluded[excludedIndex]
    if (removed?.info.id === original.info.id) {
      excludedIndex++
      removedTokens += entry.tokenEstimate
      continue
    }

    const included = compiled.effective[includedIndex]
    if (included?.info.id !== original.info.id)
      throw new Error("Compiled Context is not an ordered partition of its history")
    includedIndex++
    afterTokens += included === original ? entry.tokenEstimate : estimateMessageTokens(included)
  }
  if (includedIndex !== compiled.effective.length || excludedIndex !== compiled.excluded.length)
    throw new Error("Compiled Context contains unexpected or duplicate messages")

  return {
    beforeTokens,
    afterTokens,
    removedTokens,
    messageCount: messages.length,
    effectiveCount: compiled.effective.length,
    earliestMutationIndex,
  }
}
