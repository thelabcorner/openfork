// Webview crash recovery planner (pure state machine; unit-tested).
//
// On `render-process-gone` the guest is remounted with the last known URL
// after an escalating delay, so a crash loop does not hammer the guest
// process. Mirrors the T3 `planWebviewCrashRecovery` semantics.

export interface WebviewCrashRecoveryState {
  attempts: number
  lastCrashAt: number
}

export const INITIAL_WEBVIEW_CRASH_RECOVERY_STATE: WebviewCrashRecoveryState = {
  attempts: 0,
  lastCrashAt: 0,
}

export const WEBVIEW_CRASH_MAX_ATTEMPTS = 5
export const WEBVIEW_CRASH_BASE_DELAY_MS = 500
export const WEBVIEW_CRASH_BACKOFF = 2
export const WEBVIEW_CRASH_COOLDOWN_MS = 5_000

export interface WebviewCrashPlan {
  remount: boolean
  delayMs: number
  state: WebviewCrashRecoveryState
}

/**
 * Decide whether/how to remount after a guest crash. Crashes within the
 * cooldown window escalate (backoff), then give up to let the page settle.
 */
export function planWebviewCrashRecovery(
  state: WebviewCrashRecoveryState,
  now: number,
): WebviewCrashPlan {
  if (now - state.lastCrashAt > WEBVIEW_CRASH_COOLDOWN_MS) {
    const next = { attempts: 1, lastCrashAt: now }
    return { remount: true, delayMs: WEBVIEW_CRASH_BASE_DELAY_MS, state: next }
  }

  const attempts = state.attempts + 1
  const next = { attempts, lastCrashAt: now }
  if (attempts > WEBVIEW_CRASH_MAX_ATTEMPTS) {
    return { remount: false, delayMs: 0, state: next }
  }

  return {
    remount: true,
    delayMs: WEBVIEW_CRASH_BASE_DELAY_MS * Math.pow(WEBVIEW_CRASH_BACKOFF, attempts - 1),
    state: next,
  }
}
