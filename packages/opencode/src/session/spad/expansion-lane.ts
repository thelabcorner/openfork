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
 * Signal: contiguous line-block recurrence with *strict growth*. Each
 * completed line is hashed (FNV-1a over its non-whitespace codes). A candidate
 * cycle is a contiguous block that matches an earlier block for at least
 * `expansionMinLines`. Subsequent cycles only reinforce the same expansion
 * series when they begin with the same line signature and their matched block
 * is strictly longer than the previous cycle. This is the actual A / AB / ABC
 * invariant; unrelated fixed repeated blocks must not accumulate evidence.
 *
 * State is bounded: a fixed line-hash ring, absolute line ids, a bounded map of
 * most-recent line signatures, one active anchor, and O(1)-average per-line
 * work. No regex and no string building in the hot path.
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
  private readonly lineStarts = new Uint32Array(8192)
  private readonly lineIds = new Int32Array(8192)
  private readonly anchorHashes: Uint32Array
  private readonly anchorPositions: Int32Array
  private readonly anchorMask: number
  private lineCount = 0
  private lineHash = 0x811c9dc5 >>> 0
  private lineCodes = 0
  private lineStartPosition = 0
  private position = -1
  /** Absolute earlier line id that the current contiguous run matches against. */
  private anchor = -1
  /** Absolute first line id of the active matching run. */
  private matchStart = -1
  /** Length of the active contiguous match onto `anchor`. */
  private matchLen = 0
  /** Stable first-line signature for the current expanding series. */
  private seriesHeadHash: number | undefined
  /** Full matched length of the previous qualifying cycle. */
  private lastRunLength = 0
  /** Number of strict growth steps after the first qualifying cycle. */
  private growthSteps = 0
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
    let anchorSize = 64
    const requested = Math.max(64, Math.min(65536, options.config.expansionSeenHashCap))
    while (anchorSize < requested) anchorSize <<= 1
    this.anchorHashes = new Uint32Array(anchorSize)
    this.anchorPositions = new Int32Array(anchorSize)
    this.anchorMask = anchorSize - 1
  }

  reset(): void {
    this.lineCount = 0
    this.lineHash = 0x811c9dc5 >>> 0
    this.lineCodes = 0
    this.lineStartPosition = 0
    this.position = -1
    this.anchor = -1
    this.matchStart = -1
    this.matchLen = 0
    this.seriesHeadHash = undefined
    this.lastRunLength = 0
    this.growthSteps = 0
    this.cycleStart = -1
    this.bestRatio = 0
    this.lines.fill(0)
    this.lineStarts.fill(0)
    this.lineIds.fill(-1)
    this.anchorHashes.fill(0)
    this.anchorPositions.fill(0)
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

  private retained(line: number): boolean {
    if (line < 0 || line >= this.lineCount) return false
    return this.lineIds[line % this.ringSize] === line
  }

  private getLineHash(line: number): number | undefined {
    return this.retained(line) ? this.lines[line % this.ringSize] : undefined
  }

  private anchorSlot(hash: number): number {
    const mixed = (hash ^ (hash >>> 16)) >>> 0
    return mixed & this.anchorMask
  }

  private recentLine(hash: number): number {
    const slot = this.anchorSlot(hash)
    const stored = this.anchorPositions[slot]!
    if (stored === 0 || this.anchorHashes[slot] !== hash) return -1
    const line = stored - 1
    return this.retained(line) ? line : -1
  }

  private storeLine(hash: number, start: number): number {
    const line = this.lineCount
    const slot = line % this.ringSize
    this.lines[slot] = hash
    this.lineStarts[slot] = start >>> 0
    this.lineIds[slot] = line
    const anchorSlot = this.anchorSlot(hash)
    this.anchorHashes[anchorSlot] = hash
    this.anchorPositions[anchorSlot] = line + 1
    this.lineCount++
    return line
  }

  private finalizeRun(): PeriodDetection | undefined {
    if (this.matchLen < this.minLines || this.matchStart < 0) return undefined
    const head = this.getLineHash(this.matchStart)
    if (head === undefined) {
      this.seriesHeadHash = undefined
      this.lastRunLength = 0
      this.growthSteps = 0
      this.cycleStart = -1
      return undefined
    }

    if (this.seriesHeadHash === head && this.lastRunLength >= this.minLines && this.matchLen > this.lastRunLength) {
      this.growthSteps++
      this.lastRunLength = this.matchLen
      this.bestRatio = Math.max(this.bestRatio, this.matchLen / Math.max(1, this.lineCount))
      const requiredGrowths = Math.max(1, this.minCycles - (this.recoveryMode ? 1 : 0))
      if (this.growthSteps >= requiredGrowths && this.length >= this.minStreamChars) return this.detect()
      return undefined
    }

    this.seriesHeadHash = head
    this.lastRunLength = this.matchLen
    this.growthSteps = 0
    this.cycleStart = this.matchStart
    this.bestRatio = Math.max(this.bestRatio, this.matchLen / Math.max(1, this.lineCount))
    return undefined
  }

  private closeLine(hash: number, start: number): PeriodDetection | undefined {
    const currentLine = this.lineCount

    if (this.anchor >= 0 && this.matchLen > 0) {
      // The expected line must strictly predate the current line; without
      // this guard the match window catches up to the write head and every
      // line trivially matches itself.
      const expectedIndex = this.anchor + this.matchLen
      if (expectedIndex < currentLine) {
        const expected = this.getLineHash(expectedIndex)
        if (expected === hash) {
          this.matchLen++
          this.storeLine(hash, start)
          return undefined
        }
      }
    }

    const detection = this.finalizeRun()
    if (detection) return detection

    // No continuation: re-anchor on the most recent retained earlier occurrence
    // before storing the current line, so the anchor is an absolute line id.
    this.anchor = this.recentLine(hash)
    this.matchStart = this.anchor >= 0 ? currentLine : -1
    this.matchLen = this.anchor >= 0 ? 1 : 0
    this.storeLine(hash, start)
    return undefined
  }

  private detect(): PeriodDetection {
    const runStartLine = Math.max(0, this.cycleStart)
    const runStart = this.retained(runStartLine) ? this.lineStarts[runStartLine % this.ringSize]! : 0
    this.growthSteps = 0
    return {
      kind: "periodic-attractor",
      lane: "expansion",
      source: "expansion-heuristic",
      channel: this.channel,
      period: 0,
      runStart,
      runEnd: this.position + 1,
      runLength: this.position + 1 - runStart,
      exponent: this.lastRunLength,
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
      const start = this.lineStartPosition
      this.lineStartPosition = this.position + 1
      return this.closeLine(hash, start)
    }
    if (code !== 13 && code !== 32 && code !== 9) {
      this.lineHash = Math.imul(this.lineHash ^ code, 0x01000193) >>> 0
      this.lineCodes++
    }
    return undefined
  }
}
