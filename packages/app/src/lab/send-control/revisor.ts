/**
 * Send / Stop concept lab — mock Prompt Revisor. DEV-ONLY.
 *
 * Models only what the send control can observe: the two persisted settings,
 * whether a revision is running, and whether one is staged awaiting send. It
 * never calls the revisor service, never touches a draft mailbox, and never
 * produces revised text — the prototypes only need the *shape* of the state to
 * be judged.
 *
 * The settings are shared across every stage so the compare view stays in sync;
 * the draft text stays per-stage, because `isPromptTextRevisable` has to run
 * against whatever is actually in that editor.
 */

import { createStore } from "solid-js/store"
import { onCleanup } from "solid-js"

/** How long a mock revision takes. Long enough that the busy state is readable. */
const REVISION_MS = 1400

export type LabRevisor = {
  autoBeforeSend: () => boolean
  autoSendAfterRevision: () => boolean
  busy: () => boolean
  readyForSend: () => boolean
  setAutoBeforeSend: (value: boolean) => void
  setAutoSendAfterRevision: (value: boolean) => void
  /**
   * Run a revision. Resolves to `true` when the caller should immediately send
   * the result (auto-send after revising), `false` when it is staged for review.
   */
  run: (options?: { autoSend?: boolean }) => Promise<boolean>
  /** Consume the staged revision — what actually sending it does. */
  consume: () => void
  reset: () => void
}

export function createLabRevisor(): LabRevisor {
  const [state, setState] = createStore({
    autoBeforeSend: false,
    autoSendAfterRevision: false,
    busy: false,
    readyForSend: false,
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  onCleanup(clear)

  return {
    autoBeforeSend: () => state.autoBeforeSend,
    autoSendAfterRevision: () => state.autoSendAfterRevision,
    busy: () => state.busy,
    readyForSend: () => state.readyForSend,
    setAutoBeforeSend: (value) => {
      // Mirrors the production setting pair: auto-send is meaningless on its own.
      setState({ autoBeforeSend: value, autoSendAfterRevision: value ? state.autoSendAfterRevision : false })
    },
    setAutoSendAfterRevision: (value) => setState("autoSendAfterRevision", value),
    run: (options) =>
      new Promise((resolve) => {
        if (state.busy) {
          resolve(false)
          return
        }
        clear()
        setState({ busy: true, readyForSend: false })
        timer = setTimeout(() => {
          timer = undefined
          const autoSend = options?.autoSend ?? state.autoSendAfterRevision
          setState({ busy: false, readyForSend: !autoSend })
          resolve(autoSend)
        }, REVISION_MS)
      }),
    consume: () => setState("readyForSend", false),
    reset: () => {
      clear()
      setState({ busy: false, readyForSend: false })
    },
  }
}
