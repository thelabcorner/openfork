import { Canonicalizer } from "./canonical"
import { DEFAULT_SPAD_CONFIG, validateConfig } from "./config"
import { ExpansionLane } from "./expansion-lane"
import { BoundedExactPeriodVerifier, DEFAULT_EXACT_PROOF_BUDGET } from "./exact-proof"
import { FormatTracker } from "./format-tracker"
import { PeriodLane, type LaneDetection } from "./period-lane"
import { ShingleVerifier } from "./shingle-verifier"
import type { PeriodDetection, SpadChannel, SpadConfig } from "./types"

export interface DetectorOptions {
  readonly channel: SpadChannel
  readonly config?: SpadConfig
  readonly recoveryMode?: boolean
  /**
   * Enable heuristic canonical/expansion lanes even on observe-only channels.
   * Defaults to true for visible text and false for reasoning. Raw exact
   * periodicity remains active on every channel for high-value diagnostics.
   */
  readonly observeHeuristicLanes?: boolean
}

export class SpadDetector {
  readonly channel: SpadChannel
  readonly config: SpadConfig
  private readonly raw: PeriodLane
  private readonly canonical: PeriodLane | undefined
  private readonly expansion: ExpansionLane | undefined
  private exactVerifier: BoundedExactPeriodVerifier | undefined
  private readonly canonicalizer: Canonicalizer | undefined
  private readonly format = new FormatTracker()
  private verifier: ShingleVerifier | undefined
  private readonly recoveryMode: boolean
  private readonly heuristicLanesEnabled: boolean
  private rawPosition = -1
  private rawLatched = false
  private canonicalLatched = false
  private expansionLatched = false

  constructor(options: DetectorOptions) {
    this.channel = options.channel
    this.config = options.config ?? DEFAULT_SPAD_CONFIG
    validateConfig(this.config)
    this.recoveryMode = options.recoveryMode ?? false
    this.heuristicLanesEnabled = options.observeHeuristicLanes ?? options.channel === "text"
    this.raw = new PeriodLane({ lane: "raw", ringSize: this.config.ringSize, anchorTableSize: this.config.anchorTableSize, qgram: this.config.qgram, maxPeriod: this.config.maxPeriod, maxCandidates: this.config.maxCandidates, bands: this.config.exactBands, coverageMultiplier: 1, exponentBonus: 0, storeRawPositions: false })
    if (this.heuristicLanesEnabled) {
      this.canonical = new PeriodLane({ lane: "canonical", ringSize: this.config.ringSize, anchorTableSize: this.config.anchorTableSize, qgram: this.config.qgram, maxPeriod: this.config.maxPeriod, maxCandidates: this.config.maxCandidates, bands: this.config.exactBands, coverageMultiplier: this.config.canonicalCoverageMultiplier, exponentBonus: this.config.canonicalExponentBonus, storeRawPositions: true })
      this.expansion = new ExpansionLane({ lane: "expansion", channel: options.channel, config: this.config, recoveryMode: this.recoveryMode })
      this.canonicalizer = new Canonicalizer()
    }
  }

  reset(): void {
    this.raw.reset(); this.canonical?.reset(); this.expansion?.reset(); this.canonicalizer?.reset(); this.format.reset()
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

  private materialize(d: LaneDetection): PeriodDetection | undefined {
    const source = d.lane === "raw" ? "raw-exact-period" : d.lane === "canonical" ? "canonical-period" : "expansion-heuristic"
    const result: PeriodDetection = { kind: "periodic-attractor", lane: d.lane, source, channel: this.channel, period: d.period, runStart: d.rawRunStart, runEnd: d.rawRunEnd, runLength: d.rawRunEnd - d.rawRunStart, exponent: d.exponent, agreement: 1, insideCodeFence: this.format.insideCodeFence }
    if (d.lane === "raw") {
      const stats = this.rawMotifStats(d)
      const runLength = d.laneRunEnd - d.laneRunStart
      const proofLength = Math.min(DEFAULT_EXACT_PROOF_BUDGET.maxSpan, this.raw.capacity, runLength)
      if (proofLength <= d.period) return undefined
      const proofStart = d.laneRunEnd - proofLength
      const proof = this.raw.proveExact(
        this.exactVerifier ??= new BoundedExactPeriodVerifier(),
        proofStart,
        proofLength,
        d.period,
      )
      // A failed independent terminal proof means the streaming candidate is
      // not allowed to escape as raw-exact evidence. Fail closed to continued
      // observation rather than trusting the proposal path.
      if (!proof.ok) return undefined
      return {
        ...result,
        motifDistinctAsciiLetters: stats.distinctLetters,
        motifHasNonAscii: stats.hasNonAscii,
        exactVerifiedSpan: proof.spanLength,
        exactMinimalPeriod: proof.minimalPeriod,
        exactPeriodComparisons: proof.periodComparisons,
        exactPrefixComparisons: proof.prefixComparisons,
      }
    }
    if (d.lane === "canonical") {
      if (!this.canonical) return undefined
      const maxWindow = 4096
      const start = Math.max(d.laneRunStart, d.laneRunEnd - maxWindow)
      return { ...result, canonicalDuplicate4GramRatio: (this.verifier ??= new ShingleVerifier()).duplicate4GramRatio((i) => this.canonical.get(i), start, d.laneRunEnd) }
    }
    return result
  }

  push(delta: string): PeriodDetection | undefined {
    let first: PeriodDetection | undefined
    // Fence state can only change on a backtick. Keep the current multiplier
    // in a local instead of re-reading config/fence state for every code unit.
    let multiplier = this.dynamicMultiplier()
    for (let i = 0; i < delta.length; i++) {
      const code = delta.charCodeAt(i)
      this.rawPosition++
      this.format.push(code)
      if (code === 96) multiplier = this.dynamicMultiplier()
      if (!this.rawLatched) {
        const rawDetection = this.raw.push(code, this.rawPosition, multiplier)
        if (rawDetection) {
          const materialized = this.materialize(rawDetection)
          if (materialized) {
            const lowLexical = materialized.motifHasNonAscii !== true && (materialized.motifDistinctAsciiLetters ?? 0) < this.config.lowLexicalDistinctLetters
            if (!lowLexical || materialized.runLength >= this.config.lowLexicalMinCoverage) {
              this.rawLatched = true
              first ??= materialized
            }
          }
        }
      }
      if (this.heuristicLanesEnabled) {
        const canonicalizer = this.canonicalizer!
        const canonicalLane = this.canonical!
        const expansionLane = this.expansion!
        const canonical = canonicalizer.push(code)
        if (canonical >= 0 && !this.canonicalLatched) {
          const canonicalDetection = canonicalLane.push(canonical, this.rawPosition, multiplier)
          if (canonicalDetection) {
            const materialized = this.materialize(canonicalDetection)
            if (materialized) {
              this.canonicalLatched = true
              first ??= materialized
            }
          }
        }
        // The expansion lane sees the raw code stream; it needs no periodicity
        // hypothesis and therefore no multiplier beyond recovery mode.
        if (!this.expansionLatched) {
          const expansionDetection = expansionLane.push(code)
          if (expansionDetection) {
            this.expansionLatched = true
            first ??= expansionDetection
          }
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
