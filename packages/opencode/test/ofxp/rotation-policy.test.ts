import { describe, expect, test } from "bun:test"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpRekey } from "@opencode-ai/core/ofxp-peer/rekey"
import { canFinalizeIdentityRotation, canRotateIdentity } from "../../src/ofxp/rotation-policy"

function identity(label: string) {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID: "realm:test",
      label,
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    },
  }
}

function proof(now = 1_000) {
  const previous = identity("Local")
  const next = identity("Local")
  return {
    previous,
    next,
    proof: OfxpRekey.create({
      current: previous.key,
      currentRealmID: previous.identity.realmID,
      next: next.identity,
      now,
    }),
  }
}

describe("OFXP identity rotation policy", () => {
  test("rejects stale rotate/finalize commands before considering lifecycle state", () => {
    const current = identity("Current")
    const stale = identity("Stale")

    expect(
      canRotateIdentity({
        currentPeerID: current.key.peerID,
        expectedPeerID: stale.key.peerID,
        now: 1_000,
      }),
    ).toEqual({
      ok: false,
      conflict: {
        kind: "identity_changed",
        expectedPeerID: stale.key.peerID,
        currentPeerID: current.key.peerID,
      },
    })

    expect(
      canFinalizeIdentityRotation({
        currentPeerID: current.key.peerID,
        expectedPeerID: stale.key.peerID,
        now: 1_000,
      }),
    ).toEqual({
      ok: false,
      conflict: {
        kind: "identity_changed",
        expectedPeerID: stale.key.peerID,
        currentPeerID: current.key.peerID,
      },
    })
  })

  test("allows rotation only when the expected identity is current and no journal exists", () => {
    const current = identity("Current")
    expect(
      canRotateIdentity({
        currentPeerID: current.key.peerID,
        expectedPeerID: current.key.peerID,
        now: 1_000,
      }),
    ).toEqual({ ok: true })
  })

  test("blocks both early finalization and another rotation while a proof is still valid", () => {
    const state = proof(1_000)
    const now = state.proof.expiresAt - 1

    const rotate = canRotateIdentity({
      currentPeerID: state.next.key.peerID,
      expectedPeerID: state.next.key.peerID,
      continuityProof: state.proof,
      now,
    })
    const finalize = canFinalizeIdentityRotation({
      currentPeerID: state.next.key.peerID,
      expectedPeerID: state.next.key.peerID,
      continuityProof: state.proof,
      now,
    })

    expect(rotate).toEqual({
      ok: false,
      conflict: {
        kind: "continuity_active",
        previousPeerID: state.previous.key.peerID,
        currentPeerID: state.next.key.peerID,
        expiresAt: state.proof.expiresAt,
      },
    })
    expect(finalize).toEqual(rotate)
  })

  test("requires explicit finalization after expiry before another rotation", () => {
    const state = proof(1_000)
    const now = state.proof.expiresAt

    expect(
      canRotateIdentity({
        currentPeerID: state.next.key.peerID,
        expectedPeerID: state.next.key.peerID,
        continuityProof: state.proof,
        now,
      }),
    ).toEqual({
      ok: false,
      conflict: {
        kind: "continuity_expired_unfinalized",
        previousPeerID: state.previous.key.peerID,
        currentPeerID: state.next.key.peerID,
        expiresAt: state.proof.expiresAt,
      },
    })

    expect(
      canFinalizeIdentityRotation({
        currentPeerID: state.next.key.peerID,
        expectedPeerID: state.next.key.peerID,
        continuityProof: state.proof,
        now,
      }),
    ).toEqual({ ok: true })
  })

  test("treats finalization as idempotent when no journal exists", () => {
    const current = identity("Current")
    expect(
      canFinalizeIdentityRotation({
        currentPeerID: current.key.peerID,
        expectedPeerID: current.key.peerID,
        now: 1_000,
      }),
    ).toEqual({ ok: true })
  })
})
