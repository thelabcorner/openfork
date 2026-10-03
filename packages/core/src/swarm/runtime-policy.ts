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
/** Quiescence-probe cadence for closing executions that never settled. */
export const EXECUTION_CLOSURE_PROBE_MS = 2_000
export const EXECUTION_CLOSURE_BATCH = 32
export const EXECUTION_CLOSURE_CONCURRENCY = 4
/**
 * A `creating` Swarm that has not advanced past aggregate creation for this long
 * is treated as abandoned. It must also own no member, task, or lease, so
 * closure can never destroy partially materialized work.
 */
export const ABANDONED_SWARM_STALE_MS = 15 * 60_000
/** Idle `active` aggregates are reported to operators at this age, never auto-closed. */
export const STALE_ACTIVE_SWARM_MS = 24 * 60 * 60_000
export const AGGREGATE_RECOVERY_BATCH = 32
