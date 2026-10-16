/**
 * Read-only advisory projection for explicit native quota enrichment.
 * Raw window labels (potentially email/account-identifying) and account keys
 * never leave this module; no routing decisions are derived here.
 */
import type { ProviderResult } from "@/quota/schema"

type AdvisoryState = "exhausted-window" | "remaining" | "unknown"
type ModelHint = {
  advisory: true
  state: AdvisoryState
  remainingPercent: number | null
  observedAt: number
  source: "model-windows" | "account-model-observations"
  knownAccounts?: number
  exhaustedObservedAccounts?: number
  resetAt?: number | null
}
const percent = (used: number | null, remaining: number | null) =>
  remaining !== null && Number.isFinite(remaining) ? Math.max(0, Math.min(100, remaining)) :
    used !== null && Number.isFinite(used) ? Math.max(0, Math.min(100, 100 - used)) : null

export function projectQuota(snapshot: ProviderResult, selectedIDs: ReadonlySet<string>) {
  const observedAt = snapshot.fetchedAt
  const models: Record<string, ModelHint> = Object.create(null)
  const windows = Object.entries(snapshot.usage?.windows ?? {}).slice(0, 12).map(([key, value], i) => ({
    // A provider-supplied window label can contain account IDs, email
    // addresses or private usage labels; only allow a narrow public vocabulary.
    name: /^(5h|hourly|daily|weekly|monthly|week|month|7d|30d)$/i.test(key) ? key : `window-${i + 1}`,
    remainingPercent: percent(value.usedPercent, value.remainingPercent),
    resetAt: value.resetAt,
  }))
  if (snapshot.ok) {
    for (const id of selectedIDs) {
      const entry = snapshot.usage?.models?.[id]
      if (!entry) continue
      const periods = Object.values(entry.windows)
      const remaining = periods.map((w) => percent(w.usedPercent, w.remainingPercent))
        .filter((p): p is number => p !== null)
      const nextReset = periods.map((w) => w.resetAt).filter((r): r is number => r !== null)
      const mostConstrained = remaining.length ? Math.min(...remaining) : null
      models[id] = {
        advisory: true, observedAt, source: "model-windows",
        state: mostConstrained === null ? "unknown" : mostConstrained <= 0 ? "exhausted-window" : "remaining",
        remainingPercent: mostConstrained,
        resetAt: nextReset.length ? Math.min(...nextReset) : null,
      }
    }
    const accounts = snapshot.usage?.workbuddyAccounts ?? []
    for (const id of selectedIDs) {
      if (models[id]?.state !== undefined && models[id]?.state !== "unknown") continue
      const observations = accounts.flatMap((account) =>
        account.models.filter((model) => model.canonical === id || model.model === id))
      if (!observations.length) continue
      const exhaustedObservedAccounts = observations.filter((o) => o.exhaustedObserved).length
      const remaining = observations.map((o) => o.remainingPercent).filter((p): p is number => p !== null)
      const resets = observations.map((o) => o.resetAt).filter((t): t is number => t !== null)
      models[id] = {
        advisory: true, observedAt, source: "account-model-observations",
        knownAccounts: observations.length,
        exhaustedObservedAccounts,
        state: exhaustedObservedAccounts === observations.length ? "exhausted-window" :
          remaining.some((p) => p > 0) ? "remaining" : "unknown",
        // Most viable *observed* account; no claim that this is the selected routing account.
        remainingPercent: remaining.length ? Math.max(...remaining) : null,
        resetAt: resets.length ? Math.min(...resets) : null,
      }
    }
  }
  const zen = snapshot.usage?.zenAccounts
  return {
    source: "provider-account-advisory-not-route-authority" as const,
    ok: snapshot.ok,
    observedAt,
    ...(snapshot.nextRefreshAt === undefined ? {} : { nextRefreshAt: snapshot.nextRefreshAt }),
    state: snapshot.ok ? "observed" : "unavailable",
    // Provider-level windows can exhaust a *shared* entitlement even without
    // a model-specific rate. Never relabel these as per-model hard exclusions.
    windows,
    totalWindows: Object.keys(snapshot.usage?.windows ?? {}).length,
    ...(zen?.length ? {
      knownKeys: zen.length,
      exhaustedKnownKeys: zen.filter((key) => key.exhausted).length,
    } : {}),
    models,
  }
}
export * as ModelsQuota from "./quota"
