export interface ExactProofBudget {
  /** Hard upper bound on materialized symbols accepted by one proof. */
  readonly maxSpan: number
}

export interface ExactPeriodProof {
  readonly ok: true
  readonly proposedPeriod: number
  readonly minimalPeriod: number
  readonly spanLength: number
  readonly exponent: number
  readonly isFullPower: boolean
  readonly periodComparisons: number
  readonly prefixComparisons: number
}

export interface ExactPeriodRejection {
  readonly ok: false
  readonly reason: "empty-span" | "invalid-period" | "span-limit" | "period-mismatch"
  readonly periodComparisons: number
  readonly prefixComparisons: 0
}

export type ExactPeriodProofResult = ExactPeriodProof | ExactPeriodRejection

export type ExactCandidateVerification =
  | { readonly ok: true; readonly proposedPeriod: number; readonly spanLength: number; readonly periodComparisons: number }
  | {
      readonly ok: false
      readonly reason: "empty-span" | "invalid-period" | "span-limit" | "period-mismatch"
      readonly periodComparisons: number
    }

export const DEFAULT_EXACT_PROOF_BUDGET: ExactProofBudget = Object.freeze({ maxSpan: 8192 })

/**
 * Cheap terminal/checkpoint proof for one proposed exact period. This is the
 * hot-path primitive: one bounded comparison pass, no prefix scratch and no
 * normalization/hash assumptions. Minimal-period analysis can be deferred
 * until an actual terminal detection needs richer metadata.
 */
export function verifyExactPeriodCandidate(
  span: Uint16Array,
  proposedPeriod: number,
  budget: ExactProofBudget = DEFAULT_EXACT_PROOF_BUDGET,
): ExactCandidateVerification {
  const n = span.length
  if (n === 0) return { ok: false, reason: "empty-span", periodComparisons: 0 }
  if (!Number.isInteger(proposedPeriod) || proposedPeriod <= 0 || proposedPeriod >= n)
    return { ok: false, reason: "invalid-period", periodComparisons: 0 }
  if (n > budget.maxSpan) return { ok: false, reason: "span-limit", periodComparisons: 0 }

  let periodComparisons = 0
  for (let i = proposedPeriod; i < n; i++) {
    periodComparisons++
    if (span[i] !== span[i - proposedPeriod]) return { ok: false, reason: "period-mismatch", periodComparisons }
  }
  return { ok: true, proposedPeriod, spanLength: n, periodComparisons }
}

function prefixFunctionInto(input: Uint16Array, pi: Int32Array): number {
  pi[0] = 0
  let comparisons = 0
  for (let i = 1; i < input.length; i++) {
    let j = pi[i - 1]!
    while (j > 0) {
      comparisons++
      if (input[i] === input[j]) break
      j = pi[j - 1]!
    }
    if (j === 0) {
      comparisons++
      if (input[i] === input[0]) j = 1
    } else {
      // The successful comparison was already counted by the loop above.
      j++
    }
    pi[i] = j
  }
  return comparisons
}

function prefixFunctionRing(
  ring: Uint16Array,
  ringMask: number,
  start: number,
  length: number,
  pi: Int32Array,
): number {
  pi[0] = 0
  let comparisons = 0
  for (let i = 1; i < length; i++) {
    let j = pi[i - 1]!
    const current = ring[(start + i) & ringMask]!
    while (j > 0) {
      comparisons++
      if (current === ring[(start + j) & ringMask]!) break
      j = pi[j - 1]!
    }
    if (j === 0) {
      comparisons++
      if (current === ring[start & ringMask]!) j = 1
    } else {
      j++
    }
    pi[i] = j
  }
  return comparisons
}

export class BoundedExactPeriodVerifier {
  private readonly pi: Int32Array
  readonly budget: ExactProofBudget

  constructor(budget: ExactProofBudget = DEFAULT_EXACT_PROOF_BUDGET) {
    if (!Number.isInteger(budget.maxSpan) || budget.maxSpan < 2) throw new Error("exact proof maxSpan must be an integer >= 2")
    this.budget = Object.freeze({ maxSpan: budget.maxSpan })
    this.pi = new Int32Array(budget.maxSpan)
  }

  prove(span: Uint16Array, proposedPeriod: number): ExactPeriodProofResult {
    const candidate = verifyExactPeriodCandidate(span, proposedPeriod, this.budget)
    if (!candidate.ok) return { ...candidate, prefixComparisons: 0 }
    const n = span.length
    const periodComparisons = candidate.periodComparisons

    const prefixComparisons = prefixFunctionInto(span, this.pi)
    const minimalPeriod = n - this.pi[n - 1]!
    return {
      ok: true,
      proposedPeriod,
      minimalPeriod,
      spanLength: n,
      exponent: n / minimalPeriod,
      isFullPower: minimalPeriod < n && n % minimalPeriod === 0,
      periodComparisons,
      prefixComparisons,
    }
  }

  /**
   * Prove an exact period directly over a power-of-two circular buffer.
   * This is semantically identical to `prove()` but avoids materializing the
   * bounded terminal span into a temporary Uint16Array when the source already
   * lives in SPAD's ring.
   */
  proveRing(
    ring: Uint16Array,
    ringMask: number,
    start: number,
    spanLength: number,
    proposedPeriod: number,
  ): ExactPeriodProofResult {
    if (spanLength === 0) return { ok: false, reason: "empty-span", periodComparisons: 0, prefixComparisons: 0 }
    if (!Number.isInteger(proposedPeriod) || proposedPeriod <= 0 || proposedPeriod >= spanLength)
      return { ok: false, reason: "invalid-period", periodComparisons: 0, prefixComparisons: 0 }
    if (spanLength > this.budget.maxSpan || spanLength > ring.length)
      return { ok: false, reason: "span-limit", periodComparisons: 0, prefixComparisons: 0 }
    if (ringMask !== ring.length - 1 || (ring.length & ringMask) !== 0)
      throw new Error("exact ring proof requires a power-of-two ring and length-1 mask")

    let periodComparisons = 0
    for (let i = proposedPeriod; i < spanLength; i++) {
      periodComparisons++
      if (ring[(start + i) & ringMask] !== ring[(start + i - proposedPeriod) & ringMask])
        return { ok: false, reason: "period-mismatch", periodComparisons, prefixComparisons: 0 }
    }

    const prefixComparisons = prefixFunctionRing(ring, ringMask, start, spanLength, this.pi)
    const minimalPeriod = spanLength - this.pi[spanLength - 1]!
    return {
      ok: true,
      proposedPeriod,
      minimalPeriod,
      spanLength,
      exponent: spanLength / minimalPeriod,
      isFullPower: minimalPeriod < spanLength && spanLength % minimalPeriod === 0,
      periodComparisons,
      prefixComparisons,
    }
  }
}

/**
 * Deterministically prove an exact period over one already-bounded raw span.
 *
 * This function deliberately performs no hashing, normalization, allocation
 * proportional to an unbounded generation, or suffix discovery. It is a proof
 * primitive for candidate spans proposed elsewhere.
 */
export function proveExactPeriod(
  span: Uint16Array,
  proposedPeriod: number,
  budget: ExactProofBudget = DEFAULT_EXACT_PROOF_BUDGET,
): ExactPeriodProofResult {
  return new BoundedExactPeriodVerifier(budget).prove(span, proposedPeriod)
}

export function gcd(a: number, b: number): number {
  a = Math.abs(Math.trunc(a))
  b = Math.abs(Math.trunc(b))
  while (b !== 0) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

/** Fine-Wilf's exact common-span length precondition. */
export function fineWilfThreshold(p: number, q: number): number {
  if (!Number.isInteger(p) || !Number.isInteger(q) || p <= 0 || q <= 0) return Number.POSITIVE_INFINITY
  return p + q - gcd(p, q)
}

/**
 * Booth-style lexicographically minimal cyclic rotation. Used only for motif
 * identity/telemetry after a proof, never as evidence of periodicity itself.
 */
export function minimalRotation(input: Uint16Array): Uint16Array {
  const n = input.length
  if (n <= 1) return input.slice()
  let i = 0
  let j = 1
  let k = 0
  while (i < n && j < n && k < n) {
    const a = input[(i + k) % n]!
    const b = input[(j + k) % n]!
    if (a === b) {
      k++
      continue
    }
    if (a > b) {
      i = i + k + 1
      if (i === j) i++
    } else {
      j = j + k + 1
      if (i === j) j++
    }
    k = 0
  }
  const start = Math.min(i, j)
  const out = new Uint16Array(n)
  for (let x = 0; x < n; x++) out[x] = input[(start + x) % n]!
  return out
}

/** Canonical cyclic identity of the proven span's minimal-period motif. */
export function canonicalMotif(span: Uint16Array, proof: ExactPeriodProof): Uint16Array {
  return minimalRotation(span.slice(0, proof.minimalPeriod))
}
