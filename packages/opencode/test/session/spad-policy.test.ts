import { describe, expect, test } from "bun:test"
import { DEFAULT_SPAD_CONFIG } from "@/session/spad/config"
import { decideRecovery } from "@/session/spad/policy"
import type { PeriodDetection, SpadLane, SpadEvidenceSource } from "@/session/spad/types"

const normalTurn = { repetitionExpected: false, observeOnly: false, mutationForbidden: false }

function evidence(
  lane: SpadLane,
  source: SpadEvidenceSource,
  patch: Partial<PeriodDetection> = {},
): PeriodDetection {
  return {
    kind: "periodic-attractor",
    lane,
    source,
    channel: "text",
    period: 64,
    runStart: 0,
    runEnd: 512,
    runLength: 512,
    exponent: 8,
    agreement: 1,
    insideCodeFence: false,
    exactVerifiedSpan: lane === "raw" ? 512 : undefined,
    exactMinimalPeriod: lane === "raw" ? 64 : undefined,
    ...patch,
  }
}

describe("SPAD recovery policy", () => {
  test("default production authority is raw exact text only", () => {
    const raw = decideRecovery({
      config: DEFAULT_SPAD_CONFIG,
      turn: normalTurn,
      partObserveOnly: false,
      evidence: evidence("raw", "raw-exact-period"),
    })
    expect(raw).toEqual({ allowed: true, reason: "raw-exact-authorized" })

    const denied = [
      evidence("canonical", "canonical-period", { canonicalDuplicate4GramRatio: 1 }),
      evidence("expansion", "expansion-heuristic"),
      evidence("thrash", "cross-turn-thrash"),
      evidence("state", "generation-state-cycle"),
      evidence("information", "information-recurrence"),
      evidence("tool", "tool-loop"),
      evidence("persisted", "persisted-motif"),
    ]
    for (const item of denied) {
      expect(
        decideRecovery({ config: DEFAULT_SPAD_CONFIG, turn: normalTurn, partObserveOnly: false, evidence: item }).allowed,
      ).toBe(false)
    }
  })

  test("hard Stage-0 gates dominate lane configuration", () => {
    const permissive = {
      ...DEFAULT_SPAD_CONFIG,
      autoRecoverInsideCodeFence: true,
      autoRecoverCanonical: true,
      autoRecoverExpansion: true,
      autoRecoverPersistedMotifs: true,
      autoRecoverToolLoop: true,
      autoRecoverThrash: true,
    }
    const raw = evidence("raw", "raw-exact-period")

    expect(
      decideRecovery({ config: permissive, turn: { repetitionExpected: true, observeOnly: false, mutationForbidden: false }, partObserveOnly: false, evidence: raw }).reason,
    ).toBe("repetition-expected")
    expect(
      decideRecovery({ config: permissive, turn: { repetitionExpected: false, observeOnly: true, mutationForbidden: false }, partObserveOnly: false, evidence: raw }).reason,
    ).toBe("turn-observe-only")
    expect(
      decideRecovery({ config: permissive, turn: normalTurn, partObserveOnly: false, evidence: { ...raw, channel: "reasoning" } }).reason,
    ).toBe("reasoning-observe-only")
    expect(
      decideRecovery({ config: permissive, turn: normalTurn, partObserveOnly: true, evidence: raw }).reason,
    ).toBe("part-observe-only")
  })

  test("code fences remain non-destructive under the production profile", () => {
    const decision = decideRecovery({
      config: DEFAULT_SPAD_CONFIG,
      turn: normalTurn,
      partObserveOnly: false,
      evidence: evidence("raw", "raw-exact-period", { insideCodeFence: true }),
    })
    expect(decision).toEqual({ allowed: false, reason: "code-fence-recovery-disabled" })
  })

  test("raw exact authority fails closed when terminal proof metadata is absent", () => {
    const raw = evidence("raw", "raw-exact-period", { exactVerifiedSpan: undefined, exactMinimalPeriod: undefined })
    expect(
      decideRecovery({ config: DEFAULT_SPAD_CONFIG, turn: normalTurn, partObserveOnly: false, evidence: raw }),
    ).toEqual({ allowed: false, reason: "raw-terminal-proof-missing" })
  })

  test("heuristic lanes require their explicit capability flag", () => {
    const tool = evidence("tool", "tool-loop")
    expect(decideRecovery({ config: DEFAULT_SPAD_CONFIG, turn: normalTurn, partObserveOnly: false, evidence: tool }).allowed).toBe(false)
    expect(
      decideRecovery({
        config: { ...DEFAULT_SPAD_CONFIG, autoRecoverToolLoop: true },
        turn: normalTurn,
        partObserveOnly: false,
        evidence: tool,
      }),
    ).toEqual({ allowed: true, reason: "heuristic-recovery-authorized" })
  })

  test("state-cycle and information recurrence can never acquire destructive authority", () => {
    const permissive = {
      ...DEFAULT_SPAD_CONFIG,
      autoRecoverInsideCodeFence: true,
      autoRecoverCanonical: true,
      autoRecoverExpansion: true,
      autoRecoverPersistedMotifs: true,
      autoRecoverToolLoop: true,
      autoRecoverThrash: true,
    }
    expect(
      decideRecovery({
        config: permissive,
        turn: normalTurn,
        partObserveOnly: false,
        evidence: evidence("state", "generation-state-cycle"),
      }),
    ).toEqual({ allowed: false, reason: "state-cycle-observe-only" })
    expect(
      decideRecovery({
        config: permissive,
        turn: normalTurn,
        partObserveOnly: false,
        evidence: evidence("information", "information-recurrence"),
      }),
    ).toEqual({ allowed: false, reason: "information-observe-only" })
  })

  test("canonical capability still requires its evidence floor", () => {
    const config = { ...DEFAULT_SPAD_CONFIG, autoRecoverCanonical: true }
    const weak = evidence("canonical", "canonical-period", { canonicalDuplicate4GramRatio: 0.2 })
    const strong = evidence("canonical", "canonical-period", { canonicalDuplicate4GramRatio: 0.9 })
    expect(decideRecovery({ config, turn: normalTurn, partObserveOnly: false, evidence: weak }).reason).toBe(
      "canonical-evidence-insufficient",
    )
    expect(decideRecovery({ config, turn: normalTurn, partObserveOnly: false, evidence: strong }).allowed).toBe(true)
  })
})
