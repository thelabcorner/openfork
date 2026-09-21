export * as SwarmRuntimePolicy from "./runtime-policy"

/** First-milestone protocol defaults. Keep executor packages policy-free. */
export const TASK_LEASE_MS = 30 * 60_000
export const TASK_LEASE_RENEW_AHEAD_MS = 10 * 60_000
export const DELIVERY_CLAIM_MS = 30_000
export const DELIVERY_RETRY_MS = 5_000
export const TASK_DISPATCH_BATCH = 16
export const DELIVERY_DISPATCH_BATCH = 32
export const DISPATCH_CONCURRENCY = 4
export const DEADLINE_BATCH = 64
export const DEADLINE_CONCURRENCY = 8
export const RETIREMENT_PROBE_MS = 5_000
export const RETIREMENT_BATCH = 32
export const RETIREMENT_CONCURRENCY = 4
