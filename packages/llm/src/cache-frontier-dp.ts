import {
  estimateCacheCost,
  validateCacheForecast,
  type CacheForecast,
  type CacheAdmissionPlan,
} from "./cache-frontier"

/**
 * LACE v14.7 exact breakpoint frontier (under the explicit-cache forecast model).
 * The brute-force optimizer in cache-frontier.ts is retained as an independent
 * reference oracle until this path has passed differential certification.
 *
 * For selected boundaries b1 < ... < bk, with b0 = 0, let
 * W(b) = (write - read) * sum(p * q when shared >= b)
 *      - (write - ordinary) * (1 + sum(p when futureTotal >= b)).
 * Expected savings equal sum((bj - b(j-1)) * W(bj)).
 * A chain DP therefore finds the exact optimum in O(F*N + K*N^2), replacing
 * combinatorial enumeration. Caller must filter for real provider limitations.
 */
export interface OptimizedCacheAdmissionPlan extends Omit<CacheAdmissionPlan, "evaluatedPlans"> {
  readonly evaluatedTransitions: number
}

export function planCacheAdmissionDP(input: CacheForecast): OptimizedCacheAdmissionPlan {
  const candidates = validateCacheForecast(input)
  const baseline = estimateCacheCost(input, [])
  const n = candidates.length
  const kmax = Math.min(n, input.maxBreakpoints)
  const margin = Math.max(input.minimumSavingsCost ?? 0, baseline * (input.minimumSavingsFraction ?? 0))
  if (!kmax) {
    return { boundaries: [], projectedCost: baseline, uncachedCost: baseline,
      projectedSavings: 0, savingsFraction: 0, evaluatedTransitions: 0 }
  }
  const coefficients = candidates.map((boundary) => {
    let read = 0
    let write = 1
    for (const call of input.future) {
      if (call.sharedPrefixTokens >= boundary) read += call.probability * call.residencyProbability
      if (call.totalTokens >= boundary) write += call.probability
    }
    return read * (input.rates.write - input.rates.read) -
      write * (input.rates.write - input.rates.ordinary)
  })
  const score = Array.from({ length: kmax + 1 }, () => new Float64Array(n).fill(-Infinity))
  const parent = Array.from({ length: kmax + 1 }, () => new Int32Array(n).fill(-1))
  let bestScore = margin
  let bestCount = 0
  let bestEnd = -1
  let evaluatedTransitions = 0
  for (let count = 1; count <= kmax; count++) {
    for (let j = count - 1; j < n; j++) {
      const boundary = candidates[j]!
      const coefficient = coefficients[j]!
      if (count === 1) {
        score[count]![j] = boundary * coefficient
        evaluatedTransitions++
      } else {
        for (let i = count - 2; i < j; i++) {
          evaluatedTransitions++
          const candidate = score[count - 1]![i]! + (boundary - candidates[i]!) * coefficient
          if (candidate > score[count]![j]!) {
            score[count]![j] = candidate
            parent[count]![j] = i
          }
        }
      }
      if (score[count]![j]! > bestScore) {
        bestScore = score[count]![j]!
        bestCount = count
        bestEnd = j
      }
    }
  }
  const boundaries: number[] = []
  for (let count = bestCount, end = bestEnd; count > 0; count--) {
    boundaries.push(candidates[end]!)
    end = parent[count]![end]!
  }
  boundaries.reverse()
  const projectedCost = estimateCacheCost(input, boundaries)
  const projectedSavings = baseline - projectedCost
  if (!(projectedSavings > margin)) {
    return { boundaries: [], projectedCost: baseline, uncachedCost: baseline,
      projectedSavings: 0, savingsFraction: 0, evaluatedTransitions }
  }
  return {
    boundaries,
    projectedCost,
    uncachedCost: baseline,
    projectedSavings,
    savingsFraction: baseline > 0 ? projectedSavings / baseline : 0,
    evaluatedTransitions,
  }
}

export * as CacheFrontierDP from "./cache-frontier-dp"
