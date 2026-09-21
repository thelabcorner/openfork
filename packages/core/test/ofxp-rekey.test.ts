import { describe, expect, test } from "bun:test"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpRekey } from "@opencode-ai/core/ofxp-peer/rekey"
import { Ofxp } from "@opencode-ai/schema/ofxp"

function identity(key: ReturnType<typeof OfxpIdentity.generateKeyPair>, realmID = "realm:rekey", label = "Peer") {
  return {
    id: key.peerID,
    realmID,
    label,
    publicKeySpki: key.publicKeySpki,
    fingerprint: key.fingerprint,
  } satisfies Ofxp.PeerIdentity
}

describe("OFXP re-key continuity proof", () => {
  test("binds a new same-realm identity to the old private key without granting authority", () => {
    const previous = OfxpIdentity.generateKeyPair()
    const next = OfxpIdentity.generateKeyPair()
    const proof = OfxpRekey.create({
      current: previous,
      currentRealmID: "realm:rekey",
      next: identity(next),
      nonce: Ofxp.PairingNonce.make("A".repeat(43)),
      now: 1_000,
    })

    expect(proof.previousPeerID).toBe(previous.peerID)
    expect(proof.next.id).toBe(next.peerID)
    expect(
      OfxpRekey.verify({
        proof,
        previous: { peerID: previous.peerID, realmID: "realm:rekey", publicKeySpki: previous.publicKeySpki },
        now: 1_001,
      }),
    ).toEqual(identity(next))
  })

  test("rejects tampering, cross-realm replacement, wrong old keys, and expiry", () => {
    const previous = OfxpIdentity.generateKeyPair()
    const other = OfxpIdentity.generateKeyPair()
    const next = OfxpIdentity.generateKeyPair()
    const proof = OfxpRekey.create({
      current: previous,
      currentRealmID: "realm:rekey",
      next: identity(next),
      nonce: Ofxp.PairingNonce.make("B".repeat(43)),
      now: 5_000,
    })
    const trusted = { peerID: previous.peerID, realmID: "realm:rekey", publicKeySpki: previous.publicKeySpki }

    expect(() => OfxpRekey.verify({ proof: { ...proof, next: { ...proof.next, label: "Tampered" } }, previous: trusted, now: 5_001 })).toThrow(
      "signature is invalid",
    )
    expect(() => OfxpRekey.verify({ proof, previous: { ...trusted, realmID: "realm:other" }, now: 5_001 })).toThrow(
      "crosses trust realms",
    )
    expect(() =>
      OfxpRekey.verify({
        proof,
        previous: { peerID: previous.peerID, realmID: "realm:rekey", publicKeySpki: other.publicKeySpki },
        now: 5_001,
      }),
    ).toThrow("trusted previous identity")
    expect(() => OfxpRekey.verify({ proof, previous: trusted, now: proof.expiresAt })).toThrow("expired")
  })

  test("refuses to create a cross-realm or same-key rotation", () => {
    const previous = OfxpIdentity.generateKeyPair()
    const next = OfxpIdentity.generateKeyPair()
    expect(() =>
      OfxpRekey.create({ current: previous, currentRealmID: "realm:a", next: identity(next, "realm:b"), now: 1_000 }),
    ).toThrow("same realm")
    expect(() =>
      OfxpRekey.create({ current: previous, currentRealmID: "realm:a", next: identity(previous, "realm:a"), now: 1_000 }),
    ).toThrow("replace the identity key")
  })
})
