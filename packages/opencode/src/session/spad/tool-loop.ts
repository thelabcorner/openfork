import { PeriodLane } from "./period-lane"
import type { PeriodThresholdBand } from "./types"

const TOOL_BANDS: readonly PeriodThresholdBand[] = Object.freeze([
  { maxPeriod: 1, minExponent: 24, minCoverage: 24 },
  { maxPeriod: 4, minExponent: 10, minCoverage: 20 },
  { maxPeriod: 16, minExponent: 8, minCoverage: 24 },
])

export interface ToolFingerprint {
  readonly narrow: number
  readonly h1: number
  readonly h2: number
}

/** The Uint16 proposal alphabet is lossy; full hashes terminally verify hits. */
export function toolFingerprint(name: string, resource?: string): ToolFingerprint {
  const combined = resource ? `${name}:${resource}` : name
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0x9e3779b9 >>> 0
  for (let i = 0; i < combined.length; i++) {
    const c = combined.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0
    h2 ^= h2 >>> 13
  }
  const mixed = (h1 ^ ((h2 << 13) | (h2 >>> 19))) >>> 0
  return { narrow: mixed & 0xffff, h1, h2 }
}

export interface ToolLoopDetection {
  readonly period: number
  readonly runLength: number
  readonly exponent: number
}

export class ToolLoopDetector {
  private readonly lane: PeriodLane
  private readonly wide1 = new Uint32Array(128)
  private readonly wide2 = new Uint32Array(128)
  private readonly wideMask = 127
  private noMutateCount = 0

  constructor() {
    this.lane = new PeriodLane({
      lane: "raw",
      ringSize: 128,
      anchorTableSize: 64,
      qgram: 3,
      maxPeriod: 16,
      maxCandidates: 4,
      bands: TOOL_BANDS,
      coverageMultiplier: 1,
      exponentBonus: 0,
      storeRawPositions: false,
    })
  }

  reset(): void {
    this.lane.reset()
    this.wide1.fill(0)
    this.wide2.fill(0)
    this.noMutateCount = 0
  }

  markProgress(): void {
    this.reset()
  }

  private equal(a: number, b: number): boolean {
    return this.wide1[a & this.wideMask] === this.wide1[b & this.wideMask] &&
      this.wide2[a & this.wideMask] === this.wide2[b & this.wideMask]
  }

  private threshold(period: number): PeriodThresholdBand {
    for (const band of TOOL_BANDS) if (period <= band.maxPeriod) return band
    return TOOL_BANDS[TOOL_BANDS.length - 1]!
  }

  /** Find the exact full-fingerprint periodic suffix after a narrow proposal. */
  private verifyWidePeriod(): ToolLoopDetection | undefined {
    const end = this.lane.length
    const oldest = Math.max(0, end - this.wide1.length)
    for (let period = 1; period <= Math.min(16, end - oldest); period++) {
      let matched = 0
      for (let pos = end - 1; pos - period >= oldest; pos--) {
        if (!this.equal(pos, pos - period)) break
        matched++
      }
      const runLength = period + matched
      const band = this.threshold(period)
      if (runLength < band.minCoverage || runLength / period < band.minExponent) continue
      return { period, runLength, exponent: runLength / period }
    }
    return undefined
  }

  /**
   * PeriodLane's Uint16 values are proposals only. Every candidate is verified
   * against two full 32-bit fingerprints before tool-loop evidence is emitted.
   */
  push(tool: string, isMutating: boolean, resource?: string): ToolLoopDetection | undefined {
    if (isMutating) {
      this.reset()
      return undefined
    }
    this.noMutateCount++

    const fp = toolFingerprint(tool, resource?.toLowerCase())
    const rawPos = this.lane.length
    this.wide1[rawPos & this.wideMask] = fp.h1
    this.wide2[rawPos & this.wideMask] = fp.h2
    const hit = this.lane.push(fp.narrow, rawPos, 1)
    if (!hit) return undefined
    if (this.noMutateCount < 24) return undefined
    return this.verifyWidePeriod()
  }
}
