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
  if (evidence.channel === "reasoning") return { allowed: false, reason: "reasoning-observe-only" }
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
