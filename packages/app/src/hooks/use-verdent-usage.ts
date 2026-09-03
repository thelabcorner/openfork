import { createMemo } from "solid-js"
import type { Accessor } from "solid-js"
import { useLimits } from "@/hooks/use-limits"
import { splitMultiAccountModelID } from "@/utils/model-account-identity"
import type { WorkBuddyModelUsage } from "@/hooks/use-workbuddy-usage"

/**
 * Verdent stretch estimates for the model picker.
 *
 * Mirrors `useWorkBuddyUsage` but for Verdent's free-tier multi-account
 * setup. WorkBuddy bills in credits per request; Verdent free is
 * *requests per window* (400/5h, ~650/week) and is tracked per
 * (account, model) in the entitlement governor. The picker still wants
 * the same visual language: a per-account bar showing
 * `remainingEstimate / limitEstimate` for that model on that account,
 * and a pool row that picks the healthiest account the router would use.
 *
 * Data source is the quota `verdentAccounts` already polled by `useLimits`
 * (see `quota/providers/verdent.ts` → `verdentLimitSnapshot()`), so no
 * extra network traffic. When an account+model has never been observed
 * and has no hard 429, there is nothing to show → degrade to no bar.
 */

export type VerdentModelUsage = WorkBuddyModelUsage
export type VerdentAccountUsage = {
  id: string
  account: string
  remainingPercent: number | null
  remainingEstimate: number | null
}

function stripVerdentContext(modelID: string): string {
  // Verdent context aliases are `@300k` / `@1m` appended before the optional
  // account suffix. `splitMultiAccountModelID` already stripped the
  // `@vd-…` account part, so this only needs to peel the window.
  const at = modelID.lastIndexOf("@")
  if (at <= 0) return modelID
  const suffix = modelID.slice(at + 1)
  if (/^\d+\s*[kKmM]$/.test(suffix)) return modelID.slice(0, at)
  return modelID
}

export function splitVerdentModelID(modelID: string): { id: string; accountID?: string } {
  const split = splitMultiAccountModelID(modelID)
  const base = stripVerdentContext(split.baseModelID)
  return split.accountID ? { id: base, accountID: split.accountID } : { id: base }
}

export function useVerdentUsage(options?: { now?: Accessor<number> }) {
  let limits: ReturnType<typeof useLimits> | undefined
  try {
    limits = useLimits(options as any)
  } catch {
    limits = undefined
  }
  const empty = () => undefined
  if (!limits) {
    return {
      forModel: empty as (modelID: string) => VerdentModelUsage | undefined,
      result: (() => undefined) as Accessor<any>,
    }
  }

  const result = createMemo(() => {
    const list = (limits as any).providers?.() ?? []
    return list.find((p: any) => p.result?.providerId === "verdent")?.result
  })

  const forModel = (modelID: string): VerdentModelUsage | undefined => {
    const usage = (result() as any)?.usage
    const accts: any[] = usage?.verdentAccounts ?? []
    if (accts.length === 0) return undefined
    const { id, accountID } = splitVerdentModelID(modelID)

    // Pinned row: exactly one candidate — its own account.
    // Pool row: pick the healthiest account the router would actually use,
    // preferring non-exhausted with headroom.
    const candidates = accts.flatMap((acct: any) => {
      if (accountID && acct.accountId !== accountID) return []
      const report = acct.models?.find((m: any) => m.model === id || m.canonical === id)
      if (!report) return []
      // Only surface rows with real evidence, same as WorkBuddy free promo.
      if (report.usedObserved <= 0 && !report.exhaustedObserved) return []
      return [{ acct, report }]
    })
    if (candidates.length === 0) return undefined
    const pick = accountID
      ? candidates[0]!
      : [...candidates].sort((a, b) => {
          const aEx = !!a.report.exhaustedObserved
          const bEx = !!b.report.exhaustedObserved
          if (aEx !== bEx) return aEx ? 1 : -1
          return (b.report.remainingPercent ?? 0) - (a.report.remainingPercent ?? 0)
        })[0]!

    const { acct, report } = pick
    const exhausted = !!report.exhaustedObserved
    const remainingPercent = exhausted ? 0 : (report.remainingPercent ?? 100)
    const remainingEstimate = exhausted ? 0 : (report.remainingEstimate ?? 0)
    // For Verdent free, the governor's limitEstimate is the per-model
    // frequency window budget (learned or inferred). Use it as "rate" analogue
    // for the stretch bar's tooltip; the bar itself is remainingPercent.
    return {
      estimatedRequests: Math.max(0, remainingEstimate ?? 0),
      remainingPercent: remainingPercent as number,
      remainingCredits: remainingEstimate ?? 0,
      rate: 0,
      account: acct.label,
      isBestAccount: !accountID || acct.accountId === accts[0]?.accountId,
      pool: !accountID,
      modelID: id,
      personalized: false,
      free: true,
      creditsExhausted: exhausted,
    } as unknown as VerdentModelUsage
  }

  return { forModel, result }
}
