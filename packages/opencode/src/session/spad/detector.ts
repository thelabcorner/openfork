import { Canonicalizer } from "./canonical"
import { DEFAULT_SPAD_CONFIG, validateConfig } from "./config"
import { ExpansionLane } from "./expansion-lane"
import { FormatTracker } from "./format-tracker"
import { PeriodLane, type LaneDetection } from "./period-lane"
import { ShingleVerifier } from "./shingle-verifier"
import type { PeriodDetection, SpadChannel, SpadConfig } from "./types"

export interface DetectorOptions {
  readonly channel: SpadChannel
  readonly config?: SpadConfig
  readonly recoveryMode?: boolean
}

export class SpadDetector {
  readonly channel: SpadChannel
  readonly config: SpadConfig
  private readonly raw: PeriodLane
  private readonly canonical: PeriodLane
  private readonly expansion: ExpansionLane
  private readonly canonicalizer = new Canonicalizer()
  private readonly format = new FormatTracker()
  private verifier: ShingleVerifier | undefined
  private readonly recoveryMode: boolean
  private rawPosition = -1
  private rawLatched = false
  private canonicalLatched = false
  private expansionLatched = false

  constructor(options: DetectorOptions) {
    this.channel = options.channel
    this.config = options.config ?? DEFAULT_SPAD_CONFIG
    validateConfig(this.config)
    this.recoveryMode = options.recoveryMode ?? false
    this.raw = new PeriodLane({ lane: "raw", ringSize: this.config.ringSize, anchorTableSize: this.config.anchorTableSize, qgram: this.config.qgram, maxPeriod: this.config.maxPeriod, maxCandidates: this.config.maxCandidates, bands: this.config.exactBands, coverageMultiplier: 1, exponentBonus: 0, storeRawPositions: false })
    this.canonical = new PeriodLane({ lane: "canonical", ringSize: this.config.ringSize, anchorTableSize: this.config.anchorTableSize, qgram: this.config.qgram, maxPeriod: this.config.maxPeriod, maxCandidates: this.config.maxCandidates, bands: this.config.exactBands, coverageMultiplier: this.config.canonicalCoverageMultiplier, exponentBonus: this.config.canonicalExponentBonus, storeRawPositions: true })
    this.expansion = new ExpansionLane({ lane: "expansion", channel: options.channel, config: this.config, recoveryMode: this.recoveryMode })
  }

  reset(): void {
    this.raw.reset(); this.canonical.reset(); this.expansion.reset(); this.canonicalizer.reset(); this.format.reset()
    this.rawPosition = -1; this.rawLatched = false; this.canonicalLatched = false; this.expansionLatched = false
  }

  get length(): number { return this.rawPosition + 1 }

  private dynamicMultiplier(): number {
    let value = this.format.insideCodeFence ? this.config.codeFenceCoverageMultiplier : 1
    if (this.recoveryMode) value *= this.config.recoveryThresholdMultiplier
    return value
  }

  private rawMotifStats(d: LaneDetection): { distinctLetters: number; hasNonAscii: boolean } {
    let lo = 0 >>> 0
    let hasNonAscii = false
    const start = d.laneRunEnd - d.period
    for (let i = 0; i < d.period; i++) {
      const c = this.raw.get(start + i)
      if (c >= 65 && c <= 90) lo |= 1 << (c - 65)
      else if (c >= 97 && c <= 122) lo |= 1 << (c - 97)
      else if (c > 127) hasNonAscii = true
    }
    let x = lo >>> 0
    x = x - ((x >>> 1) & 0x55555555)
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
    const distinctLetters = (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
    return { distinctLetters, hasNonAscii }
  }

  private materialize(d: LaneDetection): PeriodDetection {
    const result: PeriodDetection = { kind: "periodic-attractor", lane: d.lane, channel: this.channel, period: d.period, runStart: d.rawRunStart, runEnd: d.rawRunEnd, runLength: d.rawRunEnd - d.rawRunStart, exponent: d.exponent, agreement: 1, insideCodeFence: this.format.insideCodeFence }
    if (d.lane === "raw") {
      const stats = this.rawMotifStats(d)
      return { ...result, motifDistinctAsciiLetters: stats.distinctLetters, motifHasNonAscii: stats.hasNonAscii }
    }
    if (d.lane === "canonical") {
      const maxWindow = 4096
      const start = Math.max(d.laneRunStart, d.laneRunEnd - maxWindow)
      return { ...result, canonicalDuplicate4GramRatio: (this.verifier ??= new ShingleVerifier()).duplicate4GramRatio((i) => this.canonical.get(i), start, d.laneRunEnd) }
    }
    return result
  }

  push(delta: string): PeriodDetection | undefined {
    let first: PeriodDetection | undefined
    for (let i = 0; i < delta.length; i++) {
      const code = delta.charCodeAt(i)
      this.rawPosition++
      this.format.push(code)
      const multiplier = this.dynamicMultiplier()
      if (!this.rawLatched) {
        const rawDetection = this.raw.push(code, this.rawPosition, multiplier)
        if (rawDetection) {
          const materialized = this.materialize(rawDetection)
          const lowLexical = materialized.motifHasNonAscii !== true && (materialized.motifDistinctAsciiLetters ?? 0) < this.config.lowLexicalDistinctLetters
          if (!lowLexical || materialized.runLength >= this.config.lowLexicalMinCoverage) {
            this.rawLatched = true
            first ??= materialized
          }
        }
      }
      const canonical = this.canonicalizer.push(code)
      if (canonical >= 0 && !this.canonicalLatched) {
        const canonicalDetection = this.canonical.push(canonical, this.rawPosition, multiplier)
        if (canonicalDetection) {
          this.canonicalLatched = true
          first ??= this.materialize(canonicalDetection)
        }
      }
      // The expansion lane sees the raw code stream; it needs no periodicity
      // hypothesis and therefore no multiplier beyond recovery mode.
      if (!this.expansionLatched) {
        const expansionDetection = this.expansion.push(code)
        if (expansionDetection) {
          this.expansionLatched = true
          first ??= expansionDetection
        }
      }
    }
    return first
  }

  extractMotif(detection: PeriodDetection): Uint16Array | undefined {
    if (detection.lane !== "raw" || detection.runStart < 0 || detection.period <= 0) return undefined
    return this.raw.extract(detection.runStart, detection.period)
  }
}
