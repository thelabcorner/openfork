import type { PeriodDetection, SpadConfig, SpadPolicyReason, TurnPolicy } from "./types"

export interface SpadPolicyInput {
  readonly config: SpadConfig
  readonly turn: TurnPolicy
  readonly partObserveOnly: boolean
  readonly evidence: PeriodDetection
}

export interface SpadPolicyDecision {
  readonly allowed: boolean
  readonly reason: SpadPolicyReason
}

/**
 * Termination (not mutation) authority predicate for the reasoning channel.
 *
 * All four conjuncts are necessary for zero false positives:
 *
 * 1. `lane === "raw"` and `source === "raw-exact-period"` -- heuristic/fuzzy lanes are
 *    structurally excluded from ever stopping a stream.
 * 2. `exactMinimalPeriod > 0` and `exactVerifiedSpan > period` -- an independent
 *    bounded verifier already re-proved exact periodicity off the streaming path.
 * 3. The proven period survived `reasoningRunawayChars` *more* characters after that
 *    proof. This is the false-positive killer. For a tail of length L with minimal
 *    period p, the string is determined by its first p symbols, so information
 *    content is O(p) while length is L. The new information rate over the window is
 *    exactly zero -- not small, zero. Legitimate repetition (tables, boilerplate,
 *    enumerations) terminates and breaks periodicity long before 8 KiB of flawless
 *    continuation; a degenerate attractor never does.
 * 4. `insideCodeFence === false` -- generated code/data blocks are the one place
 *    where long exact periodicity can be intentional.
 */
function isProvenReasoningRunaway(config: SpadConfig, evidence: PeriodDetection): boolean {
  if (evidence.lane !== "raw" || evidence.source !== "raw-exact-period") return false
  if (evidence.insideCodeFence) return false
  const period = evidence.exactMinimalPeriod ?? 0
  if (period <= 0) return false
  if ((evidence.exactVerifiedSpan ?? 0) <= period) return false
  return (evidence.runawayCharsAfterProof ?? 0) >= config.reasoningRunawayChars
}

/**
 * The single destructive-authority gate for SPAD evidence.
 *
 * Detection code is deliberately powerless: it may only emit evidence. Any
 * new lane/source must pass through this function before a recovery action can
 * be constructed. Unknown future lanes fail closed to observation because the
 * exhaustive lane union must be updated here before TypeScript will accept it.
 */
export function decideRecovery(input: SpadPolicyInput): SpadPolicyDecision {
  const { config, turn, partObserveOnly, evidence } = input

  if (turn.repetitionExpected) return { allowed: false, reason: "repetition-expected" }
  if (turn.observeOnly) return { allowed: false, reason: "turn-observe-only" }
  if (evidence.lane === "thrash" && turn.mutationForbidden)
    return { allowed: false, reason: "mutation-forbidden-thrash" }
  // Reasoning remains permanently non-rewritable. But "do not rewrite hidden
  // reasoning" and "never stop an infinite reasoning loop" are different claims, and
  // conflating them is what let a proven period-106 attractor run for 209,355
  // further characters under `reasoning-observe-only`. Termination needs no text
  // authority: nothing is rewritten, the part is kept verbatim, the stream stops.
  if (evidence.channel === "reasoning") {
    if (!isProvenReasoningRunaway(config, evidence))
      return { allowed: false, reason: "reasoning-observe-only" }
    if (!config.abortReasoningRunaway) return { allowed: false, reason: "reasoning-runaway-disabled" }
    return { allowed: true, reason: "reasoning-runaway-authorized" }
  }
  if (partObserveOnly) return { allowed: false, reason: "part-observe-only" }

  switch (evidence.lane) {
    case "raw":
      if (!config.autoRecoverRaw) return { allowed: false, reason: "raw-recovery-disabled" }
      if (!evidence.exactVerifiedSpan || evidence.exactVerifiedSpan <= evidence.period)
        return { allowed: false, reason: "raw-terminal-proof-missing" }
      if (evidence.insideCodeFence && !config.autoRecoverInsideCodeFence)
        return { allowed: false, reason: "code-fence-recovery-disabled" }
      return { allowed: true, reason: "raw-exact-authorized" }

    case "canonical":
      if (!config.autoRecoverCanonical) return { allowed: false, reason: "canonical-recovery-disabled" }
      if ((evidence.canonicalDuplicate4GramRatio ?? 0) < config.canonicalMinDuplicate4GramRatio)
        return { allowed: false, reason: "canonical-evidence-insufficient" }
      return { allowed: true, reason: "heuristic-recovery-authorized" }

    case "expansion":
      return config.autoRecoverExpansion
        ? { allowed: true, reason: "heuristic-recovery-authorized" }
        : { allowed: false, reason: "expansion-recovery-disabled" }

    case "thrash":
      return config.autoRecoverThrash
        ? { allowed: true, reason: "heuristic-recovery-authorized" }
        : { allowed: false, reason: "thrash-recovery-disabled" }

    case "state":
      // Bounded state-space periodicity remains evidence-only while real
      // session calibration accumulates. There is intentionally no config
      // switch capable of granting destructive authority.
      return { allowed: false, reason: "state-cycle-observe-only" }

    case "information":
      // This lane is intentionally observation-only. It has no configuration
      // switch capable of granting destructive authority.
      return { allowed: false, reason: "information-observe-only" }

    case "tool":
      return config.autoRecoverToolLoop
        ? { allowed: true, reason: "heuristic-recovery-authorized" }
        : { allowed: false, reason: "tool-loop-recovery-disabled" }

    case "persisted":
      return config.autoRecoverPersistedMotifs
        ? { allowed: true, reason: "heuristic-recovery-authorized" }
        : { allowed: false, reason: "persisted-motif-recovery-disabled" }
  }
}
