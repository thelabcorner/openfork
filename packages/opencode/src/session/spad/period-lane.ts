import type { PeriodThresholdBand, SpadLane } from "./types"

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
  private readonly candPeriod: Int32Array
  private readonly candMatched: Int32Array
  private readonly candRelationStart: Int32Array
  private readonly candMinCoverage: Int32Array
  private readonly candMinExponent: Float64Array
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
    this.candPeriod = new Int32Array(options.maxCandidates)
    this.candMatched = new Int32Array(options.maxCandidates)
    this.candRelationStart = new Int32Array(options.maxCandidates)
    this.candMinCoverage = new Int32Array(options.maxCandidates)
    this.candMinExponent = new Float64Array(options.maxCandidates)
  }

  reset(): void {
    this.position = -1
    this.rollingHash = 0
    this.symbolsInHash = 0
    this.anchorsHash.fill(0)
    this.anchorsPos.fill(0)
    this.candPeriod.fill(0)
    this.candMatched.fill(0)
    this.candRelationStart.fill(0)
    this.candMinCoverage.fill(0)
    this.candMinExponent.fill(0)
  }

  get length(): number { return this.position + 1 }
  get(index: number): number { return this.ring[index & this.ringMask]! }
  rawPosition(index: number): number { return this.rawPositions ? this.rawPositions[index & this.ringMask]! : index }

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
    for (let i = 0; i < this.qgram; i++) if (this.get(currentStart + i) !== this.get(previousStart + i)) return false
    return true
  }

  private addCandidate(period: number, relationStart: number): void {
    for (let i = 0; i < this.candPeriod.length; i++) if (this.candPeriod[i] === period) return
    let slot = -1
    let weakest = 0
    let weakestMatched = Number.POSITIVE_INFINITY
    for (let i = 0; i < this.candPeriod.length; i++) {
      if (this.candPeriod[i] === 0) { slot = i; break }
      const matched = this.candMatched[i]!
      if (matched < weakestMatched) { weakestMatched = matched; weakest = i }
    }
    if (slot < 0) slot = weakest
    const band = this.threshold(period)
    this.candPeriod[slot] = period
    this.candMatched[slot] = this.qgram
    this.candRelationStart[slot] = relationStart
    this.candMinCoverage[slot] = Math.ceil(band.minCoverage * this.coverageMultiplier)
    this.candMinExponent[slot] = band.minExponent + this.exponentBonus
  }

  private maybeConfirm(slot: number, dynamicCoverageMultiplier: number): LaneDetection | undefined {
    const period = this.candPeriod[slot]!
    if (period === 0) return undefined
    const matched = this.candMatched[slot]!
    const coverage = period + matched
    const minCoverage = Math.ceil(this.candMinCoverage[slot]! * dynamicCoverageMultiplier)
    const minExponent = this.candMinExponent[slot]!
    if (coverage < minCoverage || coverage / period < minExponent) return undefined
    let relationStart = this.candRelationStart[slot]!
    const oldest = Math.max(0, this.position - this.ring.length + 1)
    while (relationStart - 1 - period >= oldest) {
      if (this.get(relationStart - 1) !== this.get(relationStart - 1 - period)) break
      relationStart--
    }
    const laneRunStart = relationStart - period
    const laneRunEnd = this.position + 1
    const exactCoverage = laneRunEnd - laneRunStart
    const rawRunStart = this.rawPosition(laneRunStart)
    const rawRunEnd = this.rawPosition(laneRunEnd - 1) + 1
    return { lane: this.lane, period, laneRunStart, laneRunEnd, rawRunStart, rawRunEnd, exponent: exactCoverage / period }
  }

  push(code: number, rawPosition: number, dynamicCoverageMultiplier = 1): LaneDetection | undefined {
    this.position++
    const pos = this.position
    this.ring[pos & this.ringMask] = code
    if (this.rawPositions) this.rawPositions[pos & this.ringMask] = rawPosition >>> 0
    for (let i = 0; i < this.candPeriod.length; i++) {
      const period = this.candPeriod[i]!
      if (period === 0) continue
      const relationStart = this.candRelationStart[i]!
      if (pos < relationStart + this.qgram) continue
      if (this.get(pos) !== this.get(pos - period)) { this.candPeriod[i] = 0; this.candMatched[i] = 0; continue }
      this.candMatched[i] = this.candMatched[i]! + 1
      const detection = this.maybeConfirm(i, dynamicCoverageMultiplier)
      if (detection) return detection
    }
    if (this.symbolsInHash < this.qgram) {
      this.rollingHash = (Math.imul(this.rollingHash, HASH_BASE) + code + 1) >>> 0
      this.symbolsInHash++
      if (this.symbolsInHash < this.qgram) return undefined
    } else {
      const outgoing = this.get(pos - this.qgram)
      const removed = Math.imul(outgoing + 1, this.qPow) >>> 0
      this.rollingHash = (Math.imul((this.rollingHash - removed) >>> 0, HASH_BASE) + code + 1) >>> 0
    }
    const mixed = (this.rollingHash ^ (this.rollingHash >>> 16)) >>> 0
    const slot = mixed & this.anchorMask
    const previousStored = this.anchorsPos[slot]!
    const previousEnd = previousStored - 1
    if (previousStored !== 0 && this.anchorsHash[slot] === this.rollingHash) {
      const period = pos - previousEnd
      if (period >= 1 && period <= this.maxPeriod) {
        const currentStart = pos - this.qgram + 1
        const previousStart = currentStart - period
        const oldest = Math.max(0, pos - this.ring.length + 1)
        if (previousStart >= oldest && this.exactQgramMatch(currentStart, previousStart)) this.addCandidate(period, currentStart)
      }
    }
    this.anchorsHash[slot] = this.rollingHash
    this.anchorsPos[slot] = pos + 1
    return undefined
  }
}
