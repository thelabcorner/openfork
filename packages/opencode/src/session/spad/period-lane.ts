import type { PeriodThresholdBand, SpadLane } from "./types"
import type { BoundedExactPeriodVerifier, ExactPeriodProofResult } from "./exact-proof"

export interface LaneDetection {
  readonly lane: SpadLane
  readonly period: number
  readonly laneRunStart: number
  readonly laneRunEnd: number
  readonly rawRunStart: number
  readonly rawRunEnd: number
  readonly exponent: number
}

export interface PeriodLaneOptions {
  readonly lane: SpadLane
  readonly ringSize: number
  readonly anchorTableSize: number
  readonly qgram: number
  readonly maxPeriod: number
  readonly maxCandidates: number
  readonly bands: readonly PeriodThresholdBand[]
  readonly coverageMultiplier: number
  readonly exponentBonus: number
  readonly storeRawPositions: boolean
  /** Optional benchmark/telemetry counters. Omit on the production hot path. */
  readonly stats?: PeriodLaneStats
}

export interface PeriodLaneStats {
  pushes: number
  candidateComparisons: number
  candidateMismatches: number
  rollingHashMatches: number
  exactQgramChecks: number
  exactQgramComparisons: number
  candidatesAdded: number
  thresholdPasses: number
  extensionComparisons: number
  confirmations: number
}

export function createPeriodLaneStats(): PeriodLaneStats {
  return {
    pushes: 0,
    candidateComparisons: 0,
    candidateMismatches: 0,
    rollingHashMatches: 0,
    exactQgramChecks: 0,
    exactQgramComparisons: 0,
    candidatesAdded: 0,
    thresholdPasses: 0,
    extensionComparisons: 0,
    confirmations: 0,
  }
}

const HASH_BASE = 0x9e3779b1 >>> 0

function pow32(base: number, exp: number): number {
  let out = 1 >>> 0
  for (let i = 0; i < exp; i++) out = Math.imul(out, base) >>> 0
  return out
}

export class PeriodLane {
  private readonly lane: SpadLane
  private readonly ring: Uint16Array
  private readonly rawPositions: Uint32Array | undefined
  private readonly ringMask: number
  private readonly anchorsHash: Uint32Array
  private readonly anchorsPos: Int32Array
  private readonly anchorMask: number
  private readonly qgram: number
  private readonly qPow: number
  private readonly maxPeriod: number
  private readonly bands: readonly PeriodThresholdBand[]
  private readonly coverageMultiplier: number
  private readonly exponentBonus: number
  private readonly stats: PeriodLaneStats | undefined
  private readonly candPeriod: Int32Array
  private readonly candMatched: Int32Array
  private readonly candRelationStart: Int32Array
  private readonly candMinCoverage: Int32Array
  /** Integer coverage needed to satisfy the exponent floor exactly. */
  private readonly candMinExponentCoverage: Int32Array
  /** Candidate slots are kept compact in [0, activeCandidates). */
  private activeCandidates = 0
  private position = -1
  private rollingHash = 0 >>> 0
  private symbolsInHash = 0

  constructor(options: PeriodLaneOptions) {
    this.lane = options.lane
    this.ring = new Uint16Array(options.ringSize)
    this.rawPositions = options.storeRawPositions ? new Uint32Array(options.ringSize) : undefined
    this.ringMask = options.ringSize - 1
    this.anchorsHash = new Uint32Array(options.anchorTableSize)
    this.anchorsPos = new Int32Array(options.anchorTableSize)
    this.anchorMask = options.anchorTableSize - 1
    this.qgram = options.qgram
    this.qPow = pow32(HASH_BASE, options.qgram - 1)
    this.maxPeriod = options.maxPeriod
    this.bands = options.bands
    this.coverageMultiplier = options.coverageMultiplier
    this.exponentBonus = options.exponentBonus
    this.stats = options.stats
    this.candPeriod = new Int32Array(options.maxCandidates)
    this.candMatched = new Int32Array(options.maxCandidates)
    this.candRelationStart = new Int32Array(options.maxCandidates)
    this.candMinCoverage = new Int32Array(options.maxCandidates)
    this.candMinExponentCoverage = new Int32Array(options.maxCandidates)
  }

  reset(): void {
    this.position = -1
    this.rollingHash = 0
    this.symbolsInHash = 0
    this.activeCandidates = 0
    this.anchorsHash.fill(0)
    this.anchorsPos.fill(0)
  }

  get length(): number { return this.position + 1 }
  get capacity(): number { return this.ring.length }
  get(index: number): number { return this.ring[index & this.ringMask]! }
  rawPosition(index: number): number { return this.rawPositions ? this.rawPositions[index & this.ringMask]! : index }

  proveExact(
    verifier: BoundedExactPeriodVerifier,
    start: number,
    length: number,
    period: number,
  ): ExactPeriodProofResult {
    return verifier.proveRing(this.ring, this.ringMask, start, length, period)
  }

  extract(start: number, length: number, maxLength = length): Uint16Array {
    const n = Math.max(0, Math.min(length, maxLength))
    const out = new Uint16Array(n)
    for (let i = 0; i < n; i++) out[i] = this.get(start + i)
    return out
  }

  private threshold(period: number): PeriodThresholdBand {
    for (const band of this.bands) if (period <= band.maxPeriod) return band
    return this.bands[this.bands.length - 1]!
  }

  private exactQgramMatch(currentStart: number, previousStart: number): boolean {
    if (this.stats) this.stats.exactQgramChecks++
    for (let i = 0; i < this.qgram; i++) {
      if (this.stats) this.stats.exactQgramComparisons++
      if (this.get(currentStart + i) !== this.get(previousStart + i)) return false
    }
    return true
  }

  private addCandidate(period: number, relationStart: number): void {
    let slot: number
    if (this.activeCandidates < this.candPeriod.length) {
      slot = this.activeCandidates++
    } else {
      slot = 0
      let weakestMatched = this.candMatched[0]!
      for (let i = 1; i < this.activeCandidates; i++) {
        const matched = this.candMatched[i]!
        if (matched < weakestMatched) { weakestMatched = matched; slot = i }
      }
    }
    if (this.stats) this.stats.candidatesAdded++
    const band = this.threshold(period)
    this.candPeriod[slot] = period
    this.candMatched[slot] = this.qgram
    this.candRelationStart[slot] = relationStart
    this.candMinCoverage[slot] = Math.ceil(band.minCoverage * this.coverageMultiplier)
    this.candMinExponentCoverage[slot] = Math.ceil(period * (band.minExponent + this.exponentBonus))
  }

  /** Remove one active slot while preserving candidate priority/order. */
  private removeCandidate(slot: number): void {
    const last = this.activeCandidates - 1
    for (let i = slot; i < last; i++) {
      this.candPeriod[i] = this.candPeriod[i + 1]!
      this.candMatched[i] = this.candMatched[i + 1]!
      this.candRelationStart[i] = this.candRelationStart[i + 1]!
      this.candMinCoverage[i] = this.candMinCoverage[i + 1]!
      this.candMinExponentCoverage[i] = this.candMinExponentCoverage[i + 1]!
    }
    this.activeCandidates = last
  }

  private maybeConfirm(slot: number, dynamicCoverageMultiplier: number): LaneDetection | undefined {
    const period = this.candPeriod[slot]!
    if (period === 0) return undefined
    const matched = this.candMatched[slot]!
    const coverage = period + matched
    const baseCoverage = this.candMinCoverage[slot]!
    const minCoverage = dynamicCoverageMultiplier === 1
      ? baseCoverage
      : Math.ceil(baseCoverage * dynamicCoverageMultiplier)
    if (coverage < minCoverage || coverage < this.candMinExponentCoverage[slot]!) return undefined
    if (this.stats) this.stats.thresholdPasses++
    let relationStart = this.candRelationStart[slot]!
    const oldest = Math.max(0, this.position - this.ring.length + 1)
    while (relationStart - 1 - period >= oldest) {
      if (this.stats) this.stats.extensionComparisons++
      if (this.get(relationStart - 1) !== this.get(relationStart - 1 - period)) break
      relationStart--
    }
    const laneRunStart = relationStart - period
    const laneRunEnd = this.position + 1
    const exactCoverage = laneRunEnd - laneRunStart
    const rawRunStart = this.rawPosition(laneRunStart)
    const rawRunEnd = this.rawPosition(laneRunEnd - 1) + 1
    if (this.stats) this.stats.confirmations++
    return { lane: this.lane, period, laneRunStart, laneRunEnd, rawRunStart, rawRunEnd, exponent: exactCoverage / period }
  }

  push(code: number, rawPosition: number, dynamicCoverageMultiplier = 1): LaneDetection | undefined {
    if (this.stats) this.stats.pushes++
    this.position++
    const pos = this.position
    this.ring[pos & this.ringMask] = code
    if (this.rawPositions) this.rawPositions[pos & this.ringMask] = rawPosition >>> 0
    for (let i = 0; i < this.activeCandidates;) {
      const period = this.candPeriod[i]!
      const relationStart = this.candRelationStart[i]!
      if (pos < relationStart + this.qgram) { i++; continue }
      if (this.stats) this.stats.candidateComparisons++
      // `code` was just written at `pos`; avoid rereading the current symbol
      // through the ring accessor on every active-candidate comparison.
      if (code !== this.ring[(pos - period) & this.ringMask]!) {
        if (this.stats) this.stats.candidateMismatches++
        this.removeCandidate(i)
        continue
      }
      this.candMatched[i] = this.candMatched[i]! + 1
      const detection = this.maybeConfirm(i, dynamicCoverageMultiplier)
      if (detection) return detection
      i++
    }
    if (this.symbolsInHash < this.qgram) {
      this.rollingHash = (Math.imul(this.rollingHash, HASH_BASE) + code + 1) >>> 0
      this.symbolsInHash++
      if (this.symbolsInHash < this.qgram) return undefined
    } else {
      const outgoing = this.ring[(pos - this.qgram) & this.ringMask]!
      const removed = Math.imul(outgoing + 1, this.qPow) >>> 0
      this.rollingHash = (Math.imul((this.rollingHash - removed) >>> 0, HASH_BASE) + code + 1) >>> 0
    }
    const mixed = (this.rollingHash ^ (this.rollingHash >>> 16)) >>> 0
    const slot = mixed & this.anchorMask
    const previousStored = this.anchorsPos[slot]!
    const previousEnd = previousStored - 1
    if (previousStored !== 0 && this.anchorsHash[slot] === this.rollingHash) {
      if (this.stats) this.stats.rollingHashMatches++
      const period = pos - previousEnd
      if (period >= 1 && period <= this.maxPeriod) {
        const currentStart = pos - this.qgram + 1
        const previousStart = currentStart - period
        const oldest = Math.max(0, pos - this.ring.length + 1)
        if (previousStart >= oldest) {
          let duplicate = false
          for (let i = 0; i < this.activeCandidates; i++) {
            if (this.candPeriod[i] === period) { duplicate = true; break }
          }
          // Exact verification is necessary only when admitting a new period.
          // Repeated anchor hits for an already-active period contribute no new
          // evidence and used to dominate q-gram verification cost on structured
          // output. Fresh candidates remain collision-free.
          if (!duplicate && this.exactQgramMatch(currentStart, previousStart))
            this.addCandidate(period, currentStart)
        }
      }
    }
    this.anchorsHash[slot] = this.rollingHash
    this.anchorsPos[slot] = pos + 1
    return undefined
  }
}
