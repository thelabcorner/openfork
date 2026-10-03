// Generalized usage yield: reprice ONE observed/generalized workload through a
// specific model's own current pricing semantics.
//
// Why this exists (see docs/plans/personalized-request-yield-capacity-ledger.md
// §8 + §22.3): a naive "same base model on another provider -> provider mean ->
// global mean" cold-start hierarchy was falsified on the real prequential
// replay. What IS defensible is transferring the user's own *workload vector*
// and then pricing it through the target model's *current* economics. That is
// exactly what this module does, and it deliberately reuses the shared pure
// pricing machinery in ./usage-yield (compilePricingRegimes / priceWorkload)
// instead of duplicating the token math.
//
// Non-goals, enforced by construction here:
//  - This module never produces a "requests left" number. Inverting spend into
//    request counts requires a real quota/resource denominator (Capacity owns
//    that); a $/request prediction has no denominator and needs none.
//  - It never promotes a donor model's mean into another model. The workload it
//    prices is either this exact model's own measurements, the user's overall
//    measured workload, or the standardized population corpus — never a mean
//    borrowed from a different model.
//  - It is pure and browser-safe: no fetch, no storage, no Solid primitives.

import { hasPublishedPricing } from "./badges"
import { classifyMonetaryClass, compilePricingRegimes, priceWorkload, type ModelCost, type Workload } from "./usage-yield"

/**
 * A workload observation in *token* terms. Structurally compatible with the
 * server's generalized usage workload projection, so the wire value can be
 * handed over without a second translation layer.
 */
export type GeneralWorkload = {
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
}

/**
 * Provenance of the workload being repriced, most specific first.
 *
 * - `personal-model`: this exact provider/model's own recent settled requests.
 * - `personal-general`: the user's overall recent requests (mature personal
 *   corpus), repriced through this model's pricing.
 * - `standardized-workload-prior`: the population coding-agent corpus.
 */
export type GeneralYieldSource = "personal-model" | "personal-general" | "standardized-workload-prior"

export type GeneralYield = {
  readonly source: GeneralYieldSource
  /** The priced workload, in the §5.1 corpus tuple shape. */
  readonly workload: Workload
  /** $/request for this workload under this model's current pricing, or null. */
  readonly costPerEquivalentRequest: number | null
  /** Reciprocal yield; null whenever the cost is zero/absent/non-finite. */
  readonly equivalentRequestsPerDollar: number | null
  /** §8 tier label / §9 blend label when the model is not flat-priced. */
  readonly regimeLabel: string | undefined
  /** Current target context capacity when known. */
  readonly contextLimit: number | null
  /** workload.contextTokens / contextLimit when the target publishes a limit. */
  readonly contextUtilization: number | null
  /** Null only when the target has no usable context limit. */
  readonly fitsContext: boolean | null
  readonly status: "priced" | "context-overflow" | "unpriced"
  /** True when a finite positive $/request was actually produced. */
  readonly priced: boolean
}

function nonNegative(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Map an observed token workload onto the pricing corpus tuple shape.
 *
 * `contextTokens` deliberately includes cache-write tokens: that is the prompt
 * size that selects a §8 context-threshold tier, and it matches the server's
 * own `costForTokens` context denominator. `outputTokens` folds reasoning in,
 * because reasoning tokens are billed as output everywhere in this codebase.
 */
export function generalPricingWorkload(general: GeneralWorkload): Workload {
  const freshInputTokens = nonNegative(general.inputTokens)
  const cachedReadTokens = nonNegative(general.cacheReadTokens)
  const cacheWriteTokens = nonNegative(general.cacheWriteTokens)
  const outputTokens = nonNegative(general.outputTokens) + nonNegative(general.reasoningTokens)
  return {
    freshInputTokens,
    cachedReadTokens,
    cacheWriteTokens,
    outputTokens,
    contextTokens: freshInputTokens + cachedReadTokens + cacheWriteTokens,
  }
}

export type GeneralYieldInput = {
  readonly model: { readonly id: string; readonly name?: string; readonly provider: { readonly id: string; readonly name?: string } }
  readonly cost: ModelCost
  readonly general: GeneralWorkload
  readonly source: GeneralYieldSource
  readonly contextLimit?: number
  /** §8 two-tier pricing rows when the catalog publishes them for this model. */
  readonly thresholdPricing?: Array<{ thresholdTokens: number; operator: "<=" | ">"; cost: ModelCost }>
}

/**
 * Price one generalized workload through the target model's own pricing.
 *
 * No cache hit rate is applied here on purpose. The workload already carries the
 * user's real observed input/cache-read split — that *is* the personalization.
 * Re-splitting it by a hit rate would double-count the same signal and, because
 * `priceWorkload`'s hit-rate path recomputes `contextTokens` from the
 * prompt-only total, would also silently drop cache-write tokens from §8 tier
 * selection.
 *
 * Free/unlimited/quota-exempt models deliberately return `priced: false` and
 * null economics: §10 keeps those out of monetary yield entirely, so a
 * $0/request label can never be rendered for them.
 */
export function evaluateGeneralUsageYield(input: GeneralYieldInput): GeneralYield {
  const workload = generalPricingWorkload(input.general)
  const contextLimit =
    Number.isFinite(input.contextLimit) && (input.contextLimit ?? 0) > 0 ? input.contextLimit! : null
  const contextUtilization = contextLimit ? workload.contextTokens / contextLimit : null
  const fitsContext = contextLimit ? workload.contextTokens <= contextLimit : null
  const unpaid: GeneralYield = {
    source: input.source,
    workload,
    costPerEquivalentRequest: null,
    equivalentRequestsPerDollar: null,
    regimeLabel: undefined,
    contextLimit,
    contextUtilization,
    fitsContext,
    status: fitsContext === false ? "context-overflow" : "unpriced",
    priced: false,
  }

  if (fitsContext === false) return unpaid
  if (classifyMonetaryClass({ id: input.model.id, name: input.model.name, provider: input.model.provider, cost: input.cost }) !== "paid")
    return unpaid
  if (!hasPublishedPricing(input.cost)) return unpaid
  if (!(workload.contextTokens + workload.outputTokens > 0)) return unpaid

  const regimes = compilePricingRegimes(input.model, input.cost, input.thresholdPricing)
  const priced = priceWorkload(workload, regimes)
  if (!(priced.expected > 0) || !Number.isFinite(priced.expected)) return unpaid

  return {
    source: input.source,
    workload,
    costPerEquivalentRequest: priced.expected,
    equivalentRequestsPerDollar: 1 / priced.expected,
    regimeLabel: priced.regimeLabel,
    contextLimit,
    contextUtilization,
    fitsContext,
    status: "priced",
    priced: true,
  }
}