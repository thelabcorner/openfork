/**
 * LACE v14.7: experimental, client-only cache-boundary planning.
 *
 * This file intentionally knows nothing about provider calls, session authority,
 * hidden provider KV state, or tool execution. The caller must provide a verified
 * route-compatible, model-visible prefix and conservative reuse forecasts.
 *
 * Prices use any single consistent currency unit per token. Cache admission
 * estimates are NOT evidence that the provider created or retained a cache.
 */

export interface CacheRates {
  readonly ordinary: number
  readonly write: number
  readonly read: number
}

export interface FutureCacheCall {
  /** Probability that this future request actually occurs, in [0, 1]. */
  readonly probability: number
  /** Total input tokens on that future request. */
  readonly totalTokens: number
  /** Exact common leading tokens with the current request, NOT semantic similarity. */
  readonly sharedPrefixTokens: number
  /** Conditional probability that the matching provider prefix remains available. */
  readonly residencyProbability: number
}

export interface CacheForecast {
  readonly initialTokens: number
  readonly candidateBoundaries: ReadonlyArray<number>
  readonly future: ReadonlyArray<FutureCacheCall>
  readonly rates: CacheRates
  readonly maxBreakpoints: number
  readonly minimumCacheableTokens?: number
  /** Safety margin: avoid selecting a plan on negligible forecasted savings. */
  readonly minimumSavingsFraction?: number
  /** Optional absolute saving requirement, in the same cost units as rates. */
  readonly minimumSavingsCost?: number
}

export interface CacheAdmissionPlan {
  readonly boundaries: ReadonlyArray<number>
  readonly projectedCost: number
  readonly uncachedCost: number
  readonly projectedSavings: number
  readonly savingsFraction: number
  readonly evaluatedPlans: number
}

/**
 * A byte-exact prefix witness for already serialized, cache-sensitive request
 * fragments. Segmentation can differ between the requests: equality is checked
 * across boundaries. Shared Uint8Array objects are skipped without byte scans.
 *
 * Do not treat this as proof of provider KV residency or downstream SDK encoding.
 */
export function commonPrefixBytes(
  before: ReadonlyArray<Uint8Array>,
  after: ReadonlyArray<Uint8Array>,
): { readonly bytes: number; readonly identical: boolean } {
  let a = 0
  let b = 0
  let ai = 0
  let bi = 0
  let matched = 0

  while (true) {
    while (a < before.length && ai === before[a]!.byteLength) {
      a++
      ai = 0
    }
    while (b < after.length && bi === after[b]!.byteLength) {
      b++
      bi = 0
    }
    if (a === before.length || b === after.length) {
      return { bytes: matched, identical: a === before.length && b === after.length }
    }
    const x = before[a]!
    const y = after[b]!
    const count = Math.min(x.byteLength - ai, y.byteLength - bi)
    if (x !== y || ai !== bi) {
      for (let k = 0; k < count; k++) {
        if (x[ai + k] !== y[bi + k]) return { bytes: matched + k, identical: false }
      }
    }
    matched += count
    ai += count
    bi += count
  }
}

function finiteNonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(name + " must be finite and nonnegative")
}

function wholeNonnegative(value: number, name: string): void {
  finiteNonnegative(value, name)
  if (!Number.isSafeInteger(value)) throw new RangeError(name + " must be a safe integer")
}

function probability(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(name + " must be within [0,1]")
}

export function validateCacheForecast(input: CacheForecast): ReadonlyArray<number> {
  wholeNonnegative(input.initialTokens, "initialTokens")
  for (const [key, value] of Object.entries(input.rates)) finiteNonnegative(value, "rates." + key)
  wholeNonnegative(input.maxBreakpoints, "maxBreakpoints")
  if (input.maxBreakpoints > 4) throw new RangeError("maxBreakpoints must not exceed the supported 4")
  if (input.candidateBoundaries.length > 24) throw new RangeError("at most 24 candidate boundaries per planning pass")
  const min = input.minimumCacheableTokens ?? 0
  wholeNonnegative(min, "minimumCacheableTokens")
  probability(input.minimumSavingsFraction ?? 0, "minimumSavingsFraction")
  finiteNonnegative(input.minimumSavingsCost ?? 0, "minimumSavingsCost")

  const distinct = new Set<number>()
  for (const point of input.candidateBoundaries) {
    wholeNonnegative(point, "candidateBoundary")
    if (point > input.initialTokens) throw new RangeError("boundary exceeds initialTokens")
    if (point >= min && point > 0) distinct.add(point)
  }
  for (const call of input.future) {
    probability(call.probability, "future.probability")
    probability(call.residencyProbability, "future.residencyProbability")
    wholeNonnegative(call.totalTokens, "future.totalTokens")
    wholeNonnegative(call.sharedPrefixTokens, "future.sharedPrefixTokens")
    if (call.sharedPrefixTokens > Math.min(input.initialTokens, call.totalTokens)) {
      throw new RangeError("future sharedPrefixTokens exceed a request length")
    }
  }
  return Array.from(distinct).sort((a, b) => a - b)
}

export function estimateCacheCost(input: CacheForecast, boundaries: ReadonlyArray<number>): number {
  const { ordinary, write, read } = input.rates
  const last = boundaries.length ? boundaries[boundaries.length - 1]! : 0
  let result = last * write + (input.initialTokens - last) * ordinary
  for (const call of input.future) {
    if (call.probability === 0) continue
    let active = 0
    let shared = 0
    for (const point of boundaries) {
      if (point <= call.totalTokens) active = point
      if (point <= call.sharedPrefixTokens) shared = point
    }
    if (!active) {
      result += call.probability * call.totalTokens * ordinary
      continue
    }
    const hit = shared ? call.residencyProbability : 0
    // Conservatively bill an unreused selected suffix at the write price.
    // These are expected input charges only, not a provider billing oracle.
    const hitCost = shared * read + (active - shared) * write + (call.totalTokens - active) * ordinary
    const missCost = active * write + (call.totalTokens - active) * ordinary
    result += call.probability * (hit * hitCost + (1 - hit) * missCost)
  }
  return result
}

/**
 * Exhaustively evaluates up to 24 candidate positions and at most four markers.
 * It models explicit cache writes: unchanged earlier prefixes can be read, while
 * nonmatching selected suffixes are charged as writes. Provider-specific rules
 * (lookback, TTL and breakpoint validity) must filter candidates BEFORE calling.
 */
export function planCacheAdmission(input: CacheForecast): CacheAdmissionPlan {
  const candidates = validateCacheForecast(input)
  const baseline = estimateCacheCost(input, [])
  let bestCost = baseline
  let best: number[] = []
  let evaluatedPlans = 0
  const active: number[] = []
  const margin = Math.max(input.minimumSavingsCost ?? 0, baseline * (input.minimumSavingsFraction ?? 0))

  const visit = (start: number): void => {
    evaluatedPlans++
    const cost = estimateCacheCost(input, active)
    // Strict threshold plus deterministic tie-break (fewer markers).
    if (baseline - cost > margin && (cost < bestCost - 1e-10 ||
      (Math.abs(cost - bestCost) <= 1e-10 && active.length < best.length))) {
      bestCost = cost
      best = active.slice()
    }
    if (active.length === input.maxBreakpoints) return
    for (let i = start; i < candidates.length; i++) {
      active.push(candidates[i]!)
      visit(i + 1)
      active.pop()
    }
  }
  visit(0)
  const savings = baseline - bestCost
  return {
    boundaries: best,
    projectedCost: bestCost,
    uncachedCost: baseline,
    projectedSavings: savings,
    savingsFraction: baseline > 0 ? savings / baseline : 0,
    evaluatedPlans,
  }
}

export interface ShadowDecision {
  readonly correctAndCompatible: boolean
  readonly warmExpectedCost: number
  readonly shadowExpectedCost: number
  readonly preparationCost: number
  readonly transitionCost: number
  readonly riskReserve?: number
  readonly minimumNetSaving?: number
}

export function evaluateShadowPromotion(input: ShadowDecision): {
  readonly promote: boolean
  readonly expectedNetSaving: number
} {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "number") finiteNonnegative(value, key)
  }
  const net = input.warmExpectedCost - input.shadowExpectedCost -
    input.preparationCost - input.transitionCost - (input.riskReserve ?? 0)
  return {
    promote: input.correctAndCompatible && net > (input.minimumNetSaving ?? 0),
    expectedNetSaving: net,
  }
}

export * as CacheFrontier from "./cache-frontier"
