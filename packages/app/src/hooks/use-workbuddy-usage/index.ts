import { createMemo } from "solid-js"
import type { Accessor } from "solid-js"
import { useLimits } from "@/hooks/use-limits"
import { parseWorkBuddyKey, workBuddyCredits, workBuddyAccountCreditsExhausted, type ProviderResult } from "@/utils/limits-format"
import { splitMultiAccountModelID } from "@/utils/model-account-identity"

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
  /** Whether this estimate is backed by the pooled Basic balance. */
  pool: boolean
  /** True when this row's account is the best-funded one. */
  isBestAccount: boolean
  /** True when the model is currently free (rate 0 / active promotion). */
  free: boolean
  /** True when `rate` was measured from real usage rather than the catalog. */
  personalized: boolean
  /** The provider's promotion badge, e.g. "Free now". */
  promotion?: string
  /** The model id this estimate was resolved from, after alias stripping. */
  modelID: string
  /**
   * True when the funding account's TOTAL package balance (Basic+Gift+Extra)
   * is fully drained. Tencent's backend runs its own balance check before
   * every generation regardless of a model's published rate, so a 0-credit
   * account gets rejected with `[14018] Credits exhausted` even on a
   * promotional 0.00x model whose own 24h window still has headroom. Only
   * meaningful when `free` is true — a paid model is already accounted for
   * by `remainingCredits`/`estimatedRequests`.
   */
  creditsExhausted: boolean
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
  /** Model-row display data, including all account-qualified variants. */
  modelVariants: (modelID: string) => WorkBuddyModelUsage[]
  /** The provider result, when WorkBuddy is configured. */
  result: Accessor<ProviderResult | undefined>
}

/**
 * Split a picker model id into its catalog id and optional account qualifier.
 *
 * The provider exposes context aliases before the optional account suffix, for
 * example `hy4-preview#ctx-262144@wb-<stable-id>`. The rate map is keyed by the
 * bare catalog id, so both decorations must be stripped before lookup — while
 * the account suffix is retained because it identifies the funding account.
 */
export function splitWorkBuddyModelID(modelID: string): { id: string; accountID?: string } {
  const split = splitMultiAccountModelID(modelID)
  const contextID = split.baseModelID.match(/^(.*)#ctx-\d+$/)?.[1] ?? split.baseModelID
  return split.accountID ? { id: contextID, accountID: split.accountID } : { id: contextID }
}

export function useWorkBuddyUsage(options?: { now?: Accessor<number> }): WorkBuddyUsageState {
  /**
   * `useLimits` owns a network resource and a side-effecting `createEffect`, so
   * it must be instantiated ONCE per view — never per row. Callers that cannot
   * guarantee a limits-capable tree get a benign empty state instead of a throw;
   * the picker is rendered from several places (composer, subagent picker,
   * stories) and a hard crash there takes down the whole popover.
   */
  let limits: ReturnType<typeof useLimits> | undefined
  try {
    limits = useLimits(options)
  } catch {
    limits = undefined
  }
  const empty = () => undefined
  const noRate = () => undefined
  if (!limits) {
    return {
      accounts: () => [],
      forModel: empty,
      rateFor: noRate,
      modelVariants: () => [],
      result: () => undefined,
    }
  }

  const result = createMemo<ProviderResult | undefined>(() => {
    const list = limits!.providers()
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

  const pool = createMemo<WorkBuddyAccountUsage | undefined>(() => {
    const window = result()?.usage?.windows["aggregate:basic"]
    if (!window) return undefined
    const credits = workBuddyCredits(window)
    if (!credits) return undefined
    const remainingPercent = window.remainingPercent ?? (credits.remaining / credits.total) * 100
    return {
      id: "__workbuddy_pool__",
      account: "Pool",
      remainingCredits: credits.remaining,
      totalCredits: credits.total,
      remainingPercent: Math.max(0, Math.min(100, remainingPercent)),
      resetAt: window.resetAt,
    }
  })

  /**
   * The real average credits burned per request, taken from what WorkBuddy
   * actually reported rather than from the catalog's sticker rate.
   *
   * This is the WorkBuddy analogue of the OpenCode Go picker's
   * `averageCostPerRequest`: that path averages REAL cost per request out of
   * synced assistant messages and prefers it over published pricing. WorkBuddy
   * models publish `cost: 0`, so no per-message figure exists there — but the
   * governor does report the true `credit` per generation upstream, summed per
   * model. Dividing that by the observed request count gives the same signal.
   *
   * Returns undefined until there are enough samples AND some real spend, so a
   * freshly-seen model keeps using the published rate instead of presenting a
   * one-sample average as fact.
   */
  const observedRateFor = (id: string, accountID?: string): number | undefined => {
    const usage = result()?.usage
    if (!usage?.workbuddyAccounts) return undefined
    for (const account of usage.workbuddyAccounts) {
      if (accountID && account.accountId !== accountID) continue
      const report = account.models?.find((entry) => entry.model === id)
      // Free models legitimately report 0 credits; that must not be mistaken
      // for "no data", so gate on the personalized flag the server computed.
      if (!report?.creditsPersonalized) continue
      const requests = report.usedObserved
      if (!requests || requests <= 0) continue
      const average = report.creditsObserved / requests
      if (!Number.isFinite(average) || average <= 0) continue
      return average
    }
    return undefined
  }

  const rateFor = (modelID: string) => {
    const { id, accountID } = splitWorkBuddyModelID(modelID)
    const entry = result()?.usage?.models?.[id]
    if (!entry) return undefined
    // `rate` is per-request credits. 0 means unpublished unless rateFree says
    // the catalog is advertising it as genuinely free right now.
    const published = entry.rate ?? 0
    const observed = observedRateFor(id, accountID)
    const rate = observed ?? published
    const free = entry.rateFree === true || (rate <= 0 && !!entry.promotionLabel)
    return {
      rate,
      free,
      label: entry.rateLabel ?? "",
      /** True when `rate` came from real usage rather than the catalog. */
      personalized: observed !== undefined,
      ...(entry.promotionLabel ? { promotion: entry.promotionLabel } : {}),
    }
  }

  const forModel = (modelID: string): WorkBuddyModelUsage | undefined => {
    const rate = rateFor(modelID)
    if (!rate) return undefined
    const { id, accountID } = splitWorkBuddyModelID(modelID)

    // Free 0.00x models (Hy3, Hy4 Preview) do NOT draw from Basic/Gift/Extra.
    // Their stretch bar must show the 24h per-model frequency quota (account×model),
    // i.e. remainingEstimate / limitEstimate from the entitlement reports, not the
    // credit pool. This is the correct funding source for promo models.
    if (rate.free) {
      const usage = result()?.usage
      const accts = usage?.workbuddyAccounts ?? []
      const windows = usage?.windows ?? {}
      const candidates = accts.flatMap((acct) => {
        if (accountID && acct.accountId !== accountID) return []
        const report = acct.models?.find((entry) => entry.model === id || entry.canonical === id)
        if (!report) return []
        return [{ acct, report, exhausted: workBuddyAccountCreditsExhausted(windows, acct.label) }]
      })
      // No entitlement yet: show no bar rather than an infinite one.
      if (candidates.length === 0) return undefined

      // A pinned row (`hy4-preview@wb-<id>`) has exactly one candidate — its
      // own account. The unpinned/pool row is what the real AccountRouter
      // would actually serve, so it must pick the SAME way the router does:
      // prefer an account with known credits and headroom, never just
      // whichever account happens to be first in the list — otherwise the
      // pool row can cry "No credits" while a perfectly usable sibling
      // account sits right next to it.
      const pick = accountID
        ? candidates[0]!
        : [...candidates].sort((a, b) => {
            if (a.exhausted !== b.exhausted) return a.exhausted ? 1 : -1
            return (b.report.remainingPercent ?? 0) - (a.report.remainingPercent ?? 0)
          })[0]!

      const { acct, report, exhausted } = pick
      const best = accts[0]
      return {
        remainingPercent: exhausted ? 0 : (report.remainingPercent ?? 100),
        remainingCredits: exhausted ? 0 : (report.remainingEstimate ?? 0),
        account: acct.label,
        isBestAccount: !accountID || acct.accountId === best?.accountId,
        pool: !accountID,
        modelID: id,
        personalized: false,
        estimatedRequests: exhausted ? 0 : Math.max(0, report.remainingEstimate ?? 0),
        rate: 0,
        free: true,
        creditsExhausted: exhausted,
        ...(rate.promotion ? { promotion: rate.promotion } : {}),
      }
    }

    const list = accounts()
    if (list.length === 0) return undefined

    // A pinned row is funded by ITS account, so its bar reflects that account's
    // own headroom. An unpinned ("pool") row is funded by the aggregate balance
    // when the adapter published one, and otherwise by the richest account so a
    // pool row still reads even on a single-account setup where only per-account
    // windows were emitted.
    const funder = accountID
      ? list.find((entry) => entry.id === accountID)
      : (pool() ?? list[0])
    if (!funder) return undefined
    // Unknown account id: better no bar than one funded by the wrong account.
    if (accountID && funder.id !== accountID) return undefined

    const best = list[0]
    const base = {
      remainingPercent: funder.remainingPercent,
      remainingCredits: funder.remainingCredits,
      account: funder.account,
      isBestAccount: !accountID || funder.id === best?.id,
      pool: !accountID,
      modelID: id,
      /** True when the rate driving this estimate is measured, not published. */
      personalized: rate.personalized === true,
      ...(rate.promotion ? { promotion: rate.promotion } : {}),
    }

    if (rate.rate <= 0) return undefined

    return {
      ...base,
      estimatedRequests: Math.max(0, Math.floor(funder.remainingCredits / rate.rate)),
      rate: rate.rate,
      free: false,
      creditsExhausted: false,
    }
  }

  const modelVariants = (modelID: string): WorkBuddyModelUsage[] => {
    const { id } = splitWorkBuddyModelID(modelID)
    const variants: WorkBuddyModelUsage[] = []
    const pool = forModel(id)
    if (pool) variants.push(pool)
    for (const account of accounts()) {
      const pinned = forModel(`${id}@${account.id}`)
      if (pinned) variants.push(pinned)
    }
    return variants
  }

  return { accounts, forModel, rateFor, modelVariants, result }
}
