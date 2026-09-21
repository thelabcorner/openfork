import { Ofxp } from "@opencode-ai/schema/ofxp"

export type RotationPolicyConflict =
  | {
      readonly kind: "identity_changed"
      readonly expectedPeerID: Ofxp.PeerID
      readonly currentPeerID: Ofxp.PeerID
    }
  | {
      readonly kind: "continuity_active"
      readonly previousPeerID: Ofxp.PeerID
      readonly currentPeerID: Ofxp.PeerID
      readonly expiresAt: number
    }
  | {
      readonly kind: "continuity_expired_unfinalized"
      readonly previousPeerID: Ofxp.PeerID
      readonly currentPeerID: Ofxp.PeerID
      readonly expiresAt: number
    }

export type RotationPolicyDecision = { readonly ok: true } | { readonly ok: false; readonly conflict: RotationPolicyConflict }

function identityFence(currentPeerID: Ofxp.PeerID, expectedPeerID: Ofxp.PeerID): RotationPolicyDecision {
  if (currentPeerID === expectedPeerID) return { ok: true }
  return {
    ok: false,
    conflict: {
      kind: "identity_changed",
      expectedPeerID,
      currentPeerID,
    },
  }
}

/**
 * Guard a local identity rotation against stale operators and overlapping
 * continuity chains. An expired journal remains an explicit lifecycle state:
 * it must be finalized before a new rotation is allowed.
 */
export function canRotateIdentity(input: {
  readonly currentPeerID: Ofxp.PeerID
  readonly expectedPeerID: Ofxp.PeerID
  readonly continuityProof?: Ofxp.RekeyProof
  readonly now?: number
}): RotationPolicyDecision {
  const fenced = identityFence(input.currentPeerID, input.expectedPeerID)
  if (!fenced.ok) return fenced

  const proof = input.continuityProof
  if (!proof) return { ok: true }
  const now = input.now ?? Date.now()
  if (proof.expiresAt > now) {
    return {
      ok: false,
      conflict: {
        kind: "continuity_active",
        previousPeerID: proof.previousPeerID,
        currentPeerID: input.currentPeerID,
        expiresAt: proof.expiresAt,
      },
    }
  }
  return {
    ok: false,
    conflict: {
      kind: "continuity_expired_unfinalized",
      previousPeerID: proof.previousPeerID,
      currentPeerID: input.currentPeerID,
      expiresAt: proof.expiresAt,
    },
  }
}

/**
 * Guard explicit journal finalization. Clearing local state cannot revoke a
 * proof already copied into a remote pending pairing transcript, so an active
 * proof may only disappear by natural cryptographic expiry.
 */
export function canFinalizeIdentityRotation(input: {
  readonly currentPeerID: Ofxp.PeerID
  readonly expectedPeerID: Ofxp.PeerID
  readonly continuityProof?: Ofxp.RekeyProof
  readonly now?: number
}): RotationPolicyDecision {
  const fenced = identityFence(input.currentPeerID, input.expectedPeerID)
  if (!fenced.ok) return fenced

  const proof = input.continuityProof
  if (!proof) return { ok: true }
  const now = input.now ?? Date.now()
  if (proof.expiresAt > now) {
    return {
      ok: false,
      conflict: {
        kind: "continuity_active",
        previousPeerID: proof.previousPeerID,
        currentPeerID: input.currentPeerID,
        expiresAt: proof.expiresAt,
      },
    }
  }
  return { ok: true }
}
