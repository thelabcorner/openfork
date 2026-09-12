export type SpadLane = "raw" | "canonical" | "thrash" | "state" | "information" | "expansion" | "tool" | "persisted"
export type SpadChannel = "text" | "reasoning"

/**
 * Provenance for a SPAD observation. This is intentionally more specific than
 * `lane`: recovery authority is a policy decision over evidence, not a side
 * effect of whichever detector happened to return first.
 */
export type SpadEvidenceSource =
  | "raw-exact-period"
  | "canonical-period"
  | "expansion-heuristic"
  | "cross-turn-thrash"
  | "generation-state-cycle"
  | "information-recurrence"
  | "tool-loop"
  | "persisted-motif"

export type SpadPolicyReason =
  | "raw-exact-authorized"
  | "repetition-expected"
  | "mutation-forbidden-thrash"
  | "turn-observe-only"
  | "part-observe-only"
  | "reasoning-observe-only"
  | "raw-recovery-disabled"
  | "raw-terminal-proof-missing"
  | "code-fence-recovery-disabled"
  | "canonical-recovery-disabled"
  | "canonical-evidence-insufficient"
  | "expansion-recovery-disabled"
  | "thrash-recovery-disabled"
  | "state-cycle-observe-only"
  | "information-observe-only"
  | "tool-loop-recovery-disabled"
  | "persisted-motif-recovery-disabled"
  | "heuristic-recovery-authorized"

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
  readonly autoRecoverRaw: boolean
  readonly autoRecoverInsideCodeFence: boolean
  readonly autoRecoverCanonical: boolean
  readonly canonicalMinDuplicate4GramRatio: number
  readonly autoRecoverExpansion: boolean
  readonly autoRecoverPersistedMotifs: boolean
  readonly autoRecoverToolLoop: boolean
  readonly expansionMinLines: number
  readonly expansionMinCycles: number
  readonly expansionMinStreamChars: number
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

export interface SpadEvidence {
  readonly kind: "periodic-attractor"
  readonly lane: SpadLane
  readonly source: SpadEvidenceSource
  readonly channel: SpadChannel
  readonly period: number
  readonly runStart: number
  readonly runEnd: number
  readonly runLength: number
  readonly exponent: number
  readonly agreement: number
  readonly canonicalDuplicate4GramRatio?: number
  readonly expansionDuplicateRatio?: number
  readonly insideCodeFence: boolean
  readonly motifDistinctAsciiLetters?: number
  readonly motifHasNonAscii?: boolean
  /** Raw-exact terminal certificate. Present only after bounded re-verification. */
  readonly exactVerifiedSpan?: number
  readonly exactMinimalPeriod?: number
  readonly exactPeriodComparisons?: number
  readonly exactPrefixComparisons?: number
  /** Passive cross-generation unchanged-result recurrence evidence. */
  readonly informationResource?: string
  readonly informationRecurrences?: number
  readonly informationResultSignature?: string
  /** Bounded cross-generation state-cycle evidence. */
  readonly stateCyclePeriod?: number
  readonly stateCycleComparisons?: number
  readonly stateCycleResourceJaccard?: number
  readonly stateCycleNarrationDice?: number
}

/** @deprecated Prefer `SpadEvidence`; retained while callers migrate. */
export type PeriodDetection = SpadEvidence

export interface TurnPolicy {
  readonly repetitionExpected: boolean
  readonly observeOnly: boolean
  /** Explicit user instruction that repository/file mutation is forbidden. */
  readonly mutationForbidden: boolean
}

export type SpadAction =
  | { readonly type: "observe"; readonly detection: SpadEvidence; readonly policyReason: SpadPolicyReason }
  | {
      readonly type: "recover"
      readonly attempt: number
      readonly detection: SpadEvidence
      readonly quarantineFrom: number
      readonly recoveryPrompt: string
      readonly noTruncate?: boolean
      readonly policyReason: SpadPolicyReason
    }
  | {
      readonly type: "abort"
      readonly detection: SpadEvidence
      readonly reason: "recovery-budget-exhausted" | "relapse"
      readonly policyReason: SpadPolicyReason
    }

export interface PushContext {
  readonly channel: SpadChannel
}

export interface SpadAuditCase {
  /** Internal metadata for telemetry only. Never pass these labels to the LLM auditor. */
  readonly detection: SpadEvidence
  readonly policyReason: SpadPolicyReason
  readonly intentIndependent: {
    readonly contextBefore: string
    readonly candidateHead: string
    readonly candidateTail: string
    readonly contentKind: "text" | "reasoning"
    readonly features: Readonly<Record<string, string | number | boolean | null>>
  }
}
