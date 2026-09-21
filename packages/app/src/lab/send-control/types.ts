/**
 * Send / Stop concept lab — shared vocabulary.
 *
 * DEV-ONLY. Nothing in `src/lab/**` is reachable from the shipped app: the only
 * entry points are `lab-send-control.html` files that are deliberately excluded
 * from every Rollup `build.rollupOptions.input`. These prototypes must never
 * import a real submit/abort path.
 *
 * The state vocabulary below is a faithful *model* of what the production
 * composer actually knows at the moment the control renders, derived from:
 *
 *   - `packages/app/src/components/prompt-input/send-policy.ts`
 *     (`resolvePromptPrimaryAction`: blocked -> stop -> revise -> submit)
 *   - `packages/app/src/components/prompt-input-v2.tsx`
 *     (`stopping = working() && blank()` — the control means Stop only while a
 *      turn runs *and* the composer is empty)
 *   - `packages/session-ui/src/v2/components/prompt-input/interaction.ts`
 *     (Enter = primary action; Escape / Ctrl+G = stop, and those work even when
 *      the composer has text)
 *
 * The important consequence, and the thing these five concepts actually
 * disagree about: the pointer target has FOUR live meanings, not two.
 */

import {
  isPromptTextRevisable,
  promptOneShotRevisionAction,
  resolveAutomaticRevisionIntent,
  resolvePromptPrimaryAction,
  type PromptPrimaryAction,
} from "@/components/prompt-input/send-policy"

export type LabTurnPhase =
  /** No turn owns the session. */
  | "idle"
  /** Optimistic: the send was accepted locally, nothing has streamed yet. */
  | "arming"
  /** The assistant is producing output. Interruptible. */
  | "running"
  /** Stop was requested; the runtime has not acknowledged it yet. */
  | "stopping"
  /** The turn just ended. A short, deliberate acknowledgement window. */
  | "settling"

export const LAB_TURN_PHASES: LabTurnPhase[] = ["idle", "arming", "running", "stopping", "settling"]

export type LabComposerMode = "normal" | "shell"

/** Forced interaction state, so a reviewer can inspect a pseudo-state directly. */
export type LabForced = "none" | "hover" | "focus" | "pressed"

/**
 * Prompt Revisor facts. These are the inputs `resolvePromptPrimaryAction`
 * actually takes, so the lab can run the *real* policy instead of a lookalike.
 */
export type LabRevisorFacts = {
  /** Setting: rewrite the draft before every send. */
  autoBeforeSend: boolean
  /** Setting: after rewriting, send immediately instead of staging for review. */
  autoSendAfterRevision: boolean
  /** A revision is running right now. The control belongs to neither Send nor Stop. */
  busy: boolean
  /** A revision has been produced and is staged; the next press sends it. */
  readyForSend: boolean
  /** Raw draft text, so `isPromptTextRevisable` can be run for real. */
  draft: string
}

export type LabComposerFacts = {
  /** Trimmed text (or a mention) is present. */
  hasText: boolean
  /** An image/file attachment is present — enough to submit with no text. */
  hasAttachment: boolean
  mode: LabComposerMode
  /**
   * The control cannot act at all: no model resolved, server unreachable, or a
   * read-only composer. Distinct from "empty".
   */
  unavailable: boolean
  /**
   * A transient pre-send transform owns the control (production: the prompt
   * revisor running before send). Neither Send nor Stop is correct yet.
   */
  blocked: boolean
}

export type LabTurnFacts = {
  phase: LabTurnPhase
  /** Wall time in the current turn, ms. */
  elapsedMs: number
  /** Synthetic 0..1 output pressure. Real turns have no progress; this only feeds motion. */
  pressure: number
  /** Synthetic measured rate, matching the composer's live-rate readout. */
  tokensPerSecond: number
  /** Follow-ups the user has queued during this turn. */
  queued: number
}

export type LabModel = {
  composer: LabComposerFacts
  turn: LabTurnFacts
  revisor: LabRevisorFacts
  forced: LabForced
  /** Harness override for `prefers-reduced-motion`. */
  reducedMotion: boolean
}

export type LabActions = {
  /** Mock send. Never touches a real session. */
  send: () => void
  /** Mock abort. Never touches a real session. */
  stop: () => void
  revisor: {
    setAutoBeforeSend: (value: boolean) => void
    setAutoSendAfterRevision: (value: boolean) => void
    /**
     * The send-options menu's one-shot item: send *without* the revisor when
     * auto-revise is armed, or *with* it when it is not.
     */
    oneShot: () => void
    /** Run the revision the primary action asked for. */
    revise: () => void
  }
}

/**
 * What activating the control means right now, under *production* semantics.
 * Concepts are free to deviate — and three of the five deliberately do — but
 * they must say so, because this is the behaviour users have today.
 */
export type LabIntent =
  /** Composer empty and idle: nothing to do. */
  | "inert"
  /** Start a new turn. */
  | "send"
  /** A turn is running and the composer has content: send a follow-up. */
  | "queue"
  /** A turn is running and the composer is empty: interrupt. */
  | "stop"
  /** Stop already requested. */
  | "stopping"
  /** A pre-send transform owns the control. */
  | "blocked"
  /** The control cannot act. */
  | "unavailable"

export function labProductionIntent(model: LabModel): LabIntent {
  const { composer, turn } = model
  if (composer.unavailable) return "unavailable"
  if (composer.blocked) return "blocked"
  if (turn.phase === "stopping") return "stopping"
  const busy = turn.phase === "arming" || turn.phase === "running"
  const canSubmit = composer.hasText || composer.hasAttachment
  if (busy && !canSubmit) return "stop"
  if (busy) return "queue"
  if (!canSubmit) return "inert"
  return "send"
}

/** True while an interrupt is a meaningful thing to offer. */
export function labInterruptible(model: LabModel) {
  return model.turn.phase === "arming" || model.turn.phase === "running"
}

export function labCanSubmit(model: LabModel) {
  if (model.composer.unavailable || model.composer.blocked) return false
  return model.composer.hasText || model.composer.hasAttachment
}

export function labElapsedLabel(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) * 100) / 1000}s`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

/**
 * `IconButtonV2` forwards `state` straight to `data-state`, and
 * `icon-button-v2.css` already styles `[data-state="focus"]` — the prop type
 * just predates it. One narrow cast here keeps the concepts honest about using
 * the real primitive instead of reimplementing its token treatments.
 */
export function labForcedButtonState(forced: LabForced) {
  if (forced === "none") return undefined
  return forced as "hover" | "pressed"
}

/**
 * The composer's primary action, resolved by the **real** policy module rather
 * than a lookalike. Importing `send-policy.ts` is safe — it is pure, has no
 * runtime coupling, and is the single place this behaviour is defined:
 *
 *   revisionBusy            -> "blocked"
 *   working && !canSubmit   -> "stop"
 *   auto-revise armed       -> "revise"
 *   otherwise               -> "submit"
 */
export function labSendPolicyAction(model: LabModel): PromptPrimaryAction {
  return resolvePromptPrimaryAction({
    mode: model.composer.mode,
    working: labInterruptible(model),
    canSubmit: model.composer.hasText || model.composer.hasAttachment,
    hasRevisableText: isPromptTextRevisable(model.revisor.draft),
    autoReviseBeforeSending: model.revisor.autoBeforeSend,
    revisionBusy: model.revisor.busy,
    revisionReadyForSend: model.revisor.readyForSend,
  })
}

/** What the menu's one-shot item should offer, given the current default. */
export function labOneShot(model: LabModel) {
  return promptOneShotRevisionAction(model.revisor.autoBeforeSend)
}

/** Whether the staged revision would be sent straight away or held for review. */
export function labRevisionIntent(model: LabModel) {
  return resolveAutomaticRevisionIntent({
    autoReviseBeforeSending: model.revisor.autoBeforeSend,
    autoSendAfterRevision: model.revisor.autoSendAfterRevision,
  })
}
