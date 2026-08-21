export type SpadLane = "raw" | "canonical" | "thrash"
export type SpadChannel = "text" | "reasoning"

export interface PeriodThresholdBand {
  readonly maxPeriod: number
  readonly minExponent: number
  readonly minCoverage: number
}

export interface SpadConfig {
  readonly ringSize: number
  readonly anchorTableSize: number
  readonly qgram: number
  readonly maxPeriod: number
  readonly maxCandidates: number
  readonly exactBands: readonly PeriodThresholdBand[]
  readonly canonicalCoverageMultiplier: number
  readonly canonicalExponentBonus: number
  readonly codeFenceCoverageMultiplier: number
  readonly recoveryThresholdMultiplier: number
  readonly maxRecoveryAttempts: number
  readonly relapseMatchChars: number
  readonly recoveryWatchChars: number
  readonly autoRecoverCanonical: boolean
  readonly canonicalMinDuplicate4GramRatio: number
  readonly lowLexicalDistinctLetters: number
  readonly lowLexicalMinCoverage: number
  readonly autoRecoverThrash: boolean
  readonly thrashMinGenerations: number
  readonly thrashMinToolCalls: number
  readonly thrashNoMutationGens: number
  readonly thrashReaccessRatio: number
  readonly thrashNarrationOverlap: number
  readonly thrashNarrationStreak: number
}

export interface PeriodDetection {
  readonly kind: "periodic-attractor"
  readonly lane: SpadLane
  readonly channel: SpadChannel
  readonly period: number
  readonly runStart: number
  readonly runEnd: number
  readonly runLength: number
  readonly exponent: number
  readonly agreement: number
  readonly canonicalDuplicate4GramRatio?: number
  readonly insideCodeFence: boolean
  readonly motifDistinctAsciiLetters?: number
  readonly motifHasNonAscii?: boolean
}

export interface TurnPolicy {
  readonly repetitionExpected: boolean
  readonly observeOnly: boolean
}

export type SpadAction =
  | { readonly type: "observe"; readonly detection: PeriodDetection }
  | {
      readonly type: "recover"
      readonly attempt: number
      readonly detection: PeriodDetection
      readonly quarantineFrom: number
      readonly recoveryPrompt: string
      readonly noTruncate?: boolean
    }
  | {
      readonly type: "abort"
      readonly detection: PeriodDetection
      readonly reason: "recovery-budget-exhausted" | "relapse"
    }

export interface PushContext {
  readonly channel: SpadChannel
}
