/** Presentation-only projection of authoritative quota reset windows for Telegram Settings. */
export type TelegramSubscription = {
  providerId: string
  scope: "provider" | "account" | "model" | "account-model"
  accountId?: string
  model?: string
  windowKey: string
  enabled: boolean
}

export type QuotaResetOption = TelegramSubscription & {
  id: string
  providerName: string
  accountLabel?: string
  resetAt: number
  observedAt: number
  source: "provider" | "observed" | "inferred" | "local"
}

export type QuotaAgendaView = {
  occurrences: readonly {
    providerId: string
    providerName: string
    scope: TelegramSubscription["scope"]
    accountId?: string
    accountLabel?: string
    model?: string
    resetAt: number
    observedAt: number
    windows: readonly { key: string; source: QuotaResetOption["source"] }[]
  }[]
}

/** The OpenCode Go 5h quota is rolling, not a fixed-time reset. */
export function isRollingQuotaOption(row: Pick<TelegramSubscription, "providerId" | "windowKey">) {
  return row.providerId === "opencode-go" && row.windowKey === "5h"
}

export function subscriptionKey(row: Omit<TelegramSubscription, "enabled">) {
  return JSON.stringify([row.providerId, row.scope, row.accountId ?? "", row.model ?? "", row.windowKey])
}

export function resetOptions(agenda: QuotaAgendaView | undefined, subscriptions: readonly TelegramSubscription[], now = Date.now()) {
  const selected = new Map(subscriptions.map((s) => [subscriptionKey(s), s.enabled]))
  const seen = new Set<string>()
  const result: QuotaResetOption[] = []
  for (const occurrence of agenda?.occurrences ?? []) {
    if (!occurrence.providerId || !Number.isFinite(occurrence.resetAt)) continue
    // Never aggregate account-bound alerts without a stable account identity.
    if ((occurrence.scope === "account" || occurrence.scope === "account-model") && !occurrence.accountId) continue
    for (const window of occurrence.windows) {
      if (!window.key || (occurrence.resetAt <= now && !isRollingQuotaOption({ providerId: occurrence.providerId, windowKey: window.key }))) continue
      const identity = {
        providerId: occurrence.providerId,
        scope: occurrence.scope,
        ...(occurrence.accountId ? { accountId: occurrence.accountId } : {}),
        ...(occurrence.model ? { model: occurrence.model } : {}),
        windowKey: window.key,
      }
      const id = subscriptionKey(identity)
      if (seen.has(id)) continue
      seen.add(id)
      result.push({
        ...identity,
        id,
        enabled: selected.get(id) ?? false,
        providerName: occurrence.providerName,
        ...(occurrence.accountLabel ? { accountLabel: occurrence.accountLabel } : {}),
        resetAt: occurrence.resetAt,
        observedAt: occurrence.observedAt,
        source: window.source,
      })
    }
  }
  return result.sort((a, b) => a.providerName.localeCompare(b.providerName) ||
    (a.accountLabel ?? "").localeCompare(b.accountLabel ?? "") ||
    (a.model ?? "").localeCompare(b.model ?? "") ||
    a.resetAt - b.resetAt)
}

export function withSubscription(
  existing: readonly TelegramSubscription[],
  option: Omit<TelegramSubscription, "enabled">,
  enabled: boolean,
): TelegramSubscription[] {
  const key = subscriptionKey(option)
  const next = existing.filter((item) => subscriptionKey(item) !== key)
  next.push({ ...option, enabled })
  return next
}
