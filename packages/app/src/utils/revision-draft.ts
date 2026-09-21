import { hash } from "@opencode-ai/core/util/encode"

export type RevisionDraftKind = "prompt" | "goal" | "scheduled_task"

export type RevisionDraftTarget = {
  kind: RevisionDraftKind
  key: string
  sourceFingerprint: string
}

/** Compact, collision-resistant edit fence. WebCrypto is browser-safe and the revision path is already async. */
export function revisionSourceFingerprint(source: string) {
  return hash(source)
}

export function revisionWorkspaceSourceFingerprint(input: { directory: string; source: string }) {
  return revisionSourceFingerprint(`${input.directory}\0${input.source}`)
}

export function promptRevisionTargetKey(input: {
  sessionID?: string
  draftID?: string
  directory: string
  windowID?: string
}) {
  if (input.sessionID) return `session:${input.sessionID}`
  if (input.draftID) return `draft:${input.draftID}`
  if (input.windowID) return `new:window:${input.windowID}`
  return `workspace:${input.directory}`
}

/**
 * Prompt target identity is stable across project moves, while the generation
 * fence still includes the workspace that supplied reconnaissance/context.
 * A moved draft therefore stays discoverable but cannot auto-apply an artifact
 * authored against a different directory.
 */
export function promptRevisionSourceFingerprint(input: { directory: string; promptFingerprint: string }) {
  return revisionWorkspaceSourceFingerprint({ directory: input.directory, source: input.promptFingerprint })
}

export function scheduledTaskRevisionTargetKey(input: {
  taskID?: string
  directory: string
  windowID?: string
}) {
  if (input.taskID) return `task:${input.taskID}`
  if (input.windowID) return `new:window:${input.windowID}`
  return `new:workspace:${input.directory}`
}

export type RevisionRecoveryDecision = "apply" | "consume" | "conflict"

export function revisionRecoveryDecision(input: {
  sourceFingerprint: string
  currentFingerprint: string
  currentText: string
  revisedText: string
  /**
   * True only when currentText is already owned by a durable domain record.
   * Ephemeral Goal/Scheduled editor state must retain the mailbox even when it
   * happens to equal the revision.
   */
  consumeIfEqual?: boolean
  /**
   * Pre-creation editors have no durable draft identity that proves the retained
   * artifact still belongs to this incarnation. They may recover it, but never
   * silently apply it merely because reconstructed source happens to match.
   */
  requireExplicitApply?: boolean
}): RevisionRecoveryDecision {
  if (input.currentText === input.revisedText && input.consumeIfEqual !== false) return "consume"
  if (input.requireExplicitApply) return "conflict"
  if (input.currentFingerprint === input.sourceFingerprint) return "apply"
  return "conflict"
}

/**
 * Re-check the optimistic source fence at the instant a delayed recovery action
 * is invoked. A toast can outlive the editor state it was created from.
 */
export function revisionCanApplyNow(input: {
  /** Fingerprint of the exact editor state the pending Apply action was offered against. */
  expectedFingerprint: string
  currentFingerprint: string
}) {
  return input.currentFingerprint === input.expectedFingerprint
}
