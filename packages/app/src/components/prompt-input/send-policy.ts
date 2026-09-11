export type PromptPrimaryAction = "submit" | "revise" | "clarify" | "stop" | "blocked"
export type PromptRevisionAutomaticIntent = "review" | "send"

export function isPromptTextRevisable(text: string) {
  const value = text.trim()
  if (!value) return false
  // Slash commands are executable composer syntax, not natural-language
  // prompts. Rewriting them can change the command token or arguments and is
  // therefore never an automatic pre-send operation.
  return !value.startsWith("/")
}

export function resolvePromptPrimaryAction(input: {
  mode: "normal" | "shell"
  working: boolean
  canSubmit: boolean
  hasRevisableText: boolean
  autoReviseBeforeSending: boolean
  revisionBusy: boolean
  awaitingClarification?: boolean
  revisionReadyForSend?: boolean
}): PromptPrimaryAction {
  if (input.revisionBusy) return "blocked"
  if (input.awaitingClarification) return "clarify"
  if (input.working && !input.canSubmit) return "stop"
  if (
    input.mode === "normal" &&
    input.canSubmit &&
    input.hasRevisableText &&
    input.autoReviseBeforeSending &&
    !input.revisionReadyForSend
  )
    return "revise"
  return "submit"
}

export function resolveAutomaticRevisionIntent(input: {
  autoReviseBeforeSending: boolean
  autoSendAfterRevision: boolean
}): PromptRevisionAutomaticIntent | undefined {
  if (!input.autoReviseBeforeSending) return undefined
  return input.autoSendAfterRevision ? "send" : "review"
}

export function promptOneShotRevisionAction(autoReviseBeforeSending: boolean) {
  return autoReviseBeforeSending ? "send-without-revisor" : "send-with-revisor"
}
