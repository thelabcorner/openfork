/**
 * LACE v14.7 compaction-arm feasibility and one-call economics prototype.
 * No persistence, provider dispatch, background work, or tool side effects.
 * OpenFork V1 remains authoritative for compaction model selection and routing.
 */
export interface CompactionArm {
  readonly kind: "isolated" | "parent-prefix-fork"
  /** Trusted caller confirms actual route authorization. */
  readonly authorized: boolean
  readonly fitsContext: boolean
  readonly authorityPreserved: boolean
  readonly toolHistoryClosed: boolean
  readonly reasoningCompatible: boolean
  /** Required for a provider-cache-compatible parent-prefix fork. */
  readonly parentRouteCompatible: boolean
  readonly input: {
    readonly historicalTokens: number
    readonly newTokens: number
    /** Estimated actual hit conditional on identical parent prefix, not a guarantee. */
    readonly hitProbability: number
    readonly ordinaryPrice: number
    readonly cacheReadPrice: number
    readonly cacheMissPrice: number
  }
  readonly output: {
    readonly expectedTokens: number
    readonly price: number
  }
  readonly extraCost?: number
}

export interface CompactionChoice {
  readonly choice: CompactionArm["kind"] | "none"
  readonly estimatedCost: number | null
  readonly isolatedCost: number | null
  readonly forkCost: number | null
  readonly reason: string
}

function validNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(name + " must be finite and nonnegative")
}

export function estimateCompactionCost(arm: CompactionArm): number | undefined {
  for (const [name, value] of Object.entries(arm.input)) validNumber(value, "input." + name)
  for (const [name, value] of Object.entries(arm.output)) validNumber(value, "output." + name)
  validNumber(arm.extraCost ?? 0, "extraCost")
  if (arm.input.hitProbability > 1) throw new RangeError("hitProbability exceeds one")
  if (!arm.authorized || !arm.fitsContext || !arm.authorityPreserved ||
    !arm.toolHistoryClosed || !arm.reasoningCompatible) return undefined
  if (arm.kind === "parent-prefix-fork" && !arm.parentRouteCompatible) return undefined
  const rate = arm.input.hitProbability * arm.input.cacheReadPrice +
    (1 - arm.input.hitProbability) * arm.input.cacheMissPrice
  const cost = arm.input.historicalTokens * rate +
    arm.input.newTokens * arm.input.ordinaryPrice +
    arm.output.expectedTokens * arm.output.price + (arm.extraCost ?? 0)
  if (!Number.isFinite(cost)) throw new RangeError("estimated compaction cost overflowed")
  return cost
}

/**
 * Conservative: retain the existing isolated route unless the permitted fork
 * has a strictly meaningful economic advantage. This optimizer never changes
 * or chooses a model/account; the caller supplies already authorized arms.
 */
export function chooseCompactionArm(
  isolated: CompactionArm,
  fork: CompactionArm,
  minimumSaving = 0,
): CompactionChoice {
  if (isolated.kind !== "isolated" || fork.kind !== "parent-prefix-fork") {
    throw new TypeError("compaction arm kinds do not match their slots")
  }
  validNumber(minimumSaving, "minimumSaving")
  const isolatedCost = estimateCompactionCost(isolated)
  const forkCost = estimateCompactionCost(fork)
  if (isolatedCost === undefined && forkCost === undefined) {
    return { choice: "none", estimatedCost: null, isolatedCost: null, forkCost: null, reason: "no-compatible-strategy" }
  }
  if (isolatedCost === undefined) {
    return { choice: "parent-prefix-fork", estimatedCost: forkCost!, isolatedCost: null,
      forkCost: forkCost!, reason: "isolated-unavailable" }
  }
  if (forkCost !== undefined && isolatedCost - forkCost > minimumSaving) {
    return { choice: "parent-prefix-fork", estimatedCost: forkCost, isolatedCost,
      forkCost, reason: "measured-forecast-advantage" }
  }
  return { choice: "isolated", estimatedCost: isolatedCost, isolatedCost,
    forkCost: forkCost ?? null, reason: forkCost === undefined ? "fork-ineligible" : "no-meaningful-fork-advantage" }
}

export * as LaceCompactionPlan from "./lace-compaction-plan"
