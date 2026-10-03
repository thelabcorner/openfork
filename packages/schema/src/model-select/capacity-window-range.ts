// Sensitivity band for a published FULL-WINDOW request capacity.
//
// The server Capacity projection publishes a per-window total capacity point and
// deliberately publishes no predictive range beside it. The deployed range
// (`GoPredictiveRange`) is a 5h remaining / stopping-time calibration validated
// against realized counts of requests until the next 5h reset; it was never
// validated for full-window totals or for weekly behaviour, so reusing it there
// would claim coverage that was never measured. The projection says so in its
// own contract comment, and this module is the consumer side of that instruction.
//
// So the band is derived from the representative request corpus the client
// already carries. The target model's pricing is compiled ONCE and every corpus
// workload is priced through it. The server-owned point is never re-centered:
// it already includes the Capacity workload posterior. Each corpus workload is
// instead expressed as a reciprocal cost ratio around that fixed anchor to show
// how many more/fewer requests would fit if requests resembled that shape.
//
// This is NOT a confidence interval and must never be labelled as one. It is the
// observed spread of request sizes in the workload, expressed as capacity. There
// is no coverage claim, no sampling distribution, and no probability over
// repeated draws here — only "your requests do not all look like the middle one".
//
// Pure and browser-safe, like the rest of ./model-select: no fetch, no storage,
// no runtime primitives.

import { generalPricingWorkload, type GeneralWorkload } from "./general-yield"
import { compilePricingRegimes, priceWorkload, type ModelCost, type PricingRegime } from "./usage-yield"

/**
 * Fewest priced corpus samples before a percentile band is drawn at all. With
 * three samples the 10th percentile is just the smallest request the corpus
 * happens to contain, which reads as a hard bound rather than a spread.
 */
export const MIN_CAPACITY_WINDOW_SAMPLES = 4

/**
 * Most representative workloads priced for one target. The published Go corpus
 * is 16 deduplicated request-shape tuples (§5.1); pricing more than the corpus
 * contains would only re-weight the same shapes.
 */
export const MAX_CAPACITY_WINDOW_SAMPLES = 16

/** Robust central band. Deliberately not a tail interval — see the module note. */
export const CAPACITY_WINDOW_BAND_LOWER_QUANTILE = 0.1
export const CAPACITY_WINDOW_BAND_UPPER_QUANTILE = 0.9

/** One published window total, straight off the server projection. */
export type CapacityWindowPoint = {
  readonly window: string
  /** Full-window total capacity under the server's own workload posterior. */
  readonly pointRequests: number
  /** Requests still available in this window, when really observed. */
  readonly remainingRequests?: number | null
}

/** A window total rescaled to this user's workload, with its spread. */
export type CapacityWindowBand = {
  readonly window: string
  readonly point: number
  readonly lower: number
  readonly upper: number
  /** Requests still available in this window; absent means unknown, never zero. */
  readonly remaining?: number
}

export type CapacityWindowRange = {
  readonly bands: readonly CapacityWindowBand[]
  /** Priced corpus samples that survived the context-window and cap filters. */
  readonly samples: number
  /** Representative workloads offered before capping/filtering. */
  readonly considered: number
  /**
   * False when no band may be drawn: the target publishes no window total, the
   * target cannot price the corpus at all, or too few samples survived. Callers
   * must then show the remaining quota alone rather than a fabricated total.
   */
  readonly usable: boolean
}

export type CapacityWindowRangeInput = {
  readonly model: { readonly id: string; readonly provider: { readonly id: string } }
  readonly cost: ModelCost
  readonly contextLimit?: number
  readonly thresholdPricing?: Array<{
    thresholdTokens: number
    operator: "<=" | ">"
    cost: ModelCost
  }>
  /** The user's own center workload for this target. */
  readonly center: GeneralWorkload
  /** The representative request corpus, in any order. */
  readonly corpus: readonly GeneralWorkload[]
  readonly windows: readonly CapacityWindowPoint[]
}

/**
 * Linear-interpolated quantile over an ascending array.
 *
 * Exported so the band arithmetic is testable on its own; callers must pass a
 * sorted array and a quantile in [0, 1].
 */
export function capacityWindowQuantile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return Number.NaN
  const clamped = Math.min(1, Math.max(0, quantile))
  const position = (sorted.length - 1) * clamped
  const low = Math.floor(position)
  const high = Math.ceil(position)
  if (low === high) return sorted[low]!
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low)
}

/**
 * $/request for one workload through one already-compiled pricing regime set.
 *
 * A workload larger than the target's own context window is dropped rather than
 * priced: such a request cannot be served by this model at all, so including it
 * would describe a request shape the user will never send here.
 */
function priceSample(
  workload: GeneralWorkload,
  regimes: PricingRegime[],
  contextLimit: number | undefined,
): number | undefined {
  const mapped = generalPricingWorkload(workload)
  if (!(mapped.contextTokens + mapped.outputTokens > 0)) return undefined
  if (contextLimit !== undefined && mapped.contextTokens > contextLimit) return undefined
  const cost = priceWorkload(mapped, regimes).expected
  if (!Number.isFinite(cost) || cost <= 0) return undefined
  return cost
}

function remainingRequestsOf(window: CapacityWindowPoint): number | undefined {
  const value = window.remainingRequests
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return value
}

/**
 * Draw the visible total-capacity band for every published window.
 *
 * The target's pricing is compiled exactly once and reused for the center
 * workload and every corpus sample, so a hover costs one regime compile plus one
 * `priceWorkload` per sample — not one compile per sample.
 */
export function capacityWindowRange(input: CapacityWindowRangeInput): CapacityWindowRange {
  const offered = Math.min(input.corpus.length, MAX_CAPACITY_WINDOW_SAMPLES)
  const contextLimit =
    Number.isFinite(input.contextLimit) && (input.contextLimit ?? 0) > 0 ? (input.contextLimit as number) : undefined

  const regimes = compilePricingRegimes(input.model, input.cost, input.thresholdPricing)
  const centerCost = priceSample(input.center, regimes, contextLimit)

  const costs: number[] = []
  for (const workload of input.corpus.slice(0, MAX_CAPACITY_WINDOW_SAMPLES)) {
    const cost = priceSample(workload, regimes, contextLimit)
    if (cost !== undefined) costs.push(cost)
  }
  const unusable = (): CapacityWindowRange => ({ bands: [], samples: costs.length, considered: offered, usable: false })
  if (centerCost === undefined || costs.length < MIN_CAPACITY_WINDOW_SAMPLES) return unusable()

  const bands: CapacityWindowBand[] = []
  for (const window of input.windows) {
    // Capacity owns this point. It has already applied the target model's
    // workload posterior to the provider's full-window request entitlement.
    // Re-centering it against the corpus here would personalize the same fact a
    // second time and make the UI disagree with the server.
    const point = window.pointRequests
    if (!Number.isFinite(point) || point <= 0) continue

    // Keep the window budget fixed and vary only the request shape:
    //
    //   scenario requests = point requests × center $/req ÷ scenario $/req
    //
    // A request that costs 2× the center can fit only 0.5× as many times; a
    // request costing 0.5× can fit 2× as many. This reciprocal relationship is
    // load-bearing: multiplying by sample cost would invert the meaning of the
    // range.
    const capacities = costs.map((cost) => (point * centerCost) / cost)
    capacities.sort((a, b) => a - b)

    // The band is workload sensitivity, not a confidence interval. Clamp it to
    // contain the authoritative point for one-sided corpora.
    const lower = Math.min(point, capacityWindowQuantile(capacities, CAPACITY_WINDOW_BAND_LOWER_QUANTILE))
    const upper = Math.max(point, capacityWindowQuantile(capacities, CAPACITY_WINDOW_BAND_UPPER_QUANTILE))
    const remaining = remainingRequestsOf(window)
    bands.push({ window: window.window, point, lower, upper, ...(remaining !== undefined ? { remaining } : {}) })
  }

  return { bands, samples: costs.length, considered: offered, usable: bands.length > 0 }
}