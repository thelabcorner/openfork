export * as OfxpIdentity from "./identity"

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto"
import { Ofxp } from "@opencode-ai/schema/ofxp"

const CURVE = "prime256v1"
const PAIRING_CONTEXT = "OpenFork OFXP pairing SAS v1"
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export interface KeyPair {
  readonly peerID: Ofxp.PeerID
  readonly fingerprint: Ofxp.PublicKeyFingerprint
  readonly publicKeySpki: string
  readonly privateKeyPkcs8: string
}

function publicKeyObject(value: string) {
  const key = createPublicKey(value)
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== CURVE) {
    throw new Error("OFXP identity key must be an EC P-256 public key")
  }
  return key
}

function spkiDer(value: string) {
  return publicKeyObject(value).export({ type: "spki", format: "der" })
}

function digest(value: string) {
  return createHash("sha256").update(spkiDer(value)).digest()
}

export function normalizePublicKey(value: string) {
  return publicKeyObject(value).export({ type: "spki", format: "pem" }).toString()
}

export function peerIDFromPublicKey(value: string): Ofxp.PeerID {
  return Ofxp.PeerID.make(`ofxp_${digest(value).toString("base64url")}`)
}

export function fingerprintFromPublicKey(value: string): Ofxp.PublicKeyFingerprint {
  return Ofxp.PublicKeyFingerprint.make(`sha256:${digest(value).toString("hex")}`)
}

export function publicKeyFromPrivateKey(value: string) {
  const privateKey = createPrivateKey(value)
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== CURVE) {
    throw new Error("OFXP identity key must be an EC P-256 private key")
  }
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString()
}

export function generateKeyPair(): KeyPair {
  const generated = generateKeyPairSync("ec", {
    namedCurve: CURVE,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const publicKeySpki = normalizePublicKey(generated.publicKey)
  return Object.freeze({
    peerID: peerIDFromPublicKey(publicKeySpki),
    fingerprint: fingerprintFromPublicKey(publicKeySpki),
    publicKeySpki,
    privateKeyPkcs8: generated.privateKey,
  })
}

export function validateKeyPair(input: { readonly publicKeySpki: string; readonly privateKeyPkcs8: string }) {
  const publicKeySpki = normalizePublicKey(input.publicKeySpki)
  const derived = normalizePublicKey(publicKeyFromPrivateKey(input.privateKeyPkcs8))
  if (publicKeySpki !== derived) throw new Error("OFXP public/private identity keypair does not match")
  return {
    peerID: peerIDFromPublicKey(publicKeySpki),
    fingerprint: fingerprintFromPublicKey(publicKeySpki),
    publicKeySpki,
  }
}

export function validatePeerIdentity(identity: Ofxp.PeerIdentity) {
  const publicKeySpki = normalizePublicKey(identity.publicKeySpki)
  const peerID = peerIDFromPublicKey(publicKeySpki)
  const fingerprint = fingerprintFromPublicKey(publicKeySpki)
  if (peerID !== identity.id) throw new Error("OFXP peer ID does not match its public identity key")
  if (fingerprint !== identity.fingerprint) throw new Error("OFXP peer fingerprint does not match its public identity key")
  return { ...identity, publicKeySpki, id: peerID, fingerprint }
}

export function createPairingNonce(): Ofxp.PairingNonce {
  return Ofxp.PairingNonce.make(randomBytes(32).toString("base64url"))
}

function crockford(input: Uint8Array) {
  let bits = 0
  let buffer = 0
  let result = ""
  for (const byte of input) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += CROCKFORD[(buffer >>> bits) & 31]
      if (result.length === 12) return result
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0 && result.length < 12) result += CROCKFORD[(buffer << (5 - bits)) & 31]
  return result.slice(0, 12)
}

/**
 * Human-verifiable 60-bit short-authentication string. Both peers must compute
 * this from the same authenticated pairing transcript and the operator must
 * compare both displays before trust is committed.
 */
export function pairingSas(input: {
  readonly initiatorPeerID: Ofxp.PeerID
  readonly responderPeerID: Ofxp.PeerID
  readonly initiatorNonce: Ofxp.PairingNonce
  readonly responderNonce: Ofxp.PairingNonce
}) {
  const hash = createHash("sha256")
    .update(PAIRING_CONTEXT, "utf8")
    .update("\0")
    .update(input.initiatorPeerID, "utf8")
    .update("\0")
    .update(input.responderPeerID, "utf8")
    .update("\0")
    .update(input.initiatorNonce, "utf8")
    .update("\0")
    .update(input.responderNonce, "utf8")
    .digest()
  const code = crockford(hash)
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`
}

