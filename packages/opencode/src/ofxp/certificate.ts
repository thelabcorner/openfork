export * as OfxpCertificate from "./certificate"

import { randomBytes, webcrypto, X509Certificate, type KeyObject } from "node:crypto"
import * as asn1js from "asn1js"
import * as pkijs from "pkijs"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import type { KeyPair } from "@opencode-ai/core/ofxp-peer/identity"
import { Ofxp } from "@opencode-ai/schema/ofxp"

export const VALIDITY_MS = 30 * 24 * 60 * 60 * 1000
export const CLOCK_SKEW_MS = 5 * 60 * 1000

export interface Material {
  readonly peerID: Ofxp.PeerID
  readonly key: string
  readonly cert: string
  readonly notBefore: number
  readonly notAfter: number
}

export interface PeerCertificateIdentity {
  readonly peerID: Ofxp.PeerID
  readonly fingerprint: Ofxp.PublicKeyFingerprint
  readonly publicKeySpki: string
}

function spkiOf(publicKey: KeyObject) {
  return publicKey.export({ type: "spki", format: "pem" }).toString()
}

function derFromPem(value: string, label: "PUBLIC KEY" | "PRIVATE KEY") {
  const body = value
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s/g, "")
  return Uint8Array.from(Buffer.from(body, "base64"))
}

function pemFromDer(value: ArrayBuffer) {
  const base64 = Buffer.from(value).toString("base64")
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`
}

export function serialNumber(input: Uint8Array = randomBytes(16)) {
  if (input.byteLength !== 16) throw new Error("OFXP certificate serial entropy must be exactly 16 bytes")
  const bytes = Uint8Array.from(input)
  // DER INTEGER must be positive and minimally encoded. A leading 0x00 is only
  // legal when needed to suppress the sign bit, so force the first octet into
  // 0x01..0x7f instead of merely masking bit 7.
  bytes[0] = ((bytes[0] ?? 0) & 0x7f) || 1
  return bytes.buffer
}

function cryptoEngine() {
  return new pkijs.CryptoEngine({
    name: "openfork-ofxp",
    crypto: webcrypto as unknown as Crypto,
    subtle: webcrypto.subtle as unknown as SubtleCrypto,
  })
}

/**
 * The certificate's subject/SAN is presentation-only. OFXP identity is derived
 * exclusively from the certificate SPKI and therefore survives certificate
 * rotation while failing closed on a different durable key.
 */
export function identity(cert: string | Buffer | X509Certificate): PeerCertificateIdentity {
  const parsed = cert instanceof X509Certificate ? cert : new X509Certificate(cert)
  if (!parsed.verify(parsed.publicKey)) throw new Error("OFXP TLS certificate is not self-signed by its presented identity key")
  const publicKeySpki = OfxpIdentity.normalizePublicKey(spkiOf(parsed.publicKey))
  return {
    peerID: OfxpIdentity.peerIDFromPublicKey(publicKeySpki),
    fingerprint: OfxpIdentity.fingerprintFromPublicKey(publicKeySpki),
    publicKeySpki,
  }
}

export function validAt(cert: string | Buffer | X509Certificate, now = Date.now()) {
  const parsed = cert instanceof X509Certificate ? cert : new X509Certificate(cert)
  const notBefore = Date.parse(parsed.validFrom)
  const notAfter = Date.parse(parsed.validTo)
  return Number.isFinite(notBefore) && Number.isFinite(notAfter) && notBefore <= now && now < notAfter
}

/**
 * Issue a short-lived self-signed TLS certificate around the durable P-256 OFXP
 * identity key. `pkijs` owns X.509 encoding/signing while Node/OpenSSL owns the
 * key material and TLS cryptography.
 */
export async function issue(keyPair: KeyPair, now = Date.now()): Promise<Material> {
  const validated = OfxpIdentity.validateKeyPair(keyPair)
  const notBefore = now - CLOCK_SKEW_MS
  const notAfter = now + VALIDITY_MS
  const crypto = cryptoEngine()
  const algorithm: EcKeyImportParams = { name: "ECDSA", namedCurve: "P-256" }
  const [publicKey, privateKey] = await Promise.all([
    crypto.importKey("spki", derFromPem(validated.publicKeySpki, "PUBLIC KEY"), algorithm, true, ["verify"]),
    crypto.importKey("pkcs8", derFromPem(keyPair.privateKeyPkcs8, "PRIVATE KEY"), algorithm, true, ["sign"]),
  ])

  const certificate = new pkijs.Certificate()
  certificate.version = 2
  certificate.serialNumber = new asn1js.Integer({ valueHex: serialNumber() })
  const commonName = new pkijs.AttributeTypeAndValue({
    type: "2.5.4.3",
    value: new asn1js.Utf8String({ value: `OpenFork OFXP ${validated.peerID}` }),
  })
  certificate.issuer.typesAndValues.push(commonName)
  certificate.subject.typesAndValues.push(commonName)
  certificate.notBefore.value = new Date(notBefore)
  certificate.notAfter.value = new Date(notAfter)

  const basicConstraints = new pkijs.BasicConstraints({ cA: false })
  const keyUsage = new asn1js.BitString({ valueHex: Uint8Array.from([0x80]).buffer })
  const extendedKeyUsage = new pkijs.ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"] })
  certificate.extensions = [
    new pkijs.Extension({
      extnID: "2.5.29.19",
      critical: true,
      extnValue: basicConstraints.toSchema().toBER(false),
      parsedValue: basicConstraints,
    }),
    new pkijs.Extension({
      extnID: "2.5.29.15",
      critical: true,
      extnValue: keyUsage.toBER(false),
      parsedValue: keyUsage,
    }),
    new pkijs.Extension({
      extnID: "2.5.29.37",
      critical: false,
      extnValue: extendedKeyUsage.toSchema().toBER(false),
      parsedValue: extendedKeyUsage,
    }),
  ]
  await certificate.subjectPublicKeyInfo.importKey(publicKey, crypto)
  await certificate.sign(privateKey, "SHA-256", crypto)
  const cert = pemFromDer(certificate.toSchema(true).toBER(false))

  const certIdentity = identity(cert)
  if (certIdentity.peerID !== validated.peerID || certIdentity.fingerprint !== validated.fingerprint) {
    throw new Error("OFXP TLS certificate public key does not match the durable peer identity")
  }
  if (!validAt(cert, now)) throw new Error("OFXP TLS certificate is not valid at issuance time")

  return Object.freeze({
    peerID: validated.peerID,
    key: keyPair.privateKeyPkcs8,
    cert,
    notBefore,
    notAfter,
  })
}
