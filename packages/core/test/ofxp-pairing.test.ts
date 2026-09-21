import { describe, expect, test } from "bun:test"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpPairing } from "@opencode-ai/core/ofxp-peer/pairing"
import { OfxpRekey } from "@opencode-ai/core/ofxp-peer/rekey"

function peer(label: string) {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID: `realm:${label.toLowerCase()}`,
      label,
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    },
  }
}

describe("OFXP bidirectional pairing transcript", () => {
  test("both peers derive the same SAS and only release identity after local confirmation", () => {
    const a = peer("Desktop")
    const b = peer("Homelab")
    const left = new OfxpPairing.Coordinator(a.identity)
    const right = new OfxpPairing.Coordinator(b.identity)
    const offer = left.begin(1_000)
    const accepted = right.acceptOffer(offer, 1_001)
    const preview = left.acceptAnswer(accepted.answer, 1_002)

    expect(preview.sas).toBe(accepted.preview.sas)
    expect(preview.peer.id).toBe(b.key.peerID)
    expect(accepted.preview.peer.id).toBe(a.key.peerID)
    const leftConfirmation = left.confirmWithMetadata(offer.pairingID, 1_003)
    const rightConfirmation = right.confirmWithMetadata(offer.pairingID, 1_003)
    expect(leftConfirmation.peer.id).toBe(b.key.peerID)
    expect(rightConfirmation.peer.id).toBe(a.key.peerID)
    expect(leftConfirmation.startedAt).toBe(1_000)
    expect(rightConfirmation.startedAt).toBe(1_001)
  })

  test("confirmation is single-use", () => {
    const a = peer("A")
    const b = peer("B")
    const left = new OfxpPairing.Coordinator(a.identity)
    const right = new OfxpPairing.Coordinator(b.identity)
    const offer = left.begin(10)
    const { answer } = right.acceptOffer(offer, 11)
    left.acceptAnswer(answer, 12)
    left.confirm(offer.pairingID, 13)
    expect(() => left.confirm(offer.pairingID, 14)).toThrow("already-consumed")
  })

  test("a consumed responder transcript rejects replayed offers until expiry", () => {
    const a = peer("A")
    const b = peer("B")
    const left = new OfxpPairing.Coordinator(a.identity)
    const right = new OfxpPairing.Coordinator(b.identity)
    const offer = left.begin(20)
    const { answer } = right.acceptOffer(offer, 21)
    left.acceptAnswer(answer, 22)
    right.confirm(offer.pairingID, 23)
    expect(() => right.acceptOffer(offer, 24)).toThrow("already consumed")
  })

  test("tampering with the initiator nonce is rejected", () => {
    const a = peer("A")
    const b = peer("B")
    const left = new OfxpPairing.Coordinator(a.identity)
    const right = new OfxpPairing.Coordinator(b.identity)
    const offer = left.begin(100)
    const { answer } = right.acceptOffer(offer, 101)
    expect(() =>
      left.acceptAnswer({ ...answer, initiatorNonce: OfxpIdentity.createPairingNonce() }, 102),
    ).toThrow("does not bind the initiator nonce")
  })

  test("expired sessions are pruned and cannot be confirmed", () => {
    const a = peer("A")
    const coordinator = new OfxpPairing.Coordinator(a.identity)
    const offer = coordinator.begin(500)
    expect(coordinator.size(500)).toBe(1)
    expect(coordinator.size(500 + OfxpPairing.TTL_MS + 1)).toBe(0)
    expect(() => coordinator.confirm(offer.pairingID, 500 + OfxpPairing.TTL_MS + 1)).toThrow("expired")
  })

  test("cancelPeer invalidates completed ceremonies for one peer without touching others", () => {
    const local = peer("Local")
    const a = peer("A")
    const b = peer("B")
    const coordinator = new OfxpPairing.Coordinator(local.identity)

    const remoteA = new OfxpPairing.Coordinator(a.identity)
    const offerA = coordinator.begin(700)
    const answerA = remoteA.acceptOffer(offerA, 701).answer
    coordinator.acceptAnswer(answerA, 702)

    const remoteB = new OfxpPairing.Coordinator(b.identity)
    const offerB = coordinator.begin(710)
    const answerB = remoteB.acceptOffer(offerB, 711).answer
    coordinator.acceptAnswer(answerB, 712)

    expect(coordinator.cancelPeer(a.key.peerID, 713)).toBe(1)
    expect(() => coordinator.confirm(offerA.pairingID, 714)).toThrow("already-consumed")
    expect(coordinator.confirm(offerB.pairingID, 714).id).toBe(b.key.peerID)
    expect(coordinator.cancelPeer(a.key.peerID, 715)).toBe(0)
  })

  test("pending pairing memory is hard-bounded", () => {
    const a = peer("A")
    const coordinator = new OfxpPairing.Coordinator(a.identity)
    for (let i = 0; i < OfxpPairing.MAX_PENDING + 10; i++) coordinator.begin(1_000 + i)
    expect(coordinator.size(1_100)).toBe(OfxpPairing.MAX_PENDING)
  })

  test("carries a same-realm continuity proof through the fresh SAS transcript", () => {
    const previous = peer("Previous")
    const next = peer("Next")
    const responder = peer("Responder")
    const nextIdentity = { ...next.identity, realmID: previous.identity.realmID }
    const initiator = new OfxpPairing.Coordinator(nextIdentity)
    const receiver = new OfxpPairing.Coordinator(responder.identity)
    const proof = OfxpRekey.create({
      current: previous.key,
      currentRealmID: previous.identity.realmID,
      next: nextIdentity,
      now: 1_000,
    })

    const offer = initiator.begin(1_001, proof)
    const accepted = receiver.acceptOffer(offer, 1_002)
    const preview = initiator.acceptAnswer(accepted.answer, 1_003)

    expect(accepted.preview.rekeyProof).toEqual(proof)
    // The initiator's own continuity proof is not remote metadata on its local
    // preview; only the responder/operator needs to consume it.
    expect(preview.rekeyProof).toBeUndefined()
    expect(preview.sas).toBe(accepted.preview.sas)
    expect(receiver.confirmWithMetadata(offer.pairingID, 1_004).rekeyProof).toEqual(proof)
  })

  test("carries responder continuity proof back to the initiating operator", () => {
    const initiatorPeer = peer("Initiator")
    const previous = peer("PreviousResponder")
    const next = peer("NextResponder")
    const nextIdentity = { ...next.identity, realmID: previous.identity.realmID }
    const initiator = new OfxpPairing.Coordinator(initiatorPeer.identity)
    const responder = new OfxpPairing.Coordinator(nextIdentity)
    const proof = OfxpRekey.create({
      current: previous.key,
      currentRealmID: previous.identity.realmID,
      next: nextIdentity,
      now: 3_000,
    })

    const offer = initiator.begin(3_001)
    const accepted = responder.acceptOffer(offer, 3_002, proof)
    const preview = initiator.acceptAnswer(accepted.answer, 3_003)

    expect(accepted.preview.rekeyProof).toBeUndefined()
    expect(preview.rekeyProof).toEqual(proof)
    expect(initiator.confirmWithMetadata(offer.pairingID, 3_004).rekeyProof).toEqual(proof)
  })

  test("rejects a continuity proof for a different initiating identity", () => {
    const previous = peer("Previous")
    const next = peer("Next")
    const other = peer("Other")
    const nextIdentity = { ...next.identity, realmID: previous.identity.realmID }
    const proof = OfxpRekey.create({
      current: previous.key,
      currentRealmID: previous.identity.realmID,
      next: nextIdentity,
      now: 2_000,
    })
    const coordinator = new OfxpPairing.Coordinator({ ...other.identity, realmID: previous.identity.realmID })
    expect(() => coordinator.begin(2_001, proof)).toThrow("does not describe the initiating identity")
  })
})
