import type { PeriodDetection, SpadChannel, SpadConfig } from "./types"

export interface ExpansionLaneOptions {
  readonly lane: "expansion"
  readonly channel: SpadChannel
  readonly config: SpadConfig
  readonly recoveryMode?: boolean
}

/**
 * Expansion-copy lane (dossier L3_EXPANDING_COPY_LOOP, §4.4).
 *
 * Catches the degeneration shape the periodicity lanes cannot see: the model
 * restates a growing block and appends a small amount of new content each
 * cycle ("A / A B / A B C / ..."). The repeat distance drifts upward, so no
 * fixed period ever confirms no matter how much of the stream is duplication.
 *
 * Signal: contiguous line-block recurrence, decoupled from any period
 * hypothesis. Each completed line is hashed (FNV-1a over its codes, signature
 * quantized so whitespace-only differences still match). The lane tracks the
 * longest suffix of the line history that contiguously matches an earlier
 * block. When that suffix match reaches `expansionMinLines` and this is the
 * `expansionMinCycles`-th such completion, the stream is restating earlier
 * content — the expanding-loop signature. Individual repeated lines (code
 * idioms, closing braces, template phrases) never sustain a contiguous block
 * match, which keeps real source code and varied prose below threshold.
 *
 * State is bounded: a fixed line-hash ring, one anchor position, and O(1)
 * per-line counters. No regex, no string building in the hot path.
 */
export class ExpansionLane {
  readonly lane = "expansion" as const
  readonly channel: SpadChannel
  private readonly config: SpadConfig
  private readonly recoveryMode: boolean
  private readonly ringSize: number
  private readonly minLines: number
  private readonly minCycles: number
  private readonly minStreamChars: number
  private readonly lines = new Uint32Array(8192)
  private lineCount = 0
  private lineHash = 0x811c9dc5 >>> 0
  private lineCodes = 0
  private position = -1
  /** Anchor in line history that the current line suffix matches against. */
  private anchor = -1
  /** Length of the current contiguous suffix match onto `anchor`. */
  private matchLen = 0
  private cycles = 0
  private cycleStart = -1
  private bestRatio = 0

  constructor(options: ExpansionLaneOptions) {
    this.channel = options.channel
    this.config = options.config
    this.recoveryMode = options.recoveryMode ?? false
    this.ringSize = this.lines.length
    this.minLines = options.config.expansionMinLines
    this.minCycles = options.config.expansionMinCycles
    this.minStreamChars = options.config.expansionMinStreamChars
  }

  reset(): void {
    this.lineCount = 0
    this.lineHash = 0x811c9dc5 >>> 0
    this.lineCodes = 0
    this.position = -1
    this.anchor = -1
    this.matchLen = 0
    this.cycles = 0
    this.cycleStart = -1
    this.bestRatio = 0
    this.lines.fill(0)
  }

  get length(): number {
    return this.position + 1
  }

  get duplicateRatio(): number {
    return this.bestRatio
  }

  /** Line signature: FNV over the codes, ignoring whitespace-only content. */
  private lineSignature(hash: number, codes: number): number {
    return (Math.imul(hash ^ codes, 0x01000193) + codes) >>> 0
  }

  /** Find the most recent earlier line equal to `hash`, or -1. Excludes the line just stored. */
  private previousOccurrence(hash: number): number {
    const cap = Math.min(this.lineCount - 1, this.ringSize - 1)
    for (let i = cap - 1; i >= 0; i--) {
      if (this.lines[i] === hash) return i
    }
    return -1
  }

  private closeLine(hash: number): PeriodDetection | undefined {
    this.lines[this.lineCount % this.ringSize] = hash
    this.lineCount++

    if (this.anchor >= 0 && this.matchLen > 0) {
      // The expected line must strictly predate the line just stored; without
      // this guard the match window catches up to the write head and every
      // line trivially matches itself.
      const expectedIndex = this.anchor + this.matchLen
      if (expectedIndex < this.lineCount - 1) {
        const expected = this.lines[expectedIndex % this.ringSize]
        if (expected === hash) {
          this.matchLen++
          // Count each contiguous match run once, at the moment it first reaches
          // minLines; a second such run is the restatement signature.
          if (this.matchLen === this.minLines) {
            this.cycles++
            this.bestRatio = this.matchLen / Math.max(1, this.lineCount)
            const requiredCycles = Math.max(1, this.minCycles - (this.recoveryMode ? 1 : 0))
            if (this.cycles > requiredCycles && this.length >= this.minStreamChars) return this.detect()
          }
          return undefined
        }
      }
    }
    // No continuation: re-anchor on the most recent earlier occurrence of this
    // line so a fresh restatement immediately re-establishes the match.
    this.anchor = this.previousOccurrence(hash)
    this.matchLen = this.anchor >= 0 ? 1 : 0
    if (this.matchLen === 1 && this.cycleStart < 0) this.cycleStart = this.lineCount - 1
    return undefined
  }

  private detect(): PeriodDetection {
    const runStartLine = Math.max(0, this.cycleStart)
    const runStart = Math.floor((runStartLine / Math.max(1, this.lineCount)) * Math.max(1, this.length))
    this.cycles = 0
    return {
      kind: "periodic-attractor",
      lane: "expansion",
      channel: this.channel,
      period: 0,
      runStart,
      runEnd: this.position + 1,
      runLength: this.position + 1 - runStart,
      exponent: this.matchLen,
      agreement: 1,
      insideCodeFence: false,
      expansionDuplicateRatio: this.bestRatio,
    }
  }

  push(code: number): PeriodDetection | undefined {
    this.position++
    // Whitespace codes do not break the line but are folded coarsely so
    // indentation differences still produce matching signatures.
    if (code === 10) {
      const hash = this.lineSignature(this.lineHash, this.lineCodes)
      this.lineHash = 0x811c9dc5 >>> 0
      this.lineCodes = 0
      return this.closeLine(hash)
    }
    if (code !== 13 && code !== 32 && code !== 9) {
      this.lineHash = Math.imul(this.lineHash ^ code, 0x01000193) >>> 0
      this.lineCodes++
    }
    return undefined
  }
}
