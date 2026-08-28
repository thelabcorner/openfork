import { PeriodLane } from "./period-lane"
import type { PeriodThresholdBand } from "./types"

const TOOL_BANDS: readonly PeriodThresholdBand[] = Object.freeze([
  { maxPeriod: 1, minExponent: 24, minCoverage: 24 },
  { maxPeriod: 4, minExponent: 10, minCoverage: 20 },
  { maxPeriod: 16, minExponent: 8, minCoverage: 24 },
])

function toolCode(name: string, resource?: string): number {
  const combined = resource ? `${name}:${resource}` : name
  let hash = 0
  for (let i = 0; i < combined.length; i++) hash = (Math.imul(hash, 31) + combined.charCodeAt(i)) >>> 0
  return (hash % 4094) + 1
}

export interface ToolLoopDetection {
  readonly period: number
  readonly runLength: number
  readonly exponent: number
}

export class ToolLoopDetector {
  private readonly lane: PeriodLane
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
    this.noMutateCount = 0
  }

  /** Returns detection when a tool-name period sustains. Resource-aware: same tool on distinct files hashes differently, eliminating the dominant FP (16 distinct reads flagged as loop). */
  push(tool: string, isMutating: boolean, resource?: string): ToolLoopDetection | undefined {
    if (isMutating) this.noMutateCount = 0
    else this.noMutateCount++

    const code = toolCode(tool, resource?.toLowerCase())
    const rawPos = this.lane.length
    const hit = this.lane.push(code, rawPos, 1)
    if (!hit) return undefined
    if (this.noMutateCount < 24) return undefined
    return { period: hit.period, runLength: hit.laneRunEnd - hit.laneRunStart, exponent: hit.exponent }
  }
}
