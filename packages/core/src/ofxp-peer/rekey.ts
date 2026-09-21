export * as OfxpRekey from "./rekey"

import { sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import { Schema } from "effect"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpIdentity, type KeyPair } from "./identity"

const CONTEXT = "OpenFork OFXP re-key continuity v1"
export const TTL_MS = 5 * 60 * 1000
export const MAX_FUTURE_SKEW_MS = 30 * 1000

export interface CreateInput {
  readonly current: KeyPair
  readonly currentRealmID: string
  readonly next: Ofxp.PeerIdentity
  readonly nonce?: Ofxp.PairingNonce
  readonly now?: number
}

export interface VerifyInput {
  readonly proof: Ofxp.RekeyProof
  readonly previous: {
    readonly peerID: Ofxp.PeerID
    readonly realmID: string
    readonly publicKeySpki: string
  }
  readonly now?: number
}

function validRealm(value: string) {
  const realm = value.trim()
  if (!realm || realm.length > 256 || /[\x00-\x1f\x7f]/.test(realm)) throw new Error("OFXP re-key realm is invalid")
  return realm
}

function normalizedIdentity(value: Ofxp.PeerIdentity) {
  const decoded = Schema.decodeUnknownSync(Ofxp.PeerIdentity)(value, { onExcessProperty: "error" })
  return OfxpIdentity.validatePeerIdentity(decoded)
}

function payload(proof: Omit<Ofxp.RekeyProof, "signature">) {
  // Array JSON is deliberately canonical here: fixed positional fields only,
  // no object-key ordering dependency, and normalized PEM identity material.
  return Buffer.from(
    JSON.stringify([
      CONTEXT,
      proof.algorithm,
      proof.previousPeerID,
      proof.next.id,
      proof.next.realmID,
      proof.next.label,
      proof.next.publicKeySpki,
      proof.next.fingerprint,
      proof.nonce,
      proof.issuedAt,
      proof.expiresAt,
    ]),
    "utf8",
  )
}

/**
 * Create proof that the holder of the old OFXP private key authorized a specific
 * new identity in the same realm. This proves continuity only: it grants no
 * authority and must still be followed by an operator-confirmed pairing/re-key
 * ceremony before durable trust changes.
 */
export function create(input: CreateInput): Ofxp.RekeyProof {
  const current = OfxpIdentity.validateKeyPair(input.current)
  const currentRealmID = validRealm(input.currentRealmID)
  const next = normalizedIdentity(input.next)
  if (next.realmID !== currentRealmID) throw new Error("OFXP re-key must remain in the same realm")
  if (next.id === current.peerID) throw new Error("OFXP re-key must replace the identity key")
  const issuedAt = input.now ?? Date.now()
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("OFXP re-key timestamp is invalid")
  const unsigned = {
    algorithm: "ecdsa-p256-sha256-v1",
    previousPeerID: current.peerID,
    next,
    nonce: input.nonce ?? OfxpIdentity.createPairingNonce(),
    issuedAt,
    expiresAt: issuedAt + TTL_MS,
  } as const satisfies Omit<Ofxp.RekeyProof, "signature">
  const signature = cryptoSign("sha256", payload(unsigned), input.current.privateKeyPkcs8).toString("base64url")
  return Schema.decodeUnknownSync(Ofxp.RekeyProof)({ ...unsigned, signature }, { onExcessProperty: "error" })
}

/**
 * Verify old-key continuity for a proposed replacement identity. The caller must
 * still run fresh SAS verification and explicitly commit the durable re-key.
 */
export function verify(input: VerifyInput): Ofxp.PeerIdentity {
  const proof = Schema.decodeUnknownSync(Ofxp.RekeyProof)(input.proof, { onExcessProperty: "error" })
  const previousRealmID = validRealm(input.previous.realmID)
  const previousPublicKeySpki = OfxpIdentity.normalizePublicKey(input.previous.publicKeySpki)
  const derivedPreviousPeerID = OfxpIdentity.peerIDFromPublicKey(previousPublicKeySpki)
  if (derivedPreviousPeerID !== input.previous.peerID || proof.previousPeerID !== input.previous.peerID) {
    throw new Error("OFXP re-key proof does not match the trusted previous identity")
  }
  const next = normalizedIdentity(proof.next)
  if (next.realmID !== previousRealmID) throw new Error("OFXP re-key proof crosses trust realms")
  if (next.id === proof.previousPeerID) throw new Error("OFXP re-key proof does not replace the identity key")
  if (proof.expiresAt <= proof.issuedAt || proof.expiresAt - proof.issuedAt > TTL_MS) {
    throw new Error("OFXP re-key proof has an invalid lifetime")
  }
  const now = input.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("OFXP re-key verification time is invalid")
  if (proof.issuedAt > now + MAX_FUTURE_SKEW_MS) throw new Error("OFXP re-key proof is not yet valid")
  if (proof.expiresAt <= now) throw new Error("OFXP re-key proof expired")
  const { signature, ...unsigned } = proof
  if (!cryptoVerify("sha256", payload(unsigned), previousPublicKeySpki, Buffer.from(signature, "base64url"))) {
    throw new Error("OFXP re-key proof signature is invalid")
  }
  return next
}
