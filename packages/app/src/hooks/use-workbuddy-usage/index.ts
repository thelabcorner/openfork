import { createMemo } from "solid-js"
import type { Accessor } from "solid-js"
import { useLimits } from "@/hooks/use-limits"
import { parseWorkBuddyKey, workBuddyCredits, type ProviderResult } from "@/utils/limits-format"

/**
 * WorkBuddy stretch estimates for the model picker.
 *
 * WorkBuddy bills in *credits per request* rather than dollars per token, and
 * it is genuinely multi-account: each enrolled account owns an independent
 * credit balance. That makes the existing OpenCode-Go stretch path
 * (`estimateRequestsRemaining` off a USD 5h window) unusable here — there is no
 * USD window to divide. Instead:
 *
 *   estimatedRequests = accountRemainingCredits / modelConsumptionRate
 *
 * The rate comes from the same live catalog the model list was built from, so
 * the bar and the list can never disagree about which models exist or what they
 * cost.
 *
 * Design constraints, inherited from the OpenRouter/OpenCode-Go implementations:
 * - Best-effort. A missing rate or an unparseable point label yields
 *   `undefined`, which the picker renders as *no bar*, never as a full/empty one.
 * - Only `Basic` gates. Gift/Extra are bonus packs and must not make a model
 *   look affordable when the main balance is drained.
 */

export type WorkBuddyModelUsage = {
  /** Remaining requests this account can fund for this model. */
  estimatedRequests: number
  /** Fraction of the account's Basic balance still available (0-100). */
  remainingPercent: number
  /** Credits left on the funding account. */
  remainingCredits: number
  /** Credits per request for this model. */
  rate: number
  /** The funding account's display label, for tooltips. */
  account: string
  /** True when this row's account is the best-funded one. */
  isBestAccount: boolean
  /** True when the model is currently free (rate 0 / active promotion). */
  free: boolean
  /** The provider's promotion badge, e.g. "Free now". */
  promotion?: string
  /** The model id this estimate was resolved from, after alias stripping. */
  modelID: string
}

export type WorkBuddyAccountUsage = {
  /** Stable account key, as it appears in an account-qualified model id. */
  id: string
  /** Display label, as it appears in quota window keys. */
  account: string
  remainingCredits: number
  totalCredits: number
  remainingPercent: number
  resetAt: number | null
}

export type WorkBuddyUsageState = {
  /** Per-account balances, richest first. */
  accounts: Accessor<WorkBuddyAccountUsage[]>
  /**
   * Stretch estimate for one model row. `modelID` may be account-qualified
   * (`hy4-preview@wb-<id>`); when it is, the bar is funded by THAT account
   * specifically rather than by the best account overall.
   */
  forModel: (modelID: string) => WorkBuddyModelUsage | undefined
  /** Per-model rate lookup, independent of any account balance. */
  rateFor: (modelID: string) => { rate: number; free: boolean; label: string; promotion?: string } | undefined
  /** The provider result, when WorkBuddy is configured. */
  result: Accessor<ProviderResult | undefined>
}

/**
 * Split a picker model id into its catalog id and optional account qualifier.
 *
 * The provider exposes both `hy4-preview` (auto-assigned) and
 * `hy4-preview@wb-<stable-id>` (pinned to one account). The rate map is keyed by
 * the catalog id, so the suffix must be stripped before lookup — but it must be
 * KEPT, because it identifies which account funds this row.
 */
export function splitWorkBuddyModelID(modelID: string): { id: string; accountID?: string } {
  const separator = modelID.lastIndexOf("@wb-")
  if (separator <= 0) return { id: modelID }
  return { id: modelID.slice(0, separator), accountID: modelID.slice(separator + 1) }
}

export function useWorkBuddyUsage(options?: { now?: Accessor<number> }): WorkBuddyUsageState {
  const limits = useLimits(options)

  const result = createMemo<ProviderResult | undefined>(() => {
    const list = limits.providers()
    if (!list) return undefined
    return list.find((provider) => provider.result.providerId === "workbuddy")?.result
  })

  const accounts = createMemo<WorkBuddyAccountUsage[]>(() => {
    const usage = result()?.usage
    if (!usage) return []
    // Stable id -> display label. Without this map an account-qualified model
    // id cannot be matched to its quota window, because the id is derived from
    // the Tencent UID while the window key uses the nickname.
    const labels = usage.accountLabels ?? {}
    const labelToId = new Map<string, string>()
    for (const [id, label] of Object.entries(labels)) labelToId.set(label, id)

    const byId = new Map<string, WorkBuddyAccountUsage>()
    for (const [key, window] of Object.entries(usage.windows)) {
      const parsed = parseWorkBuddyKey(key)
      // Only Basic meters the account's real balance; Gift/Extra are bonus.
      if (parsed?.scope !== "account" || parsed.kind !== "Basic") continue
      const credits = workBuddyCredits(window)
      if (!credits) continue
      const remainingPercent =
        window.remainingPercent ?? (credits.total > 0 ? (credits.remaining / credits.total) * 100 : 0)
      byId.set(labelToId.get(parsed.account) ?? parsed.account, {
        id: labelToId.get(parsed.account) ?? parsed.account,
        account: parsed.account,
        remainingCredits: credits.remaining,
        totalCredits: credits.total,
        remainingPercent: Math.max(0, Math.min(100, remainingPercent)),
        resetAt: window.resetAt,
      })
    }
    // Richest first: the account the picker should suggest by default.
    return [...byId.values()].sort((a, b) => b.remainingCredits - a.remainingCredits)
  })

  const rateFor = (modelID: string) => {
    const { id } = splitWorkBuddyModelID(modelID)
    const entry = result()?.usage?.models?.[id]
    if (!entry) return undefined
    // `rate` is per-request credits. 0 means unpublished unless rateFree says
    // the catalog is advertising it as genuinely free right now.
    const rate = entry.rate ?? 0
    const free = entry.rateFree === true || (rate <= 0 && !!entry.promotionLabel)
    return {
      rate,
      free,
      label: entry.rateLabel ?? "",
      ...(entry.promotionLabel ? { promotion: entry.promotionLabel } : {}),
    }
  }

  const forModel = (modelID: string): WorkBuddyModelUsage | undefined => {
    const rate = rateFor(modelID)
    if (!rate) return undefined
    const list = accounts()
    if (list.length === 0) return undefined

    const { id, accountID } = splitWorkBuddyModelID(modelID)
    // A pinned row is funded by ITS account, so its bar reflects that account's
    // own headroom. An unpinned row falls back to the best-funded account.
    const funder = (accountID ? list.find((entry) => entry.id === accountID) : undefined) ?? list[0]
    if (!funder) return undefined
    // Unknown account id: better no bar than one funded by the wrong account.
    if (accountID && funder.id !== accountID) return undefined

    const best = list[0]!
    const base = {
      remainingPercent: funder.remainingPercent,
      remainingCredits: funder.remainingCredits,
      account: funder.account,
      isBestAccount: funder.id === best.id,
      modelID: id,
      ...(rate.promotion ? { promotion: rate.promotion } : {}),
    }

    // A currently-free model is unbounded regardless of balance, but the bar
    // still reflects the account's headroom so the row reads consistently.
    if (rate.free) return { ...base, estimatedRequests: Number.POSITIVE_INFINITY, rate: 0, free: true }
    if (rate.rate <= 0) return undefined

    return {
      ...base,
      estimatedRequests: Math.max(0, Math.floor(funder.remainingCredits / rate.rate)),
      rate: rate.rate,
      free: false,
    }
  }

  return { accounts, forModel, rateFor, result }
}
