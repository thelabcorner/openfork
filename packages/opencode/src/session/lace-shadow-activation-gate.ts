/**
 * LACE v14.7 two-phase shadow activation guard.
 *
 * A pure pre-commit proof ONLY. The authoritative V1 Session owner must re-run
 * this validation inside its persistence transaction with a fresh owner snapshot.
 * It cannot commit, execute tools, grant permissions, or verify a model summary.
 */
export interface LaceShadowSnapshot {
  readonly sessionID: string
  readonly projectID: string
  readonly ownerID: string
  readonly epoch: number
  readonly headID: string
  readonly contextRevision: string
  readonly permissionRevision: string
  readonly routeRevision: string
  readonly systemRevision: string
  readonly pendingToolCalls: number
}
export interface LaceShadowProposal {
  readonly snapshot: LaceShadowSnapshot
  readonly projectionDigest: string
  readonly evidenceDigest: string
  readonly expectedTokenCount: number
  readonly outputReserve: number
  readonly contextLimit: number
  readonly hasOpaqueReasoning: boolean
  readonly containsAuthoritativeState: boolean
  readonly sourceCount: number
  readonly coveredSourceCount: number
}
export interface LaceShadowVerification {
  /** Returned by a separate task-fidelity evaluation, not self-certification. */
  readonly provenance: "independent-evaluator"
  readonly verifierID: string
  readonly projectionDigest: string
  readonly evidenceDigest: string
  readonly snapshotEpoch: number
  readonly checkedConstraints: number
  readonly failedConstraints: number
  readonly sourceCoverageCount: number
}
export type LaceShadowGateResult =
  | { readonly status: "eligible-for-transaction"; readonly epoch: number; readonly headID: string }
  | { readonly status: "blocked"; readonly reason: string }

const block = (reason: string): LaceShadowGateResult => ({ status: "blocked", reason })

/**
 * Reject all unknown, stale, or semantically unverified candidates. No provider
 * request can be inferred from this result. A transaction must still fence the
 * live Session epoch/revisions, and a verifier must be independently trusted.
 */
export function assessShadowPromotion(input: {
  readonly proposal: LaceShadowProposal
  readonly current: LaceShadowSnapshot
  readonly verification?: LaceShadowVerification
}): LaceShadowGateResult {
  const p = input.proposal
  const s = p.snapshot
  const c = input.current
  const v = input.verification
  if (
    !s.sessionID ||
    !s.projectID ||
    !s.ownerID ||
    !s.headID ||
    !s.contextRevision ||
    !s.permissionRevision ||
    !s.routeRevision ||
    !s.systemRevision ||
    !p.projectionDigest ||
    !p.evidenceDigest
  )
    return block("incomplete-identity")
  if (!Number.isSafeInteger(s.epoch) || s.epoch < 0 || !Number.isSafeInteger(c.epoch) || c.epoch < 0)
    return block("invalid-epoch")
  if (s.sessionID !== c.sessionID || s.projectID !== c.projectID || s.ownerID !== c.ownerID)
    return block("owner-changed")
  if (s.epoch !== c.epoch || s.headID !== c.headID) return block("history-advanced")
  if (s.contextRevision !== c.contextRevision || s.systemRevision !== c.systemRevision)
    return block("authoritative-context-changed")
  if (s.permissionRevision !== c.permissionRevision) return block("permissions-changed")
  if (s.routeRevision !== c.routeRevision) return block("provider-route-changed")
  if (!Number.isSafeInteger(c.pendingToolCalls) || c.pendingToolCalls !== 0 || s.pendingToolCalls !== 0)
    return block("unsettled-tools")
  if (p.hasOpaqueReasoning) return block("reasoning-not-portable")
  if (p.containsAuthoritativeState) return block("authoritative-state-not-reprojected")
  if (
    !Number.isSafeInteger(p.expectedTokenCount) ||
    p.expectedTokenCount < 0 ||
    !Number.isSafeInteger(p.outputReserve) ||
    p.outputReserve <= 0 ||
    !Number.isSafeInteger(p.contextLimit) ||
    p.contextLimit <= 0 ||
    p.expectedTokenCount + p.outputReserve > p.contextLimit
  )
    return block("context-budget")
  if (!Number.isSafeInteger(p.sourceCount) || p.sourceCount < 1 || p.coveredSourceCount !== p.sourceCount)
    return block("evidence-incomplete")
  if (
    !v ||
    v.provenance !== "independent-evaluator" ||
    !v.verifierID ||
    v.projectionDigest !== p.projectionDigest ||
    v.evidenceDigest !== p.evidenceDigest ||
    v.snapshotEpoch !== s.epoch ||
    !Number.isSafeInteger(v.checkedConstraints) ||
    v.checkedConstraints < 1 ||
    v.failedConstraints !== 0 ||
    v.sourceCoverageCount !== p.sourceCount
  )
    return block("fidelity-unverified")
  return { status: "eligible-for-transaction", epoch: c.epoch, headID: c.headID }
}
