/**
 * Retry policy for the dev Node-sidecar candidate builder.
 *
 * Exit 75 means the transactional runtime artifact lock is temporarily busy,
 * so keep retrying with a capped backoff. Other failures are commonly genuine
 * compile errors: retry only a few times to absorb transient filesystem/process
 * failures, then wait for the next source change instead of rebuilding forever.
 */
const BUSY_BASE_DELAY_MS = 250
const BUSY_MAX_DELAY_MS = 5_000
const BUSY_RETRY_LIMIT = 24
const FAILURE_DELAYS_MS = [1_000, 5_000, 15_000] as const

export function busyBuildRetryDelay(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= BUSY_RETRY_LIMIT) return
  const bounded = Math.max(0, Math.min(attempt, 30))
  return Math.min(BUSY_BASE_DELAY_MS * 2 ** bounded, BUSY_MAX_DELAY_MS)
}

export function failedBuildRetryDelay(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 0) return
  return FAILURE_DELAYS_MS[attempt]
}

export const buildRetryPolicy = {
  busyMaxDelayMs: BUSY_MAX_DELAY_MS,
  busyRetries: BUSY_RETRY_LIMIT,
  failureRetries: FAILURE_DELAYS_MS.length,
} as const
