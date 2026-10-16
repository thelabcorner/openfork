import type { ResetAgendaResult } from "@/quota/schema"
import { isRollingQuotaWindow, quotaSubscriptionKey, type TelegramQuotaSubscription } from "@/quota/telegram-reset-policy"

/**
 * A rolling quota has no unique reset edge: the provider's resetAt estimate
 * may advance on every read even while utilization stays exactly the same.
 *
 * Report only an observed >=1 percentage-point increase in available capacity,
 * including 98 -> 99 and 99 -> 100. A one-hour per-account cooldown suppresses
 * bursts; unchanged capacity, including a permanently full 100%, is silent.
 */
const MIN_INCREASE_PP = 1
const COOLDOWN_MS = 60 * 60_000
const MAX_OBSERVATION_GAP_MS = 20 * 60_000
const FLOAT_EPSILON = 1e-7

export type RollingObservation = {
  readonly subscriptionKey: string
  readonly providerName: string
  readonly accountLabel?: string
  readonly model?: string
  readonly windowKey: string
  readonly observedAt: number
  readonly remainingPercent: number
}

export type RollingCapacityState = {
  readonly subscriptionKey: string
  readonly observedAt: number
  /** Missing in pre-change state; the first subsequent reading only seeds a baseline. */
  readonly remainingPercent?: number
  /** Lowest sampled remaining percentage since the last qualifying increase. */
  readonly lowWaterPercent?: number
  readonly lastAlertAt?: number
  readonly pending?: { readonly id: string; readonly text: string }
}

export function validRollingCapacity(value: unknown): value is RollingCapacityState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (typeof row.subscriptionKey !== "string" || row.subscriptionKey.length > 2048) return false
  if (typeof row.observedAt !== "number" || !Number.isFinite(row.observedAt)) return false
  if (row.remainingPercent !== undefined && !validPercent(row.remainingPercent)) return false
  if (row.lowWaterPercent !== undefined && !validPercent(row.lowWaterPercent)) return false
  if (row.lastAlertAt !== undefined && (typeof row.lastAlertAt !== "number" || !Number.isFinite(row.lastAlertAt))) return false
  if (row.pending !== undefined) {
    if (!row.pending || typeof row.pending !== "object" || Array.isArray(row.pending)) return false
    const pending = row.pending as Record<string, unknown>
    if (typeof pending.id !== "string" || pending.id.length > 3000 ||
        typeof pending.text !== "string" || pending.text.length > 4096) return false
  }
  return true
}

function validPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
}

/**
 * The prior exhaustion-only implementation persisted notifications with this
 * identity. Do not leak a queued pre-migration alert under the new policy.
 */
export function migrateRollingCapacity(row: RollingCapacityState): RollingCapacityState {
  if (row.pending?.id.includes('"rolling-capacity-restored"')) {
    return { ...row, pending: undefined }
  }
  return row
}

/** Only a fresh authoritative read of an exact selected provider/account/window. */
export function rollingObservations(input: {
  readonly agenda: ResetAgendaResult
  readonly subscriptions: readonly TelegramQuotaSubscription[]
  readonly now: number
}): RollingObservation[] {
  const selected = new Set(input.subscriptions.filter((sub) => sub.enabled).map(quotaSubscriptionKey))
  const output = new Map<string, RollingObservation>()
  for (const occurrence of input.agenda.occurrences) {
    if (!Number.isFinite(occurrence.observedAt) || occurrence.observedAt > input.now + 60_000) continue
    if ((occurrence.scope === "account" || occurrence.scope === "account-model") && !occurrence.accountId) continue
    for (const window of occurrence.windows) {
      if (!isRollingQuotaWindow({ providerId: occurrence.providerId, windowKey: window.key })) continue
      if (window.source !== "provider" || !validPercent(window.remainingPercent)) continue
      const subscriptionKey = quotaSubscriptionKey({
        providerId: occurrence.providerId,
        scope: occurrence.scope,
        ...(occurrence.accountId ? { accountId: occurrence.accountId } : {}),
        ...(occurrence.model ? { model: occurrence.model } : {}),
        windowKey: window.key,
      })
      if (!selected.has(subscriptionKey)) continue
      const row: RollingObservation = {
        subscriptionKey,
        providerName: occurrence.providerName,
        accountLabel: occurrence.accountLabel,
        model: occurrence.model,
        windowKey: window.key,
        observedAt: occurrence.observedAt,
        remainingPercent: window.remainingPercent,
      }
      if (!output.has(subscriptionKey) || output.get(subscriptionKey)!.observedAt < row.observedAt) {
        output.set(subscriptionKey, row)
      }
    }
  }
  return [...output.values()]
}

function safeLabel(value: string | undefined) {
  return (value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)
}

function formatPercent(n: number) {
  return (Math.round(n * 10) / 10).toString()
}

/**
 * Persisted state machine. Never compares resetAt timestamps or assumes an
 * exhausted quota. Small cumulative gains count, but a cached reading cannot
 * count twice, and an unchanged 100% is never an event.
 */
export function observeRollingCapacity(
  previous: RollingCapacityState | undefined,
  observation: RollingObservation,
): RollingCapacityState {
  if (previous && observation.observedAt <= previous.observedAt) return previous

  const available = observation.remainingPercent
  const before = previous?.remainingPercent
  // Explicit first-sample baseline, including migrating legacy "armed" rows.
  if (before === undefined || (previous && observation.observedAt - previous.observedAt > MAX_OBSERVATION_GAP_MS)) return {
    subscriptionKey: observation.subscriptionKey,
    observedAt: observation.observedAt,
    remainingPercent: available,
    lowWaterPercent: available,
    ...(previous?.lastAlertAt !== undefined ? { lastAlertAt: previous.lastAlertAt } : {}),
    ...(previous?.pending ? { pending: previous.pending } : {}),
  }

  let floor = Math.min(previous?.lowWaterPercent ?? before, available)
  let pending = previous?.pending
  let lastAlertAt = previous?.lastAlertAt

  // Only an ACTUAL positive transition can generate a message. The low-water
  // mark permits 98.0 -> 98.5 -> 99.0 to meet a one-point threshold.
  const increasing = available > before + FLOAT_EPSILON
  const material = available - floor >= MIN_INCREASE_PP - FLOAT_EPSILON
  if (increasing && material) {
    if (!pending && (lastAlertAt === undefined || observation.observedAt - lastAlertAt >= COOLDOWN_MS)) {
      const target = [observation.providerName, observation.accountLabel, observation.model]
        .map(safeLabel).filter(Boolean).join(" · ")
      const id = JSON.stringify(["rolling-capacity-increased", observation.subscriptionKey, observation.observedAt])
      pending = {
        id,
        text: `OpenFork · rolling quota capacity increased\n${target}\nWindow: ${safeLabel(observation.windowKey)} (rolling)\nAvailable: ${formatPercent(floor)}% → ${formatPercent(available)}% (+${formatPercent(available - floor)} pp)`,
      }
      lastAlertAt = observation.observedAt
    }
    // Consume suppressed movement as well. Otherwise cooling down while
    // 99 -> 100 could spuriously notify an hour later at an unchanged 100.
    floor = available
  }

  return {
    subscriptionKey: observation.subscriptionKey,
    observedAt: observation.observedAt,
    remainingPercent: available,
    lowWaterPercent: floor,
    ...(lastAlertAt !== undefined ? { lastAlertAt } : {}),
    ...(pending ? { pending } : {}),
  }
}
