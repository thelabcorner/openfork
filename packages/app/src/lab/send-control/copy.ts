/**
 * Send / Stop concept lab — prototype copy. DEV-ONLY.
 *
 * `Send` and `Stop` come from the real i18n dictionary (`ui.promptInput.send` /
 * `ui.promptInput.stop`) because those strings already exist. Everything else
 * here describes a state the production control does not yet name, so there is
 * no key to reuse.
 *
 * These literals live in one place, marked, for exactly one reason: whichever
 * concept is selected has to land real `ui.promptInput.*` / `prompt.action.*`
 * keys before it is wired up. `packages/app/AGENTS.md` forbids hardcoded
 * user-visible English in production code, and this file is the checklist of
 * what that concept owes the dictionary.
 */
export const LAB_COPY = {
  /** A turn is running and the composer has content. */
  queue: "Send next",
  /** Stop has been requested, the runtime has not acknowledged it. */
  stopping: "Stopping…",
  /** The request is accepted locally but nothing has streamed yet. */
  starting: "Starting…",
  /** A pre-send transform owns the control. */
  blocked: "Preparing prompt…",
  /** No model / no connection. */
  unavailable: "Unavailable",
  /** Turn finished. */
  done: "Done",
  /** Follow-up already queued behind the running turn. */
  queuedCount: (count: number) => (count === 1 ? "1 queued" : `${count} queued`),
} as const
