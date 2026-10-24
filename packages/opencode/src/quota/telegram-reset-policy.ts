import type { ResetAgendaResult, ResetOccurrence, ResetSource } from "./schema"

/**
 * Pure, allocation-bounded matching/verification for outbound quota alerts.
 * This module does not fetch quota, perform I/O, schedule timers or send Telegram messages.
 * An authorized process-global owner must persist subscriptions and delivery receipts.
 */
export type TelegramQuotaSubscription = {
  readonly providerId: string
  readonly scope: ResetOccurrence["scope"]
  readonly accountId?: string
  readonly model?: string
  readonly windowKey: string
  readonly enabled: boolean
}

export type TelegramQuotaDeadline = {
  readonly id: string
  readonly subscriptionKey: string
  readonly providerId: string
  readonly providerName: string
  readonly scope: ResetOccurrence["scope"]
  readonly accountId?: string
  readonly accountLabel?: string
  readonly model?: string
  readonly windowKey: string
  readonly resetAt: number
  readonly observedAt: number
  readonly source: ResetSource
  readonly remainingPercent: number | null
}

export type TelegramQuotaVerification =
  | { readonly state: "confirmed"; readonly observedAt: number; readonly nextResetAt: number }
  | { readonly state: "pending"; readonly reason: "not-due" | "no-fresh-observation" | "reset-not-advanced" | "no-measured-recovery" }
  | { readonly state: "unverifiable"; readonly reason: "not-provider-authoritative" | "missing-identity" | "rolling-window" }

export type TelegramQuotaEarlyRecovery = {
  readonly id: string
  readonly kind: "reset" | "replenishment"
  readonly observedAt: number
  readonly expectedResetAt: number
  readonly nextResetAt: number
  readonly previousRemainingPercent: number
  readonly remainingPercent: number
}

const MIN_EARLY_LEAD_MS = 2 * 60_000
const MIN_NEW_PERIOD_ADVANCE_MS = 5 * 60_000
const MIN_RECOVERY_PP = 1
// Without a new provider-reported period, a small increase could be an
// adjustment/refund rather than a gift. Report large increases as replenishment,
// never as confirmed resets.
const MIN_UNSCHEDULED_REPLENISHMENT_PP = 20

/**
 * Detect a measured recovery BEFORE a previously captured provider deadline.
 * Compare against the prior durable baseline, not a new deadline obtained in
 * the current poll (which would erase the evidence of an early transition).
 * Timestamp movement by itself, inferred estimates, and rolling windows are
 * never evidence of an early reset.
 */
export function detectEarlyQuotaRecovery(
  previous: TelegramQuotaDeadline,
  fresh: ResetAgendaResult,
  now: number,
): TelegramQuotaEarlyRecovery | undefined {
  if (isRollingQuotaWindow(previous) || previous.source !== "provider") return
  if (!Number.isFinite(now) || now >= previous.resetAt - MIN_EARLY_LEAD_MS) return
  if (previous.observedAt >= previous.resetAt || !validRemaining(previous.remainingPercent)) return
  if ((previous.scope === "account" || previous.scope === "account-model") && !previous.accountId) return

  let best: TelegramQuotaEarlyRecovery | undefined
  for (const occurrence of fresh.occurrences) {
    if (occurrence.providerId !== previous.providerId || occurrence.scope !== previous.scope) continue
    if ((occurrence.accountId ?? "") !== (previous.accountId ?? "")) continue
    if ((occurrence.model ?? "") !== (previous.model ?? "")) continue
    if (!Number.isFinite(occurrence.observedAt) || occurrence.observedAt <= previous.observedAt ||
        occurrence.observedAt > now || occurrence.observedAt >= previous.resetAt - MIN_EARLY_LEAD_MS) continue
    const window = occurrence.windows.find((row) => row.key === previous.windowKey && row.source === "provider")
    if (!window || !validRemaining(window.remainingPercent)) continue
    const gain = window.remainingPercent - previous.remainingPercent
    if (gain < MIN_RECOVERY_PP - 1e-7) continue
    const newPeriod = occurrence.resetAt >= previous.resetAt + MIN_NEW_PERIOD_ADVANCE_MS
    if (!newPeriod && gain < MIN_UNSCHEDULED_REPLENISHMENT_PP - 1e-7) continue

    const candidate: TelegramQuotaEarlyRecovery = {
      id: JSON.stringify(["early-quota-recovery", previous.subscriptionKey, previous.resetAt]),
      kind: newPeriod ? "reset" : "replenishment",
      observedAt: occurrence.observedAt,
      expectedResetAt: previous.resetAt,
      nextResetAt: occurrence.resetAt,
      previousRemainingPercent: previous.remainingPercent,
      remainingPercent: window.remainingPercent,
    }
    // Multiple agenda occurrences may represent the same selected window.
    // Prefer evidence of a new period, then the freshest observation.
    if (!best ||
        (candidate.kind === "reset" && best.kind !== "reset") ||
        (candidate.kind === best.kind && candidate.observedAt > best.observedAt)) best = candidate
  }
  return best
}

function validRemaining(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100
}

/**
 * These providers expose quota recovery through moving reset estimates, not
 * stable period boundaries. In particular, Claude's 5h and weekly resetAt
 * values have been observed drifting at millisecond resolution per poll.
 * Only observed changes in available capacity can trigger these notices.
 */
export function isRollingQuotaWindow(input: { readonly providerId: string; readonly windowKey: string }): boolean {
  return (input.providerId === "opencode-go" && input.windowKey === "5h") ||
    (input.providerId === "claude" &&
      (input.windowKey === "5h" || input.windowKey === "weekly" || input.windowKey.startsWith("weekly:")))
}

/** Stable across user-visible label changes, order changes and model/window regrouping. */
export function quotaSubscriptionKey(input: Omit<TelegramQuotaSubscription, "enabled">): string {
  return JSON.stringify([input.providerId, input.scope, input.accountId ?? "", input.model ?? "", input.windowKey])
}

/**
 * Converts the quota owner's grouped calendar occurrences into specific account+window
 * deadline records. A grouped occurrence may contain more than one window.
 *
 * The baseline MUST come from a read made before the deadline. Starting tracking
 * after the deadline does not generate a false positive backfill.
 */
export function quotaNotificationDeadlines(input: {
  readonly agenda: ResetAgendaResult
  readonly subscriptions: readonly TelegramQuotaSubscription[]
  readonly now: number
  readonly horizonMs?: number
}): TelegramQuotaDeadline[] {
  const horizon = input.horizonMs ?? 32 * 24 * 60 * 60 * 1000
  if (!Number.isFinite(input.now) || !Number.isFinite(horizon) || horizon <= 0) return []
  const selected = new Set(input.subscriptions.filter((row) => row.enabled).map(quotaSubscriptionKey))
  const rows: TelegramQuotaDeadline[] = []
  const ids = new Set<string>()

  for (const occurrence of input.agenda.occurrences) {
    if (!Number.isFinite(occurrence.resetAt) || !Number.isFinite(occurrence.observedAt)) continue
    if (occurrence.resetAt <= input.now || occurrence.resetAt > input.now + horizon) continue
    if (occurrence.observedAt >= occurrence.resetAt) continue
    if ((occurrence.scope === "account" || occurrence.scope === "account-model") && !occurrence.accountId) continue

    for (const window of occurrence.windows) {
      if (isRollingQuotaWindow({ providerId: occurrence.providerId, windowKey: window.key })) continue
      const identity = {
        providerId: occurrence.providerId,
        scope: occurrence.scope,
        ...(occurrence.accountId ? { accountId: occurrence.accountId } : {}),
        ...(occurrence.model ? { model: occurrence.model } : {}),
        windowKey: window.key,
      }
      const key = quotaSubscriptionKey(identity)
      if (!selected.has(key)) continue
      const id = JSON.stringify([key, occurrence.resetAt])
      if (ids.has(id)) continue
      ids.add(id)
      rows.push({
        id,
        subscriptionKey: key,
        providerId: occurrence.providerId,
        providerName: occurrence.providerName,
        scope: occurrence.scope,
        ...(occurrence.accountId ? { accountId: occurrence.accountId } : {}),
        ...(occurrence.accountLabel ? { accountLabel: occurrence.accountLabel } : {}),
        ...(occurrence.model ? { model: occurrence.model } : {}),
        windowKey: window.key,
        resetAt: occurrence.resetAt,
        observedAt: occurrence.observedAt,
        source: window.source,
        remainingPercent: window.remainingPercent,
      })
    }
  }

  return rows.sort((a, b) => a.resetAt - b.resetAt || a.id.localeCompare(b.id))
}

/**
 * Require a post-deadline provider observation for the exact account+model+window.
 * Never assert that locally predicted or inferred deadlines have replenished.
 *
 * This is deliberately stricter than a calendar reminder: a provider advancing a
 * previously observed deadline is stronger evidence of a new quota period than
 * simply reaching wall-clock midnight.
 */
export function verifyQuotaReset(
  previous: TelegramQuotaDeadline,
  fresh: ResetAgendaResult,
  now: number,
): TelegramQuotaVerification {
  if (isRollingQuotaWindow(previous)) return { state: "unverifiable", reason: "rolling-window" }
  if (previous.source !== "provider") {
    return { state: "unverifiable", reason: "not-provider-authoritative" }
  }
  if ((previous.scope === "account" || previous.scope === "account-model") && !previous.accountId) {
    return { state: "unverifiable", reason: "missing-identity" }
  }
  if (!Number.isFinite(now) || now < previous.resetAt) return { state: "pending", reason: "not-due" }

  let foundFresh = false
  for (const occurrence of fresh.occurrences) {
    if (occurrence.providerId !== previous.providerId || occurrence.scope !== previous.scope) continue
    if ((occurrence.accountId ?? "") !== (previous.accountId ?? "")) continue
    if ((occurrence.model ?? "") !== (previous.model ?? "")) continue
    if (!Number.isFinite(occurrence.observedAt) || occurrence.observedAt < previous.resetAt) continue
    const window = occurrence.windows.find((row) => row.key === previous.windowKey && row.source === "provider")
    if (!window) continue
    foundFresh = true
    if (occurrence.resetAt <= previous.resetAt + 1_000) continue
    // Provider reset estimates can shift without quota replenishing. A
    // timestamp advance is not an event: require positive capacity evidence
    // from the same authoritative provider/account/window snapshot.
    if (
      previous.remainingPercent === null ||
      window.remainingPercent === null ||
      !Number.isFinite(previous.remainingPercent) ||
      !Number.isFinite(window.remainingPercent) ||
      window.remainingPercent - previous.remainingPercent < 1 - 1e-7
    ) return { state: "pending", reason: "no-measured-recovery" }
    return { state: "confirmed", observedAt: occurrence.observedAt, nextResetAt: occurrence.resetAt }
  }

  return {
    state: "pending",
    reason: foundFresh ? "reset-not-advanced" : "no-fresh-observation",
  }
}

/**
 * Includes verified destination identity to prevent a newly re-paired chat from
 * inheriting the previous chat's delivery receipts.
 */
export function quotaDeliveryKey(deadline: TelegramQuotaDeadline, chatId: string) {
  return JSON.stringify([chatId, deadline.id])
}
