export * as ScheduledTaskPolicy from "./policy"

import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { nextOccurrence, occurrencesBetween } from "./recurrence"

/**
 * Named defaults. Nothing here is invisible: `resolvePolicy` persists every
 * field on create/update, so the API and editor always see the effective
 * policy (02 § "no hidden defaults").
 */
export const DEFAULTS = {
  catchUp: "skip",
  catchUpMaxAgeMs: 6 * 60 * 60 * 1000,
  overrun: "skip",
  jitterMs: 0,
  maxAttempts: 2,
  maxDurationMs: 30 * 60 * 1000,
  retentionRuns: 200,
  permission: "deny",
  notify: "failure",
} as const

export const LIMITS = {
  /**
   * Jitter is an anti-thundering-herd offset, not a scheduling primitive.
   * Beyond this ceiling a "jitter" value would silently reshape the schedule.
   */
  jitterMs: 15 * 60 * 1000,
  catchUpMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxAttempts: 5,
  maxDurationMs: 24 * 60 * 60 * 1000,
  retentionRuns: 10_000,
} as const

export function resolvePolicy(input: ScheduledTask.Policy | undefined): ScheduledTask.ResolvedPolicy {
  const clamp = (value: number | undefined, fallback: number, maximum: number) => {
    if (value === undefined || !Number.isFinite(value)) return fallback
    return Math.min(Math.max(Math.floor(value), 0), maximum)
  }
  return {
    catchUp: input?.catchUp ?? DEFAULTS.catchUp,
    catchUpMaxAgeMs: Math.max(clamp(input?.catchUpMaxAgeMs, DEFAULTS.catchUpMaxAgeMs, LIMITS.catchUpMaxAgeMs), 60_000),
    overrun: input?.overrun ?? DEFAULTS.overrun,
    jitterMs: clamp(input?.jitterMs, DEFAULTS.jitterMs, LIMITS.jitterMs),
    maxAttempts: Math.max(clamp(input?.maxAttempts, DEFAULTS.maxAttempts, LIMITS.maxAttempts), 1),
    maxDurationMs: Math.max(clamp(input?.maxDurationMs, DEFAULTS.maxDurationMs, LIMITS.maxDurationMs), 60_000),
    retentionRuns: Math.max(clamp(input?.retentionRuns, DEFAULTS.retentionRuns, LIMITS.retentionRuns), 1),
    permission: input?.permission ?? DEFAULTS.permission,
    notify: input?.notify ?? DEFAULTS.notify,
  }
}

/** On-time lateness tolerance: dispatch delays are normal, missed runs are not. */
export const LATE_GRACE_MS = 5 * 60 * 1000

/** 02 § 4.2 guard: `run_all` never expands beyond this many instants. */
export const MAX_CATCHUP_INSTANTS = 10

/** 03 § 6: retries land before the next scheduled instant, on this backoff. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(60_000 * Math.max(1, attempt), 15 * 60 * 1000)
}

export function isRetryable(errorKind: ScheduledTask.ErrorKind | undefined): boolean {
  return errorKind === "quota" || errorKind === "provider"
}

export function countsTowardCircuitBreaker(errorKind: ScheduledTask.ErrorKind | undefined): boolean {
  if (errorKind === undefined) return true
  return !isRetryable(errorKind) && errorKind !== "aborted"
}

export function retryableAttempts(policy: ScheduledTask.ResolvedPolicy): number {
  return Math.max(1, policy.maxAttempts)
}

/**
 * Notification policy for a logical scheduled run.
 *
 * Retryable attempt failures are explicitly non-terminal: notifying before the
 * retry resolves would turn normal recovery into user-facing noise. The default
 * failure mode covers durable execution failure and crash/lease abandonment;
 * policy skips remain visible in run history but are not escalated by default.
 */
export function shouldNotifyRun(input: {
  readonly notify: ScheduledTask.NotifyMode
  readonly status: ScheduledTask.RunStatus
  readonly retryPending: boolean
}): boolean {
  if (input.retryPending) return false
  if (input.notify === "never") return false
  if (input.notify === "always") {
    return (
      input.status === "succeeded" ||
      input.status === "failed" ||
      input.status === "skipped" ||
      input.status === "abandoned"
    )
  }
  return input.status === "failed" || input.status === "abandoned"
}

/**
 * EventV2 settlement payloads are live accelerators. A retry may already have
 * advanced the one logical run row by the time a subscriber handles an older
 * settlement event, so consumers must compare the event to current durable
 * truth before producing side effects.
 */
export function isCurrentSettlement(input: {
  readonly current: {
    readonly status: ScheduledTask.RunStatus
    readonly attempt: number
    readonly finishedAt: number | null
  }
  readonly projected: {
    readonly status: ScheduledTask.RunStatus
    readonly attempt?: number
    readonly finishedAt?: number
  }
}): boolean {
  return (
    input.current.attempt === (input.projected.attempt ?? 1) &&
    input.current.status === input.projected.status &&
    input.current.finishedAt === (input.projected.finishedAt ?? null)
  )
}

export type DueDecision =
  | {
      readonly kind: "fire"
      readonly fireFor: number
      readonly trigger: "schedule" | "catchup" | "retry"
    }
  | {
      readonly kind: "skip"
      readonly fireFor: number
      readonly trigger: "schedule" | "catchup"
      readonly reason: ScheduledTask.SkipReason
      /** Cursor to write after recording the skip. `undefined` = exhausted. */
      readonly nextRunAt: number | undefined
    }

/**
 * Pure catch-up/overrun decision for one due task. The runner never interprets
 * policy itself; it executes this plan.
 *
 * `late` is derived from the logical instant (not jitter): jitter changes when
 * the runner wakes, never what `fire_for` means.
 */
export function decideDue(input: {
  readonly task: {
    readonly id: string
    readonly schedule: ScheduledTask.Schedule
    readonly timezone: string | undefined
    readonly policy: ScheduledTask.ResolvedPolicy
    readonly nextRunAt: number
  }
  readonly now: number
  /** Pending-retry lease projection: logical instant awaiting a retry. */
  readonly pendingRetry?: { readonly fireFor: number }
}): DueDecision {
  const { task, now } = input
  if (input.pendingRetry) {
    return { kind: "fire", fireFor: input.pendingRetry.fireFor, trigger: "retry" }
  }

  const fireFor = task.nextRunAt
  const late = now - fireFor
  if (late <= LATE_GRACE_MS) {
    return { kind: "fire", fireFor, trigger: "schedule" }
  }

  const next = nextOccurrence({ schedule: task.schedule, timezone: task.timezone, after: now })
  switch (task.policy.catchUp) {
    case "skip":
      return { kind: "skip", fireFor, trigger: "schedule", reason: "stale", nextRunAt: next }
    case "run_once":
    case "run_all": {
      const missed = missedInstants({
        schedule: task.schedule,
        timezone: task.timezone,
        fireFor,
        now,
        maxAgeMs: task.policy.catchUpMaxAgeMs,
        cap: MAX_CATCHUP_INSTANTS,
      })
      // Nothing is inside the staleness ceiling: the whole backlog is stale.
      if (missed.count === 0) {
        return { kind: "skip", fireFor, trigger: "catchup", reason: "stale", nextRunAt: next }
      }
      if (task.policy.catchUp === "run_all" && missed.count > MAX_CATCHUP_INSTANTS) {
        // Collapse the oldest misses into one visible stale row, then fire the
        // newest capped instants one at a time through the lease.
        return {
          kind: "skip",
          fireFor,
          trigger: "catchup",
          reason: "stale",
          nextRunAt: missed.oldestOfTail,
        }
      }
      // `run_once` fires a single catch-up for the earliest eligible instant and
      // settlement collapses the rest onto `now`.
      return { kind: "fire", fireFor: missed.first, trigger: "catchup" }
    }
  }
}

/** Hard bound on the backward-fill iteration for a pathological catch-up window. */
const COLLAPSE_ITERATION_CAP = 100_000

export function missedInstants(input: {
  readonly schedule: ScheduledTask.Schedule
  readonly timezone: string | undefined
  readonly fireFor: number
  readonly now: number
  readonly maxAgeMs: number
  readonly cap: number
}): { readonly count: number; readonly first: number; readonly oldestOfTail: number } {
  const capture = Math.max(input.fireFor, input.now - input.maxAgeMs + 1)
  let current = nextOccurrence({ schedule: input.schedule, timezone: input.timezone, after: capture - 1 })
  if (current === undefined || current > input.now) {
    return { count: 0, first: input.now, oldestOfTail: input.now }
  }
  const first = current
  const ring: number[] = []
  let count = 0
  while (current !== undefined && current <= input.now && count < COLLAPSE_ITERATION_CAP) {
    ring.push(current)
    if (ring.length > input.cap) ring.shift()
    count++
    current = nextOccurrence({ schedule: input.schedule, timezone: input.timezone, after: current })
  }
  return { count, first, oldestOfTail: ring[0] ?? first }
}

/** Effective wake instant for a task cursor (logical instant + deterministic jitter). */
export function effectiveDue(nextRunAt: number, jitter: (fireFor: number) => number): number {
  return nextRunAt + jitter(nextRunAt)
}
