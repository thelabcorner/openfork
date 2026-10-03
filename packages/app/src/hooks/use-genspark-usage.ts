import { createMemo } from "solid-js"
import { useLimits, type LimitsState } from "@/hooks/use-limits"

/**
 * Pack pricing observed 2026-09-01 via `gsk me` / Genspark web: one pack
 * is $20 for 7500 credits, valid 3 months. The pack is additive — the
 * `/api/tool_cli/me` probe returned `credit_balance: 10270.85` while the pack
 * itself is 7500, so balances stack.
 *
 * Verified live: `ses_fa420c096ffedHcSjgzWc59E30` (deep-seek-v4-flash on
 * genspark) burned 12 credits for 53,044 tokens (53,009 in + 11 out + 24
 * reasoning) — file `Downloads/new-session---2026-09-01t07-29-12-553z.json.br:1`.
 * That is 12/53.044 ≈ 226 credits/M, i.e. 226/375 ≈ $0.603/M, which is what a
 * flash-model $0.60/M tier would cost.
 *
 * That observation is evidence about ONE model, not a published rate, so it is
 * deliberately NOT used as a fallback. The published-price conversion below is
 * the only rate this module will report: credits/M = $/M * 375 when Genspark
 * (or its catalog) publishes a price, and NO rate at all when it does not.
 * Callers must render "—" for an unknown rate rather than substitute a plausible
 * dollar figure — an invented $/M silently becomes an invented "requests left".
 */
const CREDITS_PER_DOLLAR = 7500 / 20 // 375

export type GensparkRate = {
  creditsPerM: number
  dollarsPerM: number
}

export type GensparkModelUsage = {
  remainingCredits: number
  /** Undefined when no published rate exists for this model. */
  rateCreditsPerM?: number
  rateDollarsPerM?: number
}

/**
 * Genspark stretch estimates for the model picker.
 * Genspark bills in credits, not dollars: 7500 credits = $20 => 375 credits per $1.
   * We derive credits/M from the model's published dollar cost. Request-count
   * capacity deliberately does NOT live here: the shared server Capacity owner
   * already has the user's request-size posterior and the provider resource
   * denominator. A local 1k-token heuristic would create a second, weaker source
   * of truth for the same number.
 */
export function useGensparkUsage(options?: { limits?: LimitsState }) {
  let limits: LimitsState | undefined = options?.limits
  if (!limits) {
    try {
      limits = useLimits()
    } catch {
      limits = undefined
    }
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

  /**
   * Published price -> credit rate, or nothing.
   *
   * There is intentionally no fallback tier here. A catalog that reports `0`
   * for Genspark models means "Genspark publishes no token price", not "the
   * price is zero", and answering 0 would render a free-model claim; answering
   * $0.60/M would render an invented one. Both are lies, so the only honest
   * answer without a real rate is `undefined`.
   */
  const rateFor = (dollarCostPerM: number | undefined | null): GensparkRate | undefined => {
    if (dollarCostPerM === undefined || dollarCostPerM === null) return undefined
    if (!Number.isFinite(dollarCostPerM) || dollarCostPerM <= 0) return undefined
    const creditsPerM = dollarCostPerM * CREDITS_PER_DOLLAR
    if (!Number.isFinite(creditsPerM) || creditsPerM <= 0) return undefined
    return { creditsPerM, dollarsPerM: dollarCostPerM }
  }

  const forModel = (dollarCostPerM: number | undefined | null): GensparkModelUsage | undefined => {
    const remaining = remainingCredits()
    if (remaining === undefined) return undefined
    const rate = rateFor(dollarCostPerM)
    // No published rate: the balance is still a real measurement, so keep it and
    // report no rate. Consumers dash the rate cell rather than invent one.
    if (!rate) return { remainingCredits: remaining }
    return {
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
