import { describe, expect, test } from "bun:test"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpPairing } from "@opencode-ai/core/ofxp-peer/pairing"
import { OfxpCertificate } from "../../src/ofxp/certificate"
import { OfxpTransport } from "../../src/ofxp/transport"

async function peer(label: string) {
  const key = OfxpIdentity.generateKeyPair()
  const identity = {
    id: key.peerID,
    realmID: `realm:${label.toLowerCase()}`,
    label,
    publicKeySpki: key.publicKeySpki,
    fingerprint: key.fingerprint,
  }
  return {
    key,
    identity,
    material: await OfxpCertificate.issue(key),
    pairing: new OfxpPairing.Coordinator(identity),
    hello: {
      protocolMin: 1 as const,
      protocolMax: 1 as const,
      peerID: key.peerID,
      realmID: identity.realmID,
      openforkVersion: "test",
      surfaceFingerprint: "sha256:test-bootstrap",
      features: {
        pairing: true,
        capabilityExchange: false,
        messaging: false,
        supervision: false,
        delegation: false,
      },
    },
  }
}

describe("OFXP TLS bootstrap transport", () => {
  test("mutually presents durable identities and verifies the expected server peer", async () => {
    const a = await peer("Desktop")
    const b = await peer("Homelab")
    const endpoint = await OfxpTransport.start({
      material: b.material,
      identity: b.identity,
      hello: b.hello,
      pairing: b.pairing,
    })
    try {
      const result = await OfxpTransport.hello({
        material: a.material,
        endpoint,
        expectedPeerID: b.key.peerID,
      })
      expect(result.peer.peerID).toBe(b.key.peerID)
      expect(result.hello.peerID).toBe(b.key.peerID)
    } finally {
      await endpoint.stop()
    }
  })

  test("is bidirectional: each peer can independently listen and originate", async () => {
    const a = await peer("Desktop")
    const b = await peer("Homelab")
    const [endpointA, endpointB] = await Promise.all([
      OfxpTransport.start({ material: a.material, identity: a.identity, hello: a.hello, pairing: a.pairing }),
      OfxpTransport.start({ material: b.material, identity: b.identity, hello: b.hello, pairing: b.pairing }),
    ])
    try {
      const [aToB, bToA] = await Promise.all([
        OfxpTransport.hello({ material: a.material, endpoint: endpointB, expectedPeerID: b.key.peerID }),
        OfxpTransport.hello({ material: b.material, endpoint: endpointA, expectedPeerID: a.key.peerID }),
      ])
      expect(aToB.hello.peerID).toBe(b.key.peerID)
      expect(bToA.hello.peerID).toBe(a.key.peerID)
    } finally {
      await Promise.all([endpointA.stop(), endpointB.stop()])
    }
  })

  test("fails closed when discovery points at an endpoint with the wrong cryptographic peer", async () => {
    const a = await peer("A")
    const b = await peer("B")
    const impostor = await peer("Impostor")
    const endpoint = await OfxpTransport.start({
      material: impostor.material,
      identity: impostor.identity,
      hello: impostor.hello,
      pairing: impostor.pairing,
    })
    try {
      await expect(
        OfxpTransport.hello({ material: a.material, endpoint, expectedPeerID: b.key.peerID }),
      ).rejects.toThrow("peer identity mismatch")
    } finally {
      await endpoint.stop()
    }
  })

  test("binds the pairing transcript identity to the TLS client certificate", async () => {
    const a = await peer("A")
    const b = await peer("B")
    const fake = await peer("Fake")
    const endpoint = await OfxpTransport.start({
      material: b.material,
      identity: b.identity,
      hello: b.hello,
      pairing: b.pairing,
    })
    try {
      const offer = a.pairing.begin()
      const success = await OfxpTransport.offerPairing({
        material: a.material,
        endpoint,
        expectedPeerID: b.key.peerID,
        offer,
      })
      const aPreview = a.pairing.acceptAnswer(success.answer)
      const bPreview = b.pairing.preview(offer.pairingID)
      if (!bPreview) throw new Error("OFXP responder did not preview the pairing offer")
      expect(aPreview.sas).toBe(bPreview.sas)
      expect(aPreview.peer.id).toBe(b.key.peerID)
      expect(bPreview.peer.id).toBe(a.key.peerID)

      const forgedOffer = { ...fake.pairing.begin(), pairingID: fake.pairing.begin().pairingID }
      await expect(OfxpTransport.requestJson({
        material: a.material,
        endpoint,
        expectedPeerID: b.key.peerID,
        method: "pair.offer",
        body: forgedOffer,
      })).rejects.toThrow("pairing_tls_identity_mismatch")
    } finally {
      await endpoint.stop()
    }
  })

  test("rate-limits one network source even when it rotates pre-pairing identities", async () => {
    const serverPeer = await peer("RateLimitServer")
    const endpoint = await OfxpTransport.start({
      material: serverPeer.material,
      identity: serverPeer.identity,
      hello: serverPeer.hello,
      pairing: serverPeer.pairing,
    })

    try {
      const clients = await Promise.all(Array.from({ length: 13 }, (_, index) => peer(`Source-${index}`)))
      for (const client of clients.slice(0, 12)) {
        const result = await OfxpTransport.offerPairing({
          material: client.material,
          endpoint,
          expectedPeerID: serverPeer.key.peerID,
          offer: client.pairing.begin(),
        })
        expect(result.answer.responder.id).toBe(serverPeer.key.peerID)
      }

      const blocked = clients[12]!
      await expect(
        OfxpTransport.offerPairing({
          material: blocked.material,
          endpoint,
          expectedPeerID: serverPeer.key.peerID,
          offer: blocked.pairing.begin(),
        }),
      ).rejects.toThrow("pairing_rate_limited")
    } finally {
      await endpoint.stop()
    }
  })

  test("propagates client timeout as remote request cancellation", async () => {
    const a = await peer("A")
    const b = await peer("B")
    let resolveAborted!: () => void
    const aborted = new Promise<void>((resolve) => (resolveAborted = resolve))
    const endpoint = await OfxpTransport.start({
      material: b.material,
      identity: b.identity,
      hello: b.hello,
      pairing: b.pairing,
      application: async ({ signal }) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            resolveAborted()
            resolve({ cancelled: true })
            return
          }
          signal.addEventListener(
            "abort",
            () => {
              resolveAborted()
              resolve({ cancelled: true })
            },
            { once: true },
          )
        }),
    })
    const connection = await OfxpTransport.ClientConnection.connect({
      material: a.material,
      host: endpoint.host,
      port: endpoint.port,
      expectedPeerID: b.key.peerID,
    })
    try {
      await expect(connection.request("slow", {}, 20)).rejects.toThrow("timed out")
      await Promise.race([
        aborted,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("remote cancellation was not observed")), 500)),
      ])
    } finally {
      await connection.close()
      await endpoint.stop()
    }
  })
})
