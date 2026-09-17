import type { PeriodThresholdBand, SpadConfig } from "./types"

export const DEFAULT_EXACT_BANDS: readonly PeriodThresholdBand[] = Object.freeze([
  { maxPeriod: 4, minExponent: 128, minCoverage: 1024 },
  { maxPeriod: 16, minExponent: 40, minCoverage: 640 },
  { maxPeriod: 64, minExponent: 7, minCoverage: 224 },
  { maxPeriod: 256, minExponent: 5, minCoverage: 384 },
  { maxPeriod: 768, minExponent: 4, minCoverage: 768 },
  { maxPeriod: 4096, minExponent: 3, minCoverage: 2048 },
])

export const DEFAULT_SPAD_CONFIG: SpadConfig = Object.freeze({
  ringSize: 16384,
  anchorTableSize: 4096,
  qgram: 8,
  maxPeriod: 4096,
  maxCandidates: 4,
  exactBands: DEFAULT_EXACT_BANDS,
  canonicalCoverageMultiplier: 1.5,
  canonicalExponentBonus: 2,
  codeFenceCoverageMultiplier: 1.75,
  // Do not lower thresholds after a recovery. A prior intervention is not
  // evidence that the next generation should be judged more aggressively.
  recoveryThresholdMultiplier: 1,
  maxRecoveryAttempts: 2,
  relapseMatchChars: 96,
  recoveryWatchChars: 1536,
  // Production safety profile: only high-confidence exact repetition may
  // mutate a text response. Every heuristic/fuzzy/cross-turn lane remains
  // detect/observe-only until it clears the SPAD gym precision gate.
  autoRecoverRaw: true,
  autoRecoverInsideCodeFence: false,
  autoRecoverCanonical: false,
  canonicalMinDuplicate4GramRatio: 0.65,
  autoRecoverExpansion: false,
  autoRecoverPersistedMotifs: false,
  autoRecoverToolLoop: false,
  expansionMinLines: 8,
  expansionMinCycles: 2,
  expansionWindowSize: 512,
  expansionMinStreamChars: 1024,
  expansionSeenHashCap: 32768,
  lowLexicalDistinctLetters: 4,
  lowLexicalMinCoverage: 1024,
  autoRecoverThrash: false,
  // Termination is not mutation. A reasoning attractor that survives its own
  // independent terminal proof for another 8 KiB is information-free by
  // construction, so stopping the stream costs nothing recoverable and needs no
  // reasoning rewrite. Chosen so the shortest authorized run (proof span+ window) is
  // orders of magnitude longer than any observed legitimate repetition.
  abortReasoningRunaway: true,
  reasoningRunawayChars: 8192,
  thrashMinGenerations: 3,
  thrashMinToolCalls: 8,
  thrashNoMutationGens: 3,
  thrashReaccessRatio: 0.5,
  thrashNarrationOverlap: 0.35,
  thrashNarrationStreak: 3,
})

export function validateConfig(config: SpadConfig): void {
  const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0
  if (!pow2(config.ringSize)) throw new Error("SPAD ringSize must be a power of two")
  if (!pow2(config.anchorTableSize)) throw new Error("SPAD anchorTableSize must be a power of two")
  if (config.qgram < 4 || config.qgram > 32) throw new Error("SPAD qgram must be in [4, 32]")
  if (config.maxPeriod <= 0 || config.maxPeriod + config.qgram >= config.ringSize)
    throw new Error("SPAD maxPeriod must fit inside the rolling ring")
  if (config.maxCandidates < 1 || config.maxCandidates > 16) throw new Error("SPAD maxCandidates must be in [1, 16]")
  // A zero/negative window would turn termination authority into an immediate
  // abort on first proof, which is exactly the false-positive mode this lane must not
  // have. Require a real post-proof survival window.
  if (!Number.isInteger(config.reasoningRunawayChars) || config.reasoningRunawayChars < 1024)
    throw new Error("SPAD reasoningRunawayChars must be an integer >= 1024")
}
