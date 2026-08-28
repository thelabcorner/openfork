// Shared cheapness / cost helpers — the single source of truth for "which model
// is cheaper" across the app (§2-3 of cheapness-v2-usage-yield-proposal).
//
// This file intentionally stays tiny: the heavy economics live in the pure
// `model-usage-yield.ts` engine (workload corpus, median, regimes). This shim
// merely exposes the synchronous comparators and display helpers that UI
// components (selector, manage dialog, models panel) need without awaiting a
// fetch, and re-exports the yield engine's public surface for async callers.
//
// For synchronous Solid memos (`Array.sort`) the comparator falls back to the
// pinned 16-tuple corpus so ranking is available immediately; callers that
// already own a live corpus (via `getUsageTables()`) can pass it in to upgrade
// the sort to the current live workload without changing call sites.

import type { ModelCost, Workload } from "./model-usage-yield"
import {
  FALLBACK_WORKLOAD_CORPUS,
  FALLBACK_CORPUS_FINGERPRINT,
  blendedCost,
  buildStandardWorkloadCorpus,
  classifyMonetaryClass,
  compareModelsByUsageYield,
  compilePricingRegimes,
  priceWorkload,
} from "./model-usage-yield"
import { hasPublishedPricing, isUnlimitedModel } from "./model-badges"
import type { UsageProfile } from "./model-usage-profile"

export type { ModelCost, Workload }
export { FALLBACK_WORKLOAD_CORPUS, FALLBACK_CORPUS_FINGERPRINT, classifyMonetaryClass, compareModelsByUsageYield }

export type CheapnessModel = {
  id: string
  name: string
  family?: string
  provider: { id: string; name?: string }
  cost: ModelCost
}

// ---------------------------------------------------------------------------
//  Synchronous comparator for `Array.sort` (hot path)
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for the old `byCost = (a,b)=> (input+output)` that now
 * implements Usage Yield V2 (§5-6, §19, §31) synchronously.
 *
 * - Free taxonomy (§10, §19): quota-exempt → free-limited-known → free-unknown
 *   always sort before paid, in that tier order.
 * - Paid: workload-normalized median cost via the fallback corpus (§5.1) with
 *   time-weighted DeepSeek blending (§9) and context-threshold selection (§8)
 *   when a thresholdPricing hint is supplied.
 * - Personal measured $/request (§31) is blended heavily (≥70% weight, ≥3 samples)
 *   over the standardized corpus — your own history is more relevant than the
 *   generic 16-tuple, but the corpus remains a 30% prior to avoid overfitting
 *   a handful of early samples. The same weighting is applied across *all*
 *   providers, so a model you use heavily on any provider will outrank its
 *   generic corpus position.
 * - Unpriced (no published $/M) sorts last within its tier (§25).
 * - Deterministic tiebreakers (§28): name → id → provider.
 *
 * `corpus` is optional — when omitted the pinned fallback is used so the call
 * stays synchronous. `thresholdPricing` lets callers that resolved tier rows
 * from `collectThresholdPricing` inject them without an extra lookup.
 * `personalCosts` is the measured yield index (heavily weighted when present).
 */
export function compareByCheapness(
  a: CheapnessModel,
  b: CheapnessModel,
  corpus?: Workload[],
  thresholdPricingMap?: Map<string, Array<{ thresholdTokens: number; operator: "<=" | ">"; cost: ModelCost }>>,
  personalCosts?: Map<string, { cost: number; count: number }>,
  pricingFallback?: Map<string, ModelCost>,
  personalFallback?: Map<string, { cost: number; count: number }>,
  hitRates?: Map<string, number>,
  hitRateFallback?: Map<string, number>,
): number {
  // HOT PATH: called O(n log n) times per sort (~3k compares for 400 models).
  // Avoid per-compare allocations: reuse the fallback corpus directly and avoid
  // wrapping it in a fresh {corpus,…} object or cloning the array.
  const effectiveCorpus = (corpus ?? FALLBACK_WORKLOAD_CORPUS) as unknown as Workload[]

  const keyA = `${a.provider.id}:${a.id}`
  const keyB = `${b.provider.id}:${b.id}`

  // Tier check first (§19): free taxonomy always outranks paid regardless of personal data.
  const classA = classifyMonetaryClass({ id: a.id, name: a.name, provider: a.provider, cost: a.cost })
  const classB = classifyMonetaryClass({ id: b.id, name: b.name, provider: b.provider, cost: b.cost })
  const tierOrder: Record<ReturnType<typeof classifyMonetaryClass>, number> = { "quota-exempt": 0, "free-limited-known": 1, "free-limited-unknown": 2, paid: 3 }
  if (classA !== classB) return tierOrder[classA] - tierOrder[classB]
  if (classA !== "paid") return a.name.localeCompare(b.name)

  // Effective pricing: if a model is unpriced on this provider but the same
  // model id has published pricing on another provider (common, §pricing-fallback),
  // borrow that sibling's pricing. Across providers the same model is ~same cost
  // (except openrouter, which is excluded from the fallback map), so this is
  // far better than treating it as unpriced/last. The fallback map is keyed by
  // model id only (not provider) and prefers non-openrouter sources.
  const effectiveCostA = hasPublishedPricing(a.cost) ? a.cost : pricingFallback?.get(a.id) ?? a.cost
  const effectiveCostB = hasPublishedPricing(b.cost) ? b.cost : pricingFallback?.get(b.id) ?? b.cost

  // Both paid: priced vs unpriced (§25) still dominates before yield — but now
  // after sibling fallback, far fewer models remain unpriced.
  const pricedA = hasPublishedPricing(effectiveCostA)
  const pricedB = hasPublishedPricing(effectiveCostB)
  if (pricedA !== pricedB) return pricedA ? -1 : 1
  if (!pricedA && !pricedB) return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  if (keyA === keyB) return 0

  // Corpus-derived cost via workload-normalized median (§5-6) with
  // context-threshold (§8) and time-blended (§9) regimes. Use the effective
  // (fallback-aware) cost for the yield calculation. If a cache hit rate is
  // available for this provider+model (openrouter telemetry or own aggregate),
  // the workload's prompt is re-split as `K'=T*h`, `I'=T*(1-h)` so a cheap
  // cache hit directly improves yield.
  const ta = thresholdPricingMap?.get(keyA)
  const tb = thresholdPricingMap?.get(keyB)
  const ra = compilePricingRegimes(a as CheapnessModel & { provider: { id: string } }, effectiveCostA, ta)
  const rb = compilePricingRegimes(b as CheapnessModel & { provider: { id: string } }, effectiveCostB, tb)
  const hitRateA = hitRates?.get(keyA) ?? hitRateFallback?.get(a.id)
  const hitRateB = hitRates?.get(keyB) ?? hitRateFallback?.get(b.id)
  const corpusA = median(effectiveCorpus.map((w) => priceWorkload(w, ra, hitRateA).expected))
  const corpusB = median(effectiveCorpus.map((w) => priceWorkload(w, rb, hitRateB).expected))

  // Blend in personal measured $/request when available — heavily weighted
  // (§31, user feedback). Both are $/request, so blending is linear in cost.
  // If the exact provider:model has no personal data, fall back to any
  // provider's personal data for the same model id (§personal-fallback): your
  // workload shape for a given model is similar across providers, so personal
  // data from anthropic:claude-sonnet can value openrouter:claude-sonnet etc.
  const pa = personalCosts?.get(keyA) ?? personalFallback?.get(a.id)
  const pb = personalCosts?.get(keyB) ?? personalFallback?.get(b.id)
  const blendedA = pa ? blendedCost(corpusA, pa.cost, pa.count) : corpusA
  const blendedB = pb ? blendedCost(corpusB, pb.cost, pb.count) : corpusB

  if (blendedA !== blendedB) return blendedA - blendedB
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id) || a.provider.id.localeCompare(b.provider.id)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

/**
 * Bulk O(n) ranking helper for hot sort paths (dialog-select-model).
 * Computes the blended corpus cost once per model instead of once per
 * compare (≈ O(n log n) redundant median evaluations). Returns models
 * sorted cheap→expensive with the same tier/tiebreaker semantics as
 * `compareByCheapness` but ~7× fewer `priceWorkload` evaluations for
 * n≈400 (400×16 vs ~3000×32).
 */
export function sortByCheapness(
  models: CheapnessModel[],
  corpus?: Workload[],
  thresholdPricingMap?: Map<string, Array<{ thresholdTokens: number; operator: "<=" | ">"; cost: ModelCost }>>,
  personalCosts?: Map<string, { cost: number; count: number }>,
  pricingFallback?: Map<string, ModelCost>,
  personalFallback?: Map<string, { cost: number; count: number }>,
  hitRates?: Map<string, number>,
  hitRateFallback?: Map<string, number>,
): CheapnessModel[] {
  const effectiveCorpus = (corpus ?? FALLBACK_WORKLOAD_CORPUS) as unknown as Workload[]
  type Rank = { tier: number; priced: number; blended: number; name: string; id: string; provider: string }
  const rankOf = (m: CheapnessModel): Rank => {
    const klass = classifyMonetaryClass({ id: m.id, name: m.name, provider: m.provider, cost: m.cost })
    const tierOrder: Record<ReturnType<typeof classifyMonetaryClass>, number> = { "quota-exempt": 0, "free-limited-known": 1, "free-limited-unknown": 2, paid: 3 }
    const tier = tierOrder[klass]
    if (klass !== "paid") return { tier, priced: 0, blended: 0, name: m.name, id: m.id, provider: m.provider.id }
    const effCost = hasPublishedPricing(m.cost) ? m.cost : pricingFallback?.get(m.id) ?? m.cost
    const priced = hasPublishedPricing(effCost) ? 0 : 1
    if (priced) return { tier, priced, blended: 0, name: m.name, id: m.id, provider: m.provider.id }
    const key = `${m.provider.id}:${m.id}`
    const t = thresholdPricingMap?.get(key)
    const regimes = compilePricingRegimes(m as CheapnessModel & { provider: { id: string } }, effCost, t)
    const hr = hitRates?.get(key) ?? hitRateFallback?.get(m.id)
    const corpusCost = median(effectiveCorpus.map((w) => priceWorkload(w, regimes, hr).expected))
    const p = personalCosts?.get(key) ?? personalFallback?.get(m.id)
    const blended = p ? blendedCost(corpusCost, p.cost, p.count) : corpusCost
    return { tier, priced, blended, name: m.name, id: m.id, provider: m.provider.id }
  }
  const scored = models.map((m) => ({ m, r: rankOf(m) }))
  scored.sort((a, b) => {
    if (a.r.tier !== b.r.tier) return a.r.tier - b.r.tier
    if (a.r.priced !== b.r.priced) return a.r.priced - b.r.priced
    if (a.r.priced) return a.r.name.localeCompare(b.r.name) || a.r.id.localeCompare(b.r.id)
    if (a.r.blended !== b.r.blended) return a.r.blended - b.r.blended
    return a.r.name.localeCompare(b.r.name) || a.r.id.localeCompare(b.r.id) || a.r.provider.localeCompare(b.r.provider)
  })
  return scored.map((s) => s.m)
}

/**
 * Pricing fallback (§pricing-fallback): same model across providers is ~same
 * cost (except openrouter). Build a map modelId → ModelCost from the first
 * published sibling, preferring non-openrouter sources. Used when a model's
 * own provider has no published pricing — we borrow the sibling's price
 * instead of treating it as unpriced/last.
 */
export function buildPricingFallbackMap(models: CheapnessModel[]): Map<string, ModelCost> {
  const map = new Map<string, ModelCost>()
  const isOpenRouter = (m: CheapnessModel) => m.provider.id === "openrouter"
  for (const m of models) {
    if (!hasPublishedPricing(m.cost)) continue
    const existing = map.get(m.id)
    if (!existing) {
      map.set(m.id, m.cost)
      continue
    }
    // Prefer non-openrouter: if current is non-OR, overwrite; if current is OR, never overwrite a non-OR entry.
    if (!isOpenRouter(m)) {
      map.set(m.id, m.cost)
    }
  }
  return map
}

/**
 * Personal usage fallback (§personal-fallback): same model across providers
 * shares your workload shape. Aggregate personal $/request by model id
 * (weighted by sample count) so that a model you used via anthropic can
 * value the same model via openrouter etc., instead of falling back to the
 * generic corpus.
 */
export function buildPersonalFallbackMap(
  personalCosts: Map<string, { cost: number; count: number }>,
): Map<string, { cost: number; count: number }> {
  const byModel = new Map<string, { sumCost: number; sumCount: number }>()
  for (const [key, entry] of personalCosts.entries()) {
    const sep = key.indexOf(":")
    const modelId = sep >= 0 ? key.slice(sep + 1) : key
    const agg = byModel.get(modelId)
    if (!agg) byModel.set(modelId, { sumCost: entry.cost * entry.count, sumCount: entry.count })
    else {
      agg.sumCost += entry.cost * entry.count
      agg.sumCount += entry.count
    }
  }
  const out = new Map<string, { cost: number; count: number }>()
  for (const [modelId, agg] of byModel.entries()) {
    // Only useful as fallback if we have at least 2 providers or a decent sample;
    // but we always emit, blendedCost will still require ≥3 samples to apply.
    out.set(modelId, { cost: agg.sumCost / agg.sumCount, count: agg.sumCount })
  }
  return out
}

// ---------------------------------------------------------------------------
//  Display helpers
// ---------------------------------------------------------------------------

/**
 * Whether a model should be treated as "free" for badge purposes (§10, §19).
 * Centralizes the three historical checks (isUnlimitedModel, isFree, :free id)
 * so badge logic doesn't diverge from ranking logic.
 */
export function isFreeModel(model: { id: string; name?: string; provider: { id: string }; cost?: { input?: number } }): boolean {
  if (isUnlimitedModel(model)) return true
  if (model.provider.id === "openrouter" && (model.id === "openrouter/free" || model.id.endsWith(":free"))) return true
  if (model.provider.id === "opencode" && (!model.cost || model.cost.input === 0)) return true
  return false
}

/**
 * True when we have enough pricing data to produce a finite yield (§25).
 * Image-gen models (all zero) return false → sorted last, shown as "—".
 */
export function hasPricingForYield(cost: ModelCost | undefined): boolean {
  if (!cost) return false
  return hasPublishedPricing(cost) || cost.cache.read > 0
}

/**
 * Build a live workload corpus from Go profiles (§5.1-7). Pass the result's
 * `.corpus` into `compareByCheapness` to upgrade the sort from fallback to
 * live without changing the comparator contract.
 */
export function corpusFromProfiles(profiles: UsageProfile[]) {
  return buildStandardWorkloadCorpus(profiles)
}
