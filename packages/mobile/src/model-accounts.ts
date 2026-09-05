/**
 * Per-account usage for the model selector's account picker.
 *
 * This is the mobile counterpart of the desktop's `usageForAccountFor`, cut
 * down to what the quota endpoint actually exposes on a phone: the desktop
 * also consults `use-workbuddy-usage` / `use-verdent-usage` / fork usage hooks
 * that need app-only plumbing. Quota's per-account arrays are live (read from
 * the vault on every poll) and are already loaded in `app.tsx` for the limits
 * page, so they are the one source available here.
 *
 * Every resolver returns `undefined` when it has nothing honest to say, and
 * the UI omits the usage column entirely in that case rather than rendering a
 * misleading zero.
 */

import type { LimitsProviderData } from "./views/LimitsView"

export type AccountUsage = {
  /** Remaining requests if the quota backend counts them; Infinity if unlimited. */
  estimatedRequests: number
  /** True when the figures describe the whole account, not the chosen model. */
  accountWide?: boolean
  /** 0-100 when the backend reports a budget fraction. */
  remainingPercent?: number
  /** Human label for the account, for the usage tooltip. */
  account?: string
  creditsExhausted?: boolean
}

export type AccountRoster = { accountId: string; label: string }

function usageOf(provider: LimitsProviderData): Record<string, unknown> | undefined {
  const usage = (provider.result as { usage?: unknown } | undefined)?.usage
  if (!usage || typeof usage !== "object") return undefined
  return usage as Record<string, unknown>
}

function arrayField(usage: Record<string, unknown> | undefined, field: string): Record<string, unknown>[] {
  const value = usage?.[field]
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

/**
 * Account labels, keyed by account id. Taken from quota rather than the model
 * catalog because the catalog is cached in `Provider.list()` and still carries
 * a stale numeric label until that cache is invalidated after a vault edit.
 */
export function collectAccountLabels(providers: readonly LimitsProviderData[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const provider of providers) {
    const usage = usageOf(provider)
    for (const field of ["verdentAccounts", "workbuddyAccounts"] as const) {
      for (const entry of arrayField(usage, field)) {
        const id = entry.accountId
        const label = entry.label
        if (typeof id === "string" && typeof label === "string" && label) map.set(id, label)
      }
    }
    for (const entry of arrayField(usage, "zenAccounts")) {
      const id = entry.keyId
      const label = entry.label
      if (typeof id === "string" && typeof label === "string" && label) map.set(id, label)
    }
  }
  return map
}

/** Zen / opencode-go key limits, keyed by key id. */
function zenKeyLimits(providers: readonly LimitsProviderData[]) {
  const map = new Map<
    string,
    {
      label: string
      exhausted: boolean
      usedObserved: number | null
      limitEstimate: number | null
      remainingPercent: number | null
    }
  >()
  for (const provider of providers) {
    for (const entry of arrayField(usageOf(provider), "zenAccounts")) {
      const id = entry.keyId
      if (typeof id !== "string") continue
      map.set(id, {
        label: typeof entry.label === "string" ? entry.label : id,
        exhausted: entry.exhausted === true,
        usedObserved: typeof entry.usedObserved === "number" ? entry.usedObserved : null,
        limitEstimate: typeof entry.limitEstimate === "number" ? entry.limitEstimate : null,
        remainingPercent: typeof entry.remainingPercent === "number" ? entry.remainingPercent : null,
      })
    }
  }
  return map
}

function rosterFrom(providers: readonly LimitsProviderData[], field: string): AccountRoster[] {
  const out: AccountRoster[] = []
  for (const provider of providers) {
    for (const entry of arrayField(usageOf(provider), field)) {
      const id = entry.accountId
      if (typeof id !== "string") continue
      const label = typeof entry.label === "string" ? entry.label : id
      if (!out.some((existing) => existing.accountId === id)) out.push({ accountId: id, label })
    }
  }
  return out
}

/**
 * Synthesizes an account roster straight from quota. The catalog only lists
 * account-qualified variants for accounts it has already enrolled, so a
 * freshly added key would otherwise leave the picker with a single "Auto" row
 * and no way to route to the new account.
 */
export function synthesizeAccounts(
  providerID: string,
  providers: readonly LimitsProviderData[],
): AccountRoster[] {
  if (providerID === "opencode" || providerID === "opencode-go") {
    return [...zenKeyLimits(providers).entries()].map(([accountId, info]) => ({ accountId, label: info.label }))
  }
  if (providerID === "verdent") return rosterFrom(providers, "verdentAccounts")
  if (providerID === "workbuddy") return rosterFrom(providers, "workbuddyAccounts")
  return []
}

/**
 * Matches a quota row to the model being picked. WorkBuddy and Verdent report
 * limits under their own naming, so the row's `canonical` id is tried first and
 * the raw `model` string second, both compared loosely: the picker holds a
 * catalog id like `vendor/model` while quota may report `model`.
 */
function matchesModel(row: Record<string, unknown>, baseModelID: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/^.*\//, "").replace(/[^a-z0-9]/g, "")
  const wanted = normalize(baseModelID)
  if (!wanted) return false
  for (const field of ["canonical", "model"] as const) {
    const value = row[field]
    if (typeof value !== "string" || !value) continue
    const candidate = normalize(value)
    if (candidate && (candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate))) return true
  }
  return false
}

/**
 * Per-account usage lookup for one model. Providers whose quota reports no
 * per-account breakdown return `undefined` for every account, which the UI
 * renders as no usage column rather than a fabricated number.
 *
 * `baseModelID` narrows credit-based providers (WorkBuddy, Verdent) to the row
 * for the model actually being picked. Their quotas are per model, so the
 * account-wide minimum would understate the headroom of a cheap model sitting
 * behind an exhausted expensive one. When no row matches, the account-wide
 * figure is returned with `accountWide` set so the UI can say so.
 */
export function usageForAccount(
  providerID: string,
  providers: readonly LimitsProviderData[],
  labels: Map<string, string>,
  baseModelID?: string,
): (accountID: string) => AccountUsage | undefined {
  if (providerID === "opencode" || providerID === "opencode-go") {
    const keys = zenKeyLimits(providers)
    return (accountID) => {
      const key = keys.get(accountID)
      if (!key) return undefined
      const estimatedRequests =
        key.limitEstimate !== null && key.usedObserved !== null
          ? key.limitEstimate - key.usedObserved
          : Number.POSITIVE_INFINITY
      const usage: AccountUsage = { estimatedRequests, account: key.label, creditsExhausted: key.exhausted }
      if (key.remainingPercent !== null) usage.remainingPercent = key.remainingPercent
      return usage
    }
  }

  // WorkBuddy and Verdent report per-model limits inside each account entry;
  // sum the windows for the requested model into one remaining figure.
  const field = providerID === "verdent" ? "verdentAccounts" : providerID === "workbuddy" ? "workbuddyAccounts" : undefined
  if (!field) return () => undefined

  const entries = rosterFrom(providers, field)
  const byAccount = new Map<string, Record<string, unknown>[]>()
  for (const provider of providers) {
    for (const entry of arrayField(usageOf(provider), field)) {
      if (typeof entry.accountId !== "string") continue
      const list = byAccount.get(entry.accountId) ?? []
      list.push(entry)
      byAccount.set(entry.accountId, list)
    }
  }

  return (accountID) => {
    const found = byAccount.get(accountID)
    if (!found) return undefined

    const rows: Record<string, unknown>[] = []
    for (const entry of found) {
      const models = entry.models
      if (Array.isArray(models)) rows.push(...(models as Record<string, unknown>[]))
    }
    const matched = baseModelID ? rows.filter((row) => matchesModel(row, baseModelID)) : []
    // Fall back to the whole account only when this model has no row of its
    // own, and label the result so the UI does not present it as model-specific.
    const accountWide = matched.length === 0
    const considered = accountWide ? rows : matched

    let remainingPercent: number | undefined
    let remainingEstimate: number | undefined
    let exhausted = false
    for (const row of considered) {
      const pct = row.remainingPercent
      if (typeof pct === "number" && Number.isFinite(pct)) {
        remainingPercent = remainingPercent === undefined ? pct : Math.min(remainingPercent, pct)
      }
      const remaining = row.remainingEstimate
      if (typeof remaining === "number" && Number.isFinite(remaining)) {
        remainingEstimate = remainingEstimate === undefined ? remaining : Math.min(remainingEstimate, remaining)
      }
      if (row.exhausted === true || row.status === "depleted") exhausted = true
    }
    if (considered.length === 0) return undefined

    const usage: AccountUsage = {
      // These providers budget in credits. Use the backend's own remaining
      // count when it publishes one; otherwise the bar is the honest signal and
      // there is no defensible request estimate to invent.
      estimatedRequests: remainingEstimate ?? Number.POSITIVE_INFINITY,
      account: labels.get(accountID) ?? entries.find((e) => e.accountId === accountID)?.label ?? accountID,
      creditsExhausted: exhausted,
    }
    if (accountWide) usage.accountWide = true
    if (remainingPercent !== undefined) usage.remainingPercent = remainingPercent
    return usage
  }
}
