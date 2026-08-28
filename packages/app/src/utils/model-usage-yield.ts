// Cheapness V2: Usage Yield engine — port of the watcher proposal
// https://opencode.ai/docs/go  +  https://opencode.ai/docs/zen
//
// Goal: rank models by *standardized coding-agent usage per dollar*
// (§2-5 of cheapness-v2-usage-yield-proposal). Every paid model is priced
// against the SAME workload corpus (deduped Go request profiles), not its own
// idiosyncratic profile. Context-threshold and time regimes are modeled
// semantically (§8-9), free tiers are kept in a separate monetary taxonomy
// (§10), and relative value (fraction of best, cost multiple) is exposed (§11).
//
// This module is intentionally pure: no fetch, no localStorage, no Solid
// primitives. Parsers in model-usage-profile.ts own the network hop; this file
// owns the economics. That mirrors the proposed `usage-yield.js` /
// `usage-workloads.js` split (§27) and makes the algorithm testable.
//
// Extrapolation across providers (§32-33): the same corpus and regime model is
// applied to ANY provider's published $/M rates — opencode, openai, anthropic,
// google, openrouter, etc. — so "cheap" means the same comparable workload
// everywhere, not just inside opencode-go. The per-provider grouping in the UI
// stays, but the cheapness sort inside each group is now workload-normalized.

import type { UsageProfile } from "./model-usage-profile"
import { DEEPSEEK_PEAK_RATES, isDeepSeekPeakPricedModel } from "./model-peak-pricing"
import { hasPublishedPricing, isUnlimitedModel } from "./model-badges"

// ---------------------------------------------------------------------------
//  Workload corpus (§5.1)
// ---------------------------------------------------------------------------

export type Workload = {
  freshInputTokens: number
  cachedReadTokens: number
  outputTokens: number
  /** fresh + cached — the input context size that drives threshold tiers */
  contextTokens: number
}

// The 16 unique request-shape tuples currently published by Go (Aug 26 snapshot,
// §5.1). Deduplication is already applied: e.g. MiMo-V2.5 and Hy3 share
// 830/71500/295, DeepSeek Flash and Vision Exp share 410/71300/310, etc.
// This array is the *fallback* corpus so that ranking is synchronously
// available even before the live fetch completes; the live corpus from
// `getUsageTables()` will replace it when available (see §21.4, §28).
export const FALLBACK_WORKLOAD_CORPUS: readonly Workload[] = [
  { freshInputTokens: 390, cachedReadTokens: 32_500, outputTokens: 120, contextTokens: 32_890 },
  { freshInputTokens: 1_000, cachedReadTokens: 55_000, outputTokens: 200, contextTokens: 56_000 },
  { freshInputTokens: 700, cachedReadTokens: 52_000, outputTokens: 150, contextTokens: 52_700 },
  { freshInputTokens: 1_000, cachedReadTokens: 50_000, outputTokens: 220, contextTokens: 51_000 },
  { freshInputTokens: 1_050, cachedReadTokens: 76_500, outputTokens: 300, contextTokens: 77_550 },
  { freshInputTokens: 870, cachedReadTokens: 55_000, outputTokens: 200, contextTokens: 55_870 },
  { freshInputTokens: 920, cachedReadTokens: 88_900, outputTokens: 200, contextTokens: 89_820 },
  { freshInputTokens: 750, cachedReadTokens: 82_000, outputTokens: 290, contextTokens: 82_750 },
  { freshInputTokens: 410, cachedReadTokens: 71_300, outputTokens: 310, contextTokens: 71_710 },
  { freshInputTokens: 510, cachedReadTokens: 56_000, outputTokens: 190, contextTokens: 56_510 },
  { freshInputTokens: 300, cachedReadTokens: 55_000, outputTokens: 125, contextTokens: 55_300 },
  { freshInputTokens: 620, cachedReadTokens: 71_400, outputTokens: 300, contextTokens: 72_020 },
  { freshInputTokens: 830, cachedReadTokens: 71_500, outputTokens: 295, contextTokens: 72_330 },
  { freshInputTokens: 790, cachedReadTokens: 86_000, outputTokens: 305, contextTokens: 86_790 },
  { freshInputTokens: 420, cachedReadTokens: 66_000, outputTokens: 200, contextTokens: 66_420 },
  { freshInputTokens: 500, cachedReadTokens: 57_000, outputTokens: 190, contextTokens: 57_500 },
] as const

/** SHA-1 truncated fingerprint for the fallback corpus — used as `corpusFingerprint` when no live corpus is available. */
export const FALLBACK_CORPUS_FINGERPRINT = "fallback-16-aug26"

export type CorpusBands = {
  corpus: Workload[]
  light: Workload[]
  typical: Workload[]
  heavy: Workload[]
  fingerprint: string
}

/**
 * Deduplicate a raw profile list into the standardized workload corpus (§5.1:
 * exact duplicate tuples do NOT double-weight). Returns sorted-by-context corpus
 * so that band splitting (§7) is deterministic.
 */
export function buildStandardWorkloadCorpus(profiles: UsageProfile[]): CorpusBands {
  const seen = new Set<string>()
  const corpus: Workload[] = []
  for (const p of profiles) {
    const key = `${p.input}|${p.cached}|${p.output}`
    if (seen.has(key)) continue
    seen.add(key)
    corpus.push({
      freshInputTokens: p.input,
      cachedReadTokens: p.cached,
      outputTokens: p.output,
      contextTokens: p.input + p.cached,
    })
  }
  // If upstream returns nothing (fetch failure + cold cache), fall back to the
  // pinned 16-tuple so ranking stays defined — marked low-confidence by caller.
  const effective = corpus.length > 0 ? corpus : [...FALLBACK_WORKLOAD_CORPUS]
  effective.sort((a, b) => a.contextTokens - b.contextTokens || a.freshInputTokens - b.freshInputTokens)

  const fingerprint = effective.length === FALLBACK_WORKLOAD_CORPUS.length && effective.every((w, i) => w.contextTokens === FALLBACK_WORKLOAD_CORPUS[i].contextTokens)
    ? FALLBACK_CORPUS_FINGERPRINT
    : `live-${effective.length}-${hashCorpus(effective)}`

  const n = effective.length
  // §7: light = bottom quartile, heavy = top quartile, typical = middle 50% +
  // overall median is the primary rank (§6). Using slice indices that handle
  // non-divisible-by-4 counts gracefully.
  const q1 = Math.floor(n / 4)
  const q3 = Math.ceil((n * 3) / 4)
  return {
    corpus: effective,
    light: effective.slice(0, q1),
    typical: effective.slice(q1, q3),
    heavy: effective.slice(q3),
    fingerprint,
  }
}

function hashCorpus(corpus: Workload[]): string {
  // Tiny FNV-1a over the tuple stream — deterministic, fast, sufficient for a
  // fingerprint; not a crypto hash. Only used to detect corpus change (§21.4).
  let h = 0x811c9dc5
  for (const w of corpus) {
    for (const v of [w.freshInputTokens, w.cachedReadTokens, w.outputTokens] as const) {
      h ^= v
      h = Math.imul(h, 0x01000193)
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

// ---------------------------------------------------------------------------
//  Pricing regimes (§8-9, §26)
// ---------------------------------------------------------------------------

export type ModelCost = {
  input: number
  output: number
  cache: { read: number; write: number }
}

export type PricingRegime =
  | { kind: "flat"; prices: ModelCost }
  // Context-threshold (§8): a workload whose context is on one side of the
  // threshold uses that row's prices. Order matters only for the integer
  // boundary — we treat "≤ X" as inclusive.
  | { kind: "context-threshold"; thresholdTokens: number; operator: "<=" | ">"; prices: ModelCost }
  // Time regime (§9): only DeepSeek today. Peak/off-peak use the weekly
  // schedule fraction; expected cost is the time-weighted blend.
  | { kind: "time"; label: "peak" | "off-peak"; fraction: number; prices: ModelCost }

/** Weekly schedule fraction for DeepSeek (§9: 35 peak hours / 168 = 20.83%) */
const DEEPSEEK_PEAK_FRACTION = 35 / 168 // ≈0.2083
const DEEPSEEK_OFF_PEAK_FRACTION = 133 / 168 // ≈0.7917

/**
 * Compile the pricing regimes for a model (§8-9, §27).
 *
 * Priority:
 *  1. DeepSeek time regimes — always emits two `time` regimes with schedule
 *     fractions, regardless of the underlying ModelCost snapshot (which only
 *     ever reflects one period). Uses the published DEEPSEEK_PEAK_RATES table
 *     so the expensive half of the week is never hidden.
 *  2. Context-threshold regimes — if `thresholdPricing` is provided and contains
 *     two rows for the same normalized model name with distinct thresholds
 *     (e.g. Qwen3.7 Plus ≤256K vs >256K, Grok 4.6 ≤200K vs >200K, GPT 5.6 Luna
 *     ≤272K vs >272K), emit both `context-threshold` regimes.
 *  3. Flat — the common case for every other model/provider (§26.2: cached-write
 *     is NOT included in the primary score).
 */
export function compilePricingRegimes(
  model: { id: string; provider: { id: string } },
  baseCost: ModelCost,
  thresholdPricing?: Array<{ thresholdTokens: number; operator: "<=" | ">"; cost: ModelCost }>,
): PricingRegime[] {
  if (isDeepSeekPeakPricedModel(model)) {
    const rates = DEEPSEEK_PEAK_RATES[model.id]
    if (rates) {
      return [
        {
          kind: "time",
          label: "off-peak",
          fraction: DEEPSEEK_OFF_PEAK_FRACTION,
          prices: { input: rates["off-peak"].input, output: rates["off-peak"].output, cache: { read: rates["off-peak"].cacheRead, write: 0 } },
        },
        {
          kind: "time",
          label: "peak",
          fraction: DEEPSEEK_PEAK_FRACTION,
          prices: { input: rates.peak.input, output: rates.peak.output, cache: { read: rates.peak.cacheRead, write: 0 } },
        },
      ]
    }
  }
  if (thresholdPricing && thresholdPricing.length === 2) {
    // Ensure deterministic order: the ≤ row first (cheaper tier usually).
    const sorted = [...thresholdPricing].sort((a, b) => a.thresholdTokens - b.thresholdTokens)
    // Validate that we actually have one ≤ and one > with the same threshold,
    // otherwise fall through to flat — malformed tier data (§25 low-confidence)
    // should not produce a half-baked regime.
    if (sorted[0].operator === "<=" && sorted[1].operator === ">" && sorted[0].thresholdTokens === sorted[1].thresholdTokens) {
      return sorted.map((t) => ({ kind: "context-threshold" as const, thresholdTokens: t.thresholdTokens, operator: t.operator, prices: t.cost }))
    }
  }
  return [{ kind: "flat", prices: baseCost }]
}

/**
 * Price a single workload (§5.2) under the given regimes.
 *
 * - Flat: plain token math, optionally adjusted by `hitRate` (0-1). When a
 *   provider+model cache hit rate is available (openrouter telemetry or own
 *   aggregate `cacheRead/(cacheRead+input)`), the workload's prompt tokens
 *   `I+K` are re-split as `K' = T*h`, `I' = T*(1-h)` so a cheap cache hit
 *   actually impacts yield. When undefined, the original `I`/`K` split is used.
 * - Context-threshold: selects the tier whose operator matches workload.contextTokens.
 * - Time: returns the *expected* cost (time-weighted blend) and also exposes
 *   `best`/`worst` so callers can show peak vs off-peak (§9: best/worst remain).
 */
export function priceWorkload(
  workload: Workload,
  regimes: PricingRegime[],
  hitRate?: number,
): {
  expected: number
  best: number | undefined
  worst: number | undefined
  regimeLabel: string | undefined
} {
  // Apply cache hit rate if available: re-split the prompt's total context
  // `T = I+K` as `K' = T*h`, `I' = T*(1-h)`. This keeps total context constant
  // while letting a provider's actual cache efficiency (personal or openrouter
  // telemetry) directly affect cost: higher h → more tokens at cheap `P_K`.
  const effectiveWorkload = (() => {
    if (hitRate === undefined || hitRate === null || !Number.isFinite(hitRate)) return workload
    let h = hitRate > 1 ? hitRate / 100 : hitRate
    h = Math.max(0, Math.min(1, h))
    const totalPrompt = workload.freshInputTokens + workload.cachedReadTokens
    if (totalPrompt <= 0) return workload
    const effectiveCached = Math.round(totalPrompt * h)
    const effectiveFresh = totalPrompt - effectiveCached
    return {
      freshInputTokens: effectiveFresh,
      cachedReadTokens: effectiveCached,
      outputTokens: workload.outputTokens,
      contextTokens: totalPrompt,
    }
  })()

  const timeRegimes = regimes.filter((r): r is Extract<PricingRegime, { kind: "time" }> => r.kind === "time")
  if (timeRegimes.length === 2) {
    const costs = timeRegimes.map((r) => tokenCost(effectiveWorkload, r.prices))
    const off = timeRegimes.find((r) => r.label === "off-peak")
    const peak = timeRegimes.find((r) => r.label === "peak")
    const offCost = off ? tokenCost(effectiveWorkload, off.prices) : costs[0]
    const peakCost = peak ? tokenCost(effectiveWorkload, peak.prices) : costs[1]
    return {
      expected: offCost * DEEPSEEK_OFF_PEAK_FRACTION + peakCost * DEEPSEEK_PEAK_FRACTION,
      best: Math.min(offCost, peakCost),
      worst: Math.max(offCost, peakCost),
      regimeLabel: "time-blended",
    }
  }

  const thresholdRegimes = regimes.filter(
    (r): r is Extract<PricingRegime, { kind: "context-threshold" }> => r.kind === "context-threshold",
  )
  if (thresholdRegimes.length === 2) {
    // §8: workload maps to tier it actually activates.
    // Priority: if workload.context exactly equals threshold, the ≤ tier wins.
    const match =
      thresholdRegimes.find((r) => r.operator === "<=" && effectiveWorkload.contextTokens <= r.thresholdTokens) ??
      thresholdRegimes.find((r) => r.operator === ">" && effectiveWorkload.contextTokens > r.thresholdTokens) ??
      thresholdRegimes[0]
    return { expected: tokenCost(effectiveWorkload, match.prices), best: undefined, worst: undefined, regimeLabel: `${match.operator} ${match.thresholdTokens.toLocaleString()}` }
  }

  const flat = regimes.find((r) => r.kind === "flat") ?? regimes[0]
  return { expected: tokenCost(effectiveWorkload, flat.prices), best: undefined, worst: undefined, regimeLabel: undefined }
}

function tokenCost(workload: Workload, prices: ModelCost): number {
  // §5.2: C_{m,j} = (I_j P_I + K_j P_K + O_j P_O) / 1_000_000
  // §26.2: cached-write is NOT in the primary score — it models reuse, not creation.
  return (workload.freshInputTokens * prices.input + workload.cachedReadTokens * prices.cache.read + workload.outputTokens * prices.output) / 1_000_000
}

// ---------------------------------------------------------------------------
//  Free taxonomy (§10) & monetary tiers (§19)
// ---------------------------------------------------------------------------

export type MonetaryClass = "quota-exempt" | "free-limited-known" | "free-limited-unknown" | "paid"

export function classifyMonetaryClass(model: {
  id: string
  name?: string
  provider: { id: string }
  cost?: { input?: number; output?: number }
}): MonetaryClass {
  // Tier A: explicit unlimited/quota-exempt within the observed allowance system.
  // The models.dev entry advertises "(Unlimited)" and publishes $0 input — see
  // model-badges.ts. These are monetarily ahead of every paid model.
  if (isUnlimitedModel(model)) return "quota-exempt"

  // OpenRouter :free family and the synthetic "openrouter/free" id.
  // Whether they are known-capacity depends on FUT: if the caller can supply a
  // capacity hint (remaining/limit), they become free-limited-known; otherwise
  // free-limited-unknown. The pure classification here is unknown — the yield
  // layer that owns the FUT report can upgrade to known.
  if (model.provider.id === "openrouter" && (model.id === "openrouter/free" || model.id.endsWith(":free"))) {
    return "free-limited-unknown"
  }

  // Opencode (Zen) free tier: provider "opencode" with $0 published cost and
  // no unlimited marker — still free, but capacity not expressed as a simple
  // remaining/limit number in the selector (handled via limits panel).
  if (model.provider.id === "opencode" && !hasPublishedPricing(model.cost)) {
    // Distinguish true free ($0) from genuinely unpriced image models: image
    // models also have $0 but carry no free semantics — they belong to paid
    // but will be marked unpriced/low-confidence in the yield result.
    // Heuristic: free Zen models are text-capable; image-only models are caught
    // by the caller's hasPublishedPricing guard before reaching this classification
    // for ranking purposes, but we keep the branch conservative.
    return "free-limited-unknown"
  }

  // Opencode free with explicit $0 (Zen watch): still free tier, capacity
  // unknown from the selector's vantage.
  if (model.provider.id === "opencode" && (model.cost?.input === 0 || model.cost?.input === undefined) && !hasPublishedPricing(model.cost)) {
    return "free-limited-unknown"
  }

  return "paid"
}

// ---------------------------------------------------------------------------
//  Usage Yield (§5.2-§6, §20) & ranking (§11-12, §19)
// ---------------------------------------------------------------------------

export type UsageYield = {
  modelKey: string

  class: MonetaryClass

  /** Null for free tiers — they are ordered by tier (§19), not by yield. */
  rank: number | null
  totalRanked: number

  primary: {
    /** $ per equivalent request — null for free tiers (§10: 1/0 is not finite) */
    costPerEquivalentRequest: number | null
    /** Equivalent requests per $1 — null for free tiers */
    equivalentRequestsPerDollar: number | null
    /** Y_m / Y_best  (§11) — null for free or when no best */
    fractionOfBestPaid: number | null
    /** C_m / C_best  (§11) */
    costMultipleVsBestPaid: number | null
    /** Percentile among paid (0-100) */
    percentile: number | null
  }

  workload: {
    corpusSize: number
    corpusFingerprint: string
    light: { cost: number; requestsPerDollar: number } | undefined
    typical: { cost: number; requestsPerDollar: number }
    heavy: { cost: number; requestsPerDollar: number } | undefined
  }

  regimes: Array<{
    kind: "time" | "context" | "flat"
    label: string
    cost: number | null
    requestsPerDollar: number | null
  }>

  confidence: "high" | "medium" | "low"
  warnings: string[]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function evaluateModelUsageYield(
  model: { id: string; name?: string; provider: { id: string; name?: string }; cost: ModelCost },
  corpusBands: CorpusBands,
  opts?: {
    // Optional threshold-tier pricing looked up from the Go pricing table (§8).
    // When absent, the model is treated as flat.
    thresholdPricing?: Array<{ thresholdTokens: number; operator: "<=" | ">"; cost: ModelCost }>
    // Caller can upgrade openrouter free classification to known if they own a FUT report.
    openRouterFreeKnown?: boolean
    /** Cache hit rate 0-1 (or 0-100) for this provider+model. When available
     *  from openrouter telemetry or own aggregate `cacheRead/(input+cacheRead)`,
     *  the workload's `I+K` is re-split as `K'=T*h`, `I'=T*(1-h)` so a cheap
     *  cache hit directly improves yield. */
    hitRate?: number
  },
): UsageYield {
  const modelKey = `${model.provider.id}:${model.id}`
  const monetaryClass: MonetaryClass = (() => {
    const base = classifyMonetaryClass({ id: model.id, name: model.name, provider: model.provider, cost: model.cost })
    if (base === "free-limited-unknown" && opts?.openRouterFreeKnown) return "free-limited-known"
    return base
  })()

  const warnings: string[] = []
  const isPaid = monetaryClass === "paid"

  // §25: confidence from pricing completeness
  const confidence: UsageYield["confidence"] = (() => {
    if (!isPaid) return "high"
    if (!hasPublishedPricing(model.cost)) return "low"
    const hasInput = (model.cost.input ?? 0) > 0
    const hasOutput = (model.cost.output ?? 0) > 0
    const hasCache = (model.cost.cache.read ?? 0) > 0
    // Missing a required dimension for a cache-heavy corpus is medium/low (§26.1)
    if (!hasInput || !hasOutput) return "low"
    if (!hasCache && corpusBands.corpus.some((w) => w.cachedReadTokens > 50_000)) return "medium"
    if (opts?.thresholdPricing && opts.thresholdPricing.length !== 2) return "medium"
    return "high"
  })()

  if (!isPaid) {
    // Free tiers: no finite yield (§10). Rank/tier is handled by the outer
    // sort (§19) — cheapest always tier A → D. Warnings distinguish unknown.
    if (monetaryClass === "free-limited-unknown") warnings.push("free-capacity-unknown")
    return {
      modelKey,
      class: monetaryClass,
      rank: null,
      totalRanked: 0,
      primary: { costPerEquivalentRequest: null, equivalentRequestsPerDollar: null, fractionOfBestPaid: null, costMultipleVsBestPaid: null, percentile: null },
      workload: {
        corpusSize: corpusBands.corpus.length,
        corpusFingerprint: corpusBands.fingerprint,
        light: undefined,
        typical: { cost: 0, requestsPerDollar: Number.POSITIVE_INFINITY },
        heavy: undefined,
      },
      regimes: [],
      confidence,
      warnings,
    }
  }

  // Paid: price every workload in the corpus against the model's regimes (§5.2)
  const regimes = compilePricingRegimes(model, model.cost, opts?.thresholdPricing)

  const allCosts = corpusBands.corpus.map((w) => priceWorkload(w, regimes, opts?.hitRate).expected)
  const lightCosts = corpusBands.light.map((w) => priceWorkload(w, regimes, opts?.hitRate).expected)
  const heavyCosts = corpusBands.heavy.map((w) => priceWorkload(w, regimes, opts?.hitRate).expected)

  const typicalCost = median(allCosts)
  const lightCost = lightCosts.length > 0 ? median(lightCosts) : undefined
  const heavyCost = heavyCosts.length > 0 ? median(heavyCosts) : undefined

  // Guard against division by zero for degenerate $0 paid rows (should not
  // happen — $0 paid is free — but thesis demands fail-safe).
  const typicalYield = typicalCost > 0 ? 1 / typicalCost : Number.POSITIVE_INFINITY
  const lightYield = lightCost && lightCost > 0 ? 1 / lightCost : undefined
  const heavyYield = heavyCost && heavyCost > 0 ? 1 / heavyCost : undefined

  // Regime diagnostics for the tooltip (§9, §20 regimes[])
  const diagnostics: UsageYield["regimes"] = []
  const timeRegimes = regimes.filter((r): r is Extract<PricingRegime, { kind: "time" }> => r.kind === "time")
  if (timeRegimes.length === 2) {
    for (const r of timeRegimes) {
      const c = median(corpusBands.corpus.map((w) => priceWorkload(w, [r], opts?.hitRate).expected))
      diagnostics.push({ kind: "time", label: r.label, cost: c, requestsPerDollar: c > 0 ? 1 / c : null })
    }
    // Expected already in primary; also push it as a synthetic entry for completeness
    diagnostics.push({ kind: "time", label: "expected", cost: typicalCost, requestsPerDollar: typicalYield })
  } else if (regimes.some((r) => r.kind === "context-threshold")) {
    for (const r of regimes as Extract<PricingRegime, { kind: "context-threshold" }>[]) {
      const c = median(corpusBands.corpus.map((w) => priceWorkload(w, [r], opts?.hitRate).expected))
      diagnostics.push({ kind: "context", label: `${r.operator} ${r.thresholdTokens.toLocaleString()}`, cost: c, requestsPerDollar: c > 0 ? 1 / c : null })
    }
  } else {
    diagnostics.push({ kind: "flat", label: "standard", cost: typicalCost, requestsPerDollar: typicalYield })
  }

  // Missing mandatory price (§25) → unranked low-confidence (§5.2 guard)
  if (!(typicalCost > 0) || !Number.isFinite(typicalYield)) warnings.push("unpriced-or-zero")

  return {
    modelKey,
    class: "paid",
    rank: null, // filled by rankPaidUsageYield
    totalRanked: 0,
    primary: {
      costPerEquivalentRequest: typicalCost > 0 ? typicalCost : null,
      equivalentRequestsPerDollar: Number.isFinite(typicalYield) ? typicalYield : null,
      fractionOfBestPaid: null,
      costMultipleVsBestPaid: null,
      percentile: null,
    },
    workload: {
      corpusSize: corpusBands.corpus.length,
      corpusFingerprint: corpusBands.fingerprint,
      light: lightCost && lightYield ? { cost: lightCost, requestsPerDollar: lightYield } : undefined,
      typical: { cost: typicalCost, requestsPerDollar: typicalYield },
      heavy: heavyCost && heavyYield ? { cost: heavyCost, requestsPerDollar: heavyYield } : undefined,
    },
    regimes: diagnostics,
    confidence,
    warnings,
  }
}

/**
 * Rank paid results (§11-12, §19, §28). Competition ranking: `1,2,2,4`.
 * Near-ties are NOT collapsed (§12) — rank stays exact, callers annotate
 * "within X% of #N" separately. Percentile and fraction-of-best are derived
 * here so callers don't recompute the best.
 */
export function rankPaidUsageYield(results: UsageYield[]): Map<string, UsageYield> {
  const paid = results.filter((r) => r.class === "paid" && r.primary.equivalentRequestsPerDollar !== null && Number.isFinite(r.primary.equivalentRequestsPerDollar!))
  // Highest yield first (§5.2)
  paid.sort((a, b) => (b.primary.equivalentRequestsPerDollar! - a.primary.equivalentRequestsPerDollar!) || a.modelKey.localeCompare(b.modelKey))

  const best = paid[0]?.primary.equivalentRequestsPerDollar ?? null
  const bestCost = paid[0]?.primary.costPerEquivalentRequest ?? null
  const total = paid.length

  // Competition rank + percentile
  let rank = 0
  let seen = 0
  let prevYield: number | null = null
  const byKey = new Map<string, UsageYield>()

  for (const entry of paid) {
    seen++
    const y = entry.primary.equivalentRequestsPerDollar!
    if (prevYield === null || y !== prevYield) rank = seen
    prevYield = y

    const cost = entry.primary.costPerEquivalentRequest!
    const fraction = best && best > 0 ? y / best : null
    const multiple = bestCost && bestCost > 0 ? cost / bestCost : null
    const percentile = total > 1 ? ((total - rank) / (total - 1)) * 100 : 100

    const ranked: UsageYield = {
      ...entry,
      rank,
      totalRanked: total,
      primary: { ...entry.primary, fractionOfBestPaid: fraction, costMultipleVsBestPaid: multiple, percentile },
    }
    byKey.set(entry.modelKey, ranked)
  }

  // Free tiers: keep them in the map but with tier-ordered synthetic rank for
  // UI convenience (tier A always ahead of paid §19). Paid rank 1 remains the
  // "best paid" — free rank is informational.
  const free = results.filter((r) => r.class !== "paid")
  const tierOrder: Record<MonetaryClass, number> = { "quota-exempt": 0, "free-limited-known": 1, "free-limited-unknown": 2, paid: 3 }
  free.sort((a, b) => tierOrder[a.class] - tierOrder[b.class] || a.modelKey.localeCompare(b.modelKey))
  for (const entry of free) {
    byKey.set(entry.modelKey, { ...entry, rank: null, totalRanked: total })
  }

  return byKey
}

// ---------------------------------------------------------------------------
//  Personal measured yield (§31, user-weighting)
// ---------------------------------------------------------------------------

/**
 * How strongly to weight the user's own measured $/request when it exists.
 * 0.70 = personal is more than twice as influential as the standardized corpus
 * (0.30), satisfying "our own measured yield values are more relevant / more
 * heavily weighted than the standardized corpus" without discarding the
 * corpus entirely (which would overfit a few early samples).
 */
export const PERSONAL_WEIGHT = 0.7
export const PERSONAL_MIN_SAMPLES = 3

/**
 * Blend a corpus-derived cost with a personal measured cost.
 * Returns corpusCost when personal is unavailable or below the sample threshold;
 * otherwise a weighted blend that heavily favors personal. Both inputs are
 * $/request (or $/equivalent-request), so blending is dimensionally sound.
 *
 * The weight can be overridden per-call (e.g. for sensitivity tests) but
 * defaults to PERSONAL_WEIGHT.
 */
export function blendedCost(
  corpusCost: number,
  personalCost: number | undefined,
  personalCount: number,
  weight = PERSONAL_WEIGHT,
): number {
  if (personalCost === undefined || personalCount < PERSONAL_MIN_SAMPLES) return corpusCost
  // Clamp personal weight to [0.6, 0.85] based on sample count so that even a
  // barely-qualified personal sample (3) still gets 60% weight, and a
  // well-sampled model (≥10) approaches 80% — personal stays heavily weighted
  // across the whole range.
  const countWeight = Math.min(0.8, 0.55 + personalCount * 0.025)
  const effectiveWeight = Math.max(weight, countWeight)
  return effectiveWeight * personalCost + (1 - effectiveWeight) * corpusCost
}

// ---------------------------------------------------------------------------
//  Lightweight synchronous comparators for the selector (§19, §32)
// ---------------------------------------------------------------------------

/**
 * Synchronous cheapness comparator for Solid memos that cannot await a corpus
 * fetch. Uses the fallback corpus + model's ModelCost directly (DeepSeek
 * blended, threshold flattening). This is the hot path for `Array.sort` in
 * dialog-select-model; the async path upgrades to a live corpus via
 * rankPaidUsageYield when available.
 *
 * Tiers (§19): quota-exempt → free-* → paid-by-yield → unpriced-last (§25).
 * Within paid: higher yield (lower typical cost) first, then name.
 */
export function compareModelsByUsageYield(
  a: { id: string; name: string; provider: { id: string }; cost: ModelCost },
  b: { id: string; name: string; provider: { id: string }; cost: ModelCost },
  corpusBands?: CorpusBands,
  personalCosts?: Map<string, { cost: number; count: number }>,
  hitRates?: Map<string, number>,
  hitRateFallback?: Map<string, number>,
): number {
  const bands = corpusBands ?? { corpus: [...FALLBACK_WORKLOAD_CORPUS] as Workload[], light: [], typical: [], heavy: [], fingerprint: FALLBACK_CORPUS_FINGERPRINT }
  // Reuse evaluate + cheap compare without full ranking for two items in isolation:
  // compute typical cost for each.
  const keyA = `${a.provider.id}:${a.id}`
  const keyB = `${b.provider.id}:${b.id}`
  if (keyA === keyB) return 0

  const classA = classifyMonetaryClass({ id: a.id, name: a.name, provider: a.provider, cost: a.cost })
  const classB = classifyMonetaryClass({ id: b.id, name: b.name, provider: b.provider, cost: b.cost })
  const tierOrder: Record<MonetaryClass, number> = { "quota-exempt": 0, "free-limited-known": 1, "free-limited-unknown": 2, paid: 3 }
  if (classA !== classB) return tierOrder[classA] - tierOrder[classB]

  // Both free-unknown: tiebreak by name (don't invent capacity order §10)
  if (classA !== "paid") return a.name.localeCompare(b.name)

  // Both paid: compare by median corpus cost (§5.2-6). Unpriced (0/invalid) last.
  const pricedA = hasPublishedPricing(a.cost)
  const pricedB = hasPublishedPricing(b.cost)
  if (pricedA !== pricedB) return pricedA ? -1 : 1
  if (!pricedA && !pricedB) return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

  const regimesA = compilePricingRegimes(a as { id: string; provider: { id: string } }, a.cost)
  const regimesB = compilePricingRegimes(b as { id: string; provider: { id: string } }, b.cost)
  const hitRateA = hitRates?.get(keyA) ?? hitRateFallback?.get(a.id)
  const hitRateB = hitRates?.get(keyB) ?? hitRateFallback?.get(b.id)
  const costsA = bands.corpus.map((w) => priceWorkload(w, regimesA, hitRateA).expected)
  const costsB = bands.corpus.map((w) => priceWorkload(w, regimesB, hitRateB).expected)
  const corpusA = median(costsA)
  const corpusB = median(costsB)
  // §31 + user-weighting: blend personal measured $/request (more relevant) heavily
  // over the standardized corpus. Both are $/request, so blending is dimensionally
  // sound; personal gets ~70% weight when available (≥3 samples), corpus is the
  // 30% prior that prevents overfitting a handful of early samples.
  let typicalA = corpusA
  let typicalB = corpusB
  if (personalCosts) {
    const pa = personalCosts.get(keyA)
    const pb = personalCosts.get(keyB)
    if (pa) typicalA = blendedCost(corpusA, pa.cost, pa.count)
    if (pb) typicalB = blendedCost(corpusB, pb.cost, pb.count)
  }

  // §12: don't collapse near-ties — exact compare, caller may annotate epsilon
  if (typicalA !== typicalB) return typicalA - typicalB

  // Deterministic tiebreakers (§28)
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id) || a.provider.id.localeCompare(b.provider.id)
}
