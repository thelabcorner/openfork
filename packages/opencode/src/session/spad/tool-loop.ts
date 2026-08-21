import { PeriodLane } from "./period-lane"
import type { PeriodThresholdBand } from "./types"

const TOOL_BANDS: readonly PeriodThresholdBand[] = Object.freeze([
  { maxPeriod: 1, minExponent: 16, minCoverage: 16 },
  { maxPeriod: 4, minExponent: 7, minCoverage: 14 },
  { maxPeriod: 16, minExponent: 5, minCoverage: 18 },
])

function toolCode(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (Math.imul(hash, 31) + name.charCodeAt(i)) >>> 0
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

  /** Returns detection when a tool-name period sustains. */
  push(tool: string, isMutating: boolean): ToolLoopDetection | undefined {
    if (isMutating) this.noMutateCount = 0
    else this.noMutateCount++

    const code = toolCode(tool)
    const rawPos = this.lane.length
    const hit = this.lane.push(code, rawPos, 1)
    if (!hit) return undefined
    if (this.noMutateCount < 16) return undefined
    return { period: hit.period, runLength: hit.laneRunEnd - hit.laneRunStart, exponent: hit.exponent }
  }
}
