import { describe, expect, test } from "bun:test"
import { X509Certificate } from "node:crypto"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpCertificate } from "../../src/ofxp/certificate"

describe("OFXP TLS identity certificate", () => {
  test("issues a self-signed P-256 certificate bound to the durable peer identity", async () => {
    const key = OfxpIdentity.generateKeyPair()
    const now = Date.parse("2026-09-20T17:00:00Z")
    const material = await OfxpCertificate.issue(key, now)
    const parsed = new X509Certificate(material.cert)
    const identity = OfxpCertificate.identity(parsed)

    expect(material.peerID).toBe(key.peerID)
    expect(identity.peerID).toBe(key.peerID)
    expect(identity.fingerprint).toBe(key.fingerprint)
    expect(parsed.verify(parsed.publicKey)).toBe(true)
    expect(OfxpCertificate.validAt(parsed, now)).toBe(true)
  })

  test("certificate rotation changes the certificate but preserves peerID", async () => {
    const key = OfxpIdentity.generateKeyPair()
    const first = await OfxpCertificate.issue(key, Date.parse("2026-09-20T17:00:00Z"))
    const second = await OfxpCertificate.issue(key, Date.parse("2026-09-21T17:00:00Z"))

    expect(first.cert).not.toBe(second.cert)
    expect(OfxpCertificate.identity(first.cert).peerID).toBe(key.peerID)
    expect(OfxpCertificate.identity(second.cert).peerID).toBe(key.peerID)
  })

  test("different durable keys cannot collide through certificate metadata", async () => {
    const a = OfxpIdentity.generateKeyPair()
    const b = OfxpIdentity.generateKeyPair()
    const certA = await OfxpCertificate.issue(a)
    const certB = await OfxpCertificate.issue(b)

    expect(OfxpCertificate.identity(certA.cert).peerID).toBe(a.peerID)
    expect(OfxpCertificate.identity(certB.cert).peerID).toBe(b.peerID)
    expect(OfxpCertificate.identity(certA.cert).peerID).not.toBe(OfxpCertificate.identity(certB.cert).peerID)
  })

  test("emits canonical positive serial numbers across repeated certificate rotation", async () => {
    const key = OfxpIdentity.generateKeyPair()
    for (let index = 0; index < 64; index++) {
      const material = await OfxpCertificate.issue(key, Date.parse("2026-09-20T17:00:00Z") + index * 1_000)
      const cert = new X509Certificate(material.cert)
      expect(BigInt(`0x${cert.serialNumber}`)).toBeGreaterThan(0n)
      expect(OfxpCertificate.identity(cert).peerID).toBe(key.peerID)
    }
  })

  test("canonicalizes serial entropy into a minimally encoded positive INTEGER", () => {
    const leadingZero = new Uint8Array(16)
    leadingZero[1] = 0x01
    const zeroResult = new Uint8Array(OfxpCertificate.serialNumber(leadingZero))
    expect(zeroResult[0]).toBe(0x01)

    const negative = new Uint8Array(16).fill(0xff)
    const negativeResult = new Uint8Array(OfxpCertificate.serialNumber(negative))
    expect(negativeResult[0]).toBe(0x7f)
  })
})
