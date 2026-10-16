import { expect, test, describe } from "bun:test"
import { assessShadowPromotion, type LaceShadowSnapshot } from "../../src/session/lace-shadow-activation-gate"

const snapshot: LaceShadowSnapshot = {
  sessionID: "s",
  projectID: "p",
  ownerID: "account-A",
  epoch: 17,
  headID: "msg-last",
  contextRevision: "ctx-1",
  permissionRevision: "perm-1",
  routeRevision: "route-1",
  systemRevision: "sys-1",
  pendingToolCalls: 0,
}
const proposal = {
  snapshot,
  projectionDigest: "projection-hash",
  evidenceDigest: "evidence-hash",
  expectedTokenCount: 15000,
  outputReserve: 2000,
  contextLimit: 20000,
  hasOpaqueReasoning: false,
  containsAuthoritativeState: false,
  sourceCount: 8,
  coveredSourceCount: 8,
}
const verified = {
  provenance: "independent-evaluator" as const,
  verifierID: "offline-fixture-independent",
  projectionDigest: proposal.projectionDigest,
  evidenceDigest: proposal.evidenceDigest,
  snapshotEpoch: snapshot.epoch,
  checkedConstraints: 4,
  failedConstraints: 0,
  sourceCoverageCount: proposal.sourceCount,
}
const evaluate = (p: typeof proposal = proposal, current = snapshot, v: typeof verified | undefined = verified) =>
  assessShadowPromotion({ proposal: p, current, verification: v })

describe("LACE pure pre-commit shadow gate", () => {
  test("only structurally complete and evidence-covered candidate may proceed to transaction", () => {
    expect(evaluate()).toEqual({ status: "eligible-for-transaction", epoch: 17, headID: "msg-last" })
    expect(assessShadowPromotion({ proposal, current: snapshot })).toMatchObject({
      status: "blocked",
      reason: "fidelity-unverified",
    })
  })
  test("concurrent writer or owner change immediately rejects stale shadow", () => {
    for (const change of [
      { epoch: 18 },
      { headID: "new-head" },
      { sessionID: "other" },
      { projectID: "other" },
      { ownerID: "account-B" },
    ]) {
      expect(evaluate(proposal, { ...snapshot, ...change }).status).toBe("blocked")
    }
  })
  test("authority, permission and route drift cannot be optimized away", () => {
    for (const change of [
      { contextRevision: "ctx-2" },
      { systemRevision: "sys-2" },
      { permissionRevision: "perm-2" },
      { routeRevision: "route-2" },
    ]) {
      expect(evaluate(proposal, { ...snapshot, ...change }).status).toBe("blocked")
    }
  })
  test("unsettled tool calls, reasoning, old authority state and overflow fail closed", () => {
    expect(evaluate(proposal, { ...snapshot, pendingToolCalls: 1 })).toMatchObject({ reason: "unsettled-tools" })
    expect(evaluate({ ...proposal, hasOpaqueReasoning: true })).toMatchObject({ reason: "reasoning-not-portable" })
    expect(evaluate({ ...proposal, containsAuthoritativeState: true })).toMatchObject({
      reason: "authoritative-state-not-reprojected",
    })
    expect(evaluate({ ...proposal, expectedTokenCount: 19000 })).toMatchObject({ reason: "context-budget" })
    expect(evaluate({ ...proposal, coveredSourceCount: 7 })).toMatchObject({ reason: "evidence-incomplete" })
  })
  test("evaluator provenance must match the exact projection, epoch, evidence and sources", () => {
    const changes = [
      { projectionDigest: "other" },
      { evidenceDigest: "other" },
      { snapshotEpoch: 18 },
      { sourceCoverageCount: 7 },
      { failedConstraints: 1 },
      { checkedConstraints: 0 },
      { verifierID: "" },
    ]
    for (const change of changes) {
      expect(evaluate(proposal, snapshot, { ...verified, ...change })).toMatchObject({
        status: "blocked",
        reason: "fidelity-unverified",
      })
    }
  })
  test("sequential interleaving models a precommit TOCTOU recheck", () => {
    const frozen = evaluate()
    expect(frozen.status).toBe("eligible-for-transaction")
    const afterWriter = evaluate(proposal, { ...snapshot, epoch: 18 })
    expect(afterWriter).toMatchObject({ status: "blocked", reason: "history-advanced" })
    // The offline gate does not write to storage; a production transaction must
    // perform this comparison against its own freshly locked authoritative row.
  })
  test("malformed numeric snapshots and source-count mismatches never pass", () => {
    for (const epoch of [-1, NaN, Infinity, 0.25]) {
      expect(evaluate({ ...proposal, snapshot: { ...snapshot, epoch } }).status).toBe("blocked")
    }
    for (const pendingToolCalls of [-1, NaN, 1, Infinity]) {
      expect(evaluate(proposal, { ...snapshot, pendingToolCalls }).status).toBe("blocked")
    }
    for (const expectedTokenCount of [-1, Infinity, 9e20]) {
      expect(evaluate({ ...proposal, expectedTokenCount }).status).toBe("blocked")
    }
    for (const coveredSourceCount of [0, 1, 7, 9, NaN]) {
      expect(evaluate({ ...proposal, coveredSourceCount }).status).toBe("blocked")
    }
  })
  test("1000 deterministic concurrent revisions cannot promote a stale candidate", () => {
    let state = 0x7f361b5
    const next = () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return state >>> 0
    }
    for (let i = 0; i < 1000; i++) {
      const candidate = {
        ...snapshot,
        epoch: snapshot.epoch + 1 + (next() % 1000),
        permissionRevision: String(next()),
      }
      expect(evaluate(proposal, candidate)).toMatchObject({ status: "blocked" })
    }
  })
})
