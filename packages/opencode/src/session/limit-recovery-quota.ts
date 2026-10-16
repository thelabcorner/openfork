import type { ResetAgendaResult, ResetOccurrence, ResetSource as QuotaResetSource } from "@/quota/schema"
import type { SessionLimitRecovery } from "@opencode-ai/schema/session-limit-recovery"

export type RecoveryQuotaCandidate = {
  readonly resetAt: number
  readonly resetObservedAt: number
  readonly resetSource: SessionLimitRecovery.ResetSource
}

const EXHAUSTED_EPSILON = 0.5

function exhausted(window: ResetOccurrence["windows"][number]) {
  if (window.remainingPercent !== null) return window.remainingPercent <= EXHAUSTED_EPSILON
  if (window.usedPercent !== null) return window.usedPercent >= 100 - EXHAUSTED_EPSILON
  return false
}

function scopeMatches(
  occurrence: ResetOccurrence,
  input: { readonly accountID?: string; readonly modelID: string },
) {
  if (occurrence.scope === "provider") return true
  if (occurrence.scope === "account") {
    return input.accountID !== undefined && occurrence.accountId === input.accountID
  }
  if (occurrence.scope === "model") return occurrence.model === input.modelID
  return (
    input.accountID !== undefined &&
    occurrence.accountId === input.accountID &&
    occurrence.model === input.modelID
  )
}

function conservativeSource(
  occurrence: ResetOccurrence,
  sources: readonly QuotaResetSource[],
  accountID: string | undefined,
  failureObservedAt: number | undefined,
): SessionLimitRecovery.ResetSource {
  // A provider-wide snapshot cannot prove which credential it represents when
  // the runtime failure is account-routed. Keep the timestamp for display, but
  // never grant unattended execution from that ambiguous identity.
  if (occurrence.scope === "provider" && accountID !== undefined) return "observed"
  if (sources.includes("inferred")) return "inferred"
  if (sources.includes("local")) return "local"
  if (sources.includes("observed")) return "observed"
  // A provider reset observed before the request that actually failed cannot
  // explain that failure authoritatively. Preserve it for presentation, but
  // never let a stale quota cache grant unattended execution authority.
  if (failureObservedAt !== undefined && occurrence.observedAt < failureObservedAt) return "observed"
  return "provider"
}

/**
 * Pick the conservative reset boundary for one confirmed runtime exhaustion.
 *
 * A reset is execution-authoritative only when the quota source itself is
 * provider-declared and its scope can be tied to the failed route. Multiple
 * exhausted windows choose the latest boundary because all blocking budgets
 * must have recovered before unattended work is safe to resume.
 */
export function selectRecoveryQuotaReset(
  agenda: ResetAgendaResult,
  input: {
    readonly accountID?: string
    readonly modelID: string
    /** Runtime observation time of the failure that proved this request was exhausted. */
    readonly failureObservedAt?: number
  },
): RecoveryQuotaCandidate | undefined {
  const matched = agenda.occurrences.filter((occurrence) => scopeMatches(occurrence, input))
  const candidates: RecoveryQuotaCandidate[] = []

  for (const occurrence of matched) {
    const blocking = occurrence.windows.filter(exhausted)
    if (blocking.length > 0) {
      candidates.push({
        resetAt: occurrence.resetAt,
        resetObservedAt: occurrence.observedAt,
        resetSource: conservativeSource(
          occurrence,
          blocking.map((window) => window.source),
          input.accountID,
          input.failureObservedAt,
        ),
      })
      continue
    }

    // A single provider reset with no utilization percentage is useful
    // observability, but not sufficient authority for unattended execution.
    if (matched.length === 1 && occurrence.windows.every((window) => window.usedPercent === null && window.remainingPercent === null)) {
      const sources = occurrence.windows.map((window) => window.source)
      const source = conservativeSource(occurrence, sources, input.accountID, input.failureObservedAt)
      candidates.push({
        resetAt: occurrence.resetAt,
        resetObservedAt: occurrence.observedAt,
        resetSource: source === "provider" ? "observed" : source,
      })
    }
  }

  return candidates.sort((a, b) => b.resetAt - a.resetAt)[0]
}
