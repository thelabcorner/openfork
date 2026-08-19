import type { ForkWindowUsage } from "@/utils/fork-client"
import type { UsageProfile } from "@/utils/model-usage-profile"

export type ModelCost = {
  input: number
  output: number
  cache: { read: number; write: number }
}

// Fallback average-request token profile, used only when the live per-model
// table (model-usage-profile.ts, scraped from OpenCode Go's own docs) has no
// entry for this model — e.g. a brand-new model the docs haven't listed yet,
// or the fetch failed and there's no cache. Deliberately generic rather than
// tuned per-model.
const FALLBACK_PROFILE: UsageProfile = { input: 800, cached: 65_000, output: 220 }

export function estimateRequestsRemainingFromCost(window: ForkWindowUsage, costPerRequest: number): number | undefined {
  if (!(costPerRequest > 0)) return undefined
  const remainingUSD = Math.max(0, window.limitUSD - window.spentUSD)
  return Math.floor(remainingUSD / costPerRequest)
}

export function estimateRequestsRemaining(
  window: ForkWindowUsage,
  cost: ModelCost,
  profile: UsageProfile = FALLBACK_PROFILE,
): number | undefined {
  const costPerRequest =
    (profile.input * cost.input + profile.cached * cost.cache.read + profile.output * cost.output) / 1_000_000
  return estimateRequestsRemainingFromCost(window, costPerRequest)
}

// Only the paid Go subscription has $-budgeted 5h/week/month windows; the
// free "opencode" (Zen) tier has no such budget to estimate stretch against.
export const isUsageTrackedProvider = (providerID: string) => providerID === "opencode-go"
