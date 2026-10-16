import { snapshotPrompt } from "@/context/prompt-snapshot"
import type { ContentPart, ContextItem } from "@/context/prompt-state"

/** Only the exact draft and execution context that was reviewed may be sent.
 * Read-only fingerprints never leave the client. A malformed/cyclic restored
 * draft yields undefined and must never authorize a reviewed submission.
 */
export type PromptCorrectionReviewScope = {
  prompt: readonly ContentPart[]
  context: readonly (ContextItem & { key: string })[]
  sessionID?: string
  directory: string
  modelID?: string
  providerID?: string
  variant?: string | null
  locale: string
  ignored: readonly string[]
  custom: Readonly<Record<string, string>>
}

export function promptCorrectionReviewFingerprint(input: PromptCorrectionReviewScope): string | undefined {
  try {
    return JSON.stringify({
      prompt: snapshotPrompt(input.prompt),
      context: input.context,
      sessionID: input.sessionID,
      directory: input.directory,
      modelID: input.modelID,
      providerID: input.providerID,
      variant: input.variant,
      locale: input.locale,
      ignored: input.ignored,
      custom: input.custom,
    })
  } catch {
    return undefined
  }
}
