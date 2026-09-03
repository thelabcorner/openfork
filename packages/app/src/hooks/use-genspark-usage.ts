import { createMemo } from "solid-js"
import { useLimits } from "@/hooks/use-limits"

/**
 * Pack pricing observed 2026-09-01 via `gsk me` / Genspark web: one pack
 * is $20 for 7500 credits, valid 3 months. The pack is additive — the
 * `/api/tool_cli/me` probe returned `credit_balance: 10270.85` while the pack
 * itself is 7500, so balances stack.
 *
 * Verified live: `ses_fa420c096ffedHcSjgzWc59E30` (deep-seek-v4-flash on
 * genspark) burned 12 credits for 53,044 tokens (53,009 in + 11 out + 24
 * reasoning) — file `Downloads/new-session---2026-09-01t07-29-12-553z.json.br:1`.
 * That is 12/53.044 ≈ 226 credits/M, i.e. 226/375 ≈ $0.603/M, which matches a
 * flash-model $0.60/M tier. We therefore derive credits/M as $/M * 375 and
 * fall back to $0.60/M (225 credits/M) when published pricing is absent so the
 * picker never shows "—" for Genspark.
 */
const CREDITS_PER_DOLLAR = 7500 / 20 // 375

export type GensparkModelUsage = {
  estimatedRequests: number
  remainingCredits: number
  rateCreditsPerM: number
  rateDollarsPerM: number
}

/**
 * Genspark stretch estimates for the model picker.
 * Genspark bills in credits, not dollars: 7500 credits = $20 => 375 credits per $1.
 * We derive credits/M from the model's dollar cost (via pricing fallback) and
 * estimate remaining requests as remainingCredits / creditsPerRequest.
 */
export function useGensparkUsage() {
  let limits: ReturnType<typeof useLimits> | undefined
  try {
    limits = useLimits()
  } catch {
    limits = undefined
  }
  if (!limits) {
    return {
      remainingCredits: () => undefined as number | undefined,
      forModel: () => undefined,
      rateFor: () => undefined,
    }
  }

  const result = createMemo(() => {
    const list = limits!.providers()
    if (!list) return undefined
    return list.find((p) => p.result.providerId === "genspark")?.result
  })

  const remainingCredits = createMemo<number | undefined>(() => {
    const usage = result()?.usage
    if (!usage) return undefined
    const window = usage.windows["credits"] ?? usage.windows["credits_balance"] ?? Object.values(usage.windows)[0]
    if (!window?.valueLabel) return undefined
    // valueLabel is "10,270.85 credits"
    const num = Number(window.valueLabel.replace(/[^0-9.\-]/g, "").replace(/,/g, ""))
    if (!Number.isFinite(num)) return undefined
    return num
  })

  const rateFor = (dollarCostPerM: number | undefined) => {
    let cost = dollarCostPerM
    // Genspark models currently have cost 0 in the static catalog, but we still
    // want to show a stretch bar. Use observed 226/M for deep-seek-v4-flash
    // (12 credits for 53k tokens) or a generic $0.60/M fallback.
    if (cost === undefined || !Number.isFinite(cost) || cost <= 0) cost = 0.6
    const creditsPerM = cost * CREDITS_PER_DOLLAR
    return { creditsPerM, dollarsPerM: cost }
  }

  const forModel = (dollarCostPerM: number | undefined): GensparkModelUsage | undefined => {
    const remaining = remainingCredits()
    if (remaining === undefined) return undefined
    const rate = rateFor(dollarCostPerM)
    if (!rate) return undefined
    // Average request token profile: same fallback as model-usage-estimate.ts
    // Input 800, cached 65k, output 220 => cost per request
    const profile = { input: 800, cached: 65_000, output: 220 }
    // We need per-token cost breakdown, but we only have blended $/M.
    // Approximate: blended $/M = (input+output)/M avg, so credits per request ≈ creditsPerM * avgTokens / 1M
    // Use a simple average of 1k tokens per request as heuristic.
    const avgTokensPerRequest = 1000
    const creditsPerRequest = (rate.creditsPerM * avgTokensPerRequest) / 1_000_000
    if (!(creditsPerRequest > 0)) return undefined
    const estimatedRequests = Math.max(0, Math.floor(remaining / creditsPerRequest))
    return {
      estimatedRequests,
      remainingCredits: remaining,
      rateCreditsPerM: rate.creditsPerM,
      rateDollarsPerM: rate.dollarsPerM,
    }
  }

  return { remainingCredits, forModel, rateFor, result }
}

export function formatCreditsPerMillion(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—"
  // Same growing-precision logic as formatCostPerMillion but without currency
  let decimals = 0
  // Show at least 0 decimals for large, 2 for small
  if (value < 10) decimals = 2
  else if (value < 100) decimals = 1
  // Grow if still 0
  while (decimals < 4 && Number(value.toFixed(decimals)) === 0) decimals++
  return `${value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} credits/M`
}
