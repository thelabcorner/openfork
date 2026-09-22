import { describe, expect, test } from "bun:test"
import {
  parseNetworkIdentityProjection,
  parseStoredNetworkIdentity,
  pinnedIdentityVerdict,
  sameNetworkIdentity,
  type NetworkIdentity,
} from "./network-identity"

const identity: NetworkIdentity = {
  instanceID: "instance-a",
  realmID: "realm-a",
  peerID: "ofxp_peer_a",
  fingerprint: "sha256:abc",
  protocolMin: 1,
  protocolMax: 1,
}

describe("mobile OFXP identity pinning", () => {
  test("parses the public instance identity projection without credentials", () => {
    expect(
      parseNetworkIdentityProjection({
        instanceID: identity.instanceID,
        realmID: identity.realmID,
        ofxp: {
          enabled: true,
          peerID: identity.peerID,
          fingerprint: identity.fingerprint,
          protocolMin: 1,
          protocolMax: 1,
          pairing: true,
        },
      }),
    ).toEqual(identity)
  })

  test("does not pin a backend without an OFXP identity", () => {
    expect(parseNetworkIdentityProjection({ instanceID: "x", realmID: "r", ofxp: { enabled: false } })).toBeUndefined()
  })

  test("rejects malformed protocol bounds", () => {
    expect(
      parseNetworkIdentityProjection({
        instanceID: "x",
        realmID: "r",
        ofxp: { enabled: true, peerID: "p", fingerprint: "f", protocolMin: 2, protocolMax: 1 },
      }),
    ).toBeUndefined()
  })

  test("requires peer, fingerprint, and realm continuity", () => {
    expect(sameNetworkIdentity(identity, { ...identity })).toBe(true)
    expect(sameNetworkIdentity(identity, { ...identity, peerID: "other" })).toBe(false)
    expect(sameNetworkIdentity(identity, { ...identity, fingerprint: "other" })).toBe(false)
    expect(sameNetworkIdentity(identity, { ...identity, realmID: "other" })).toBe(false)
  })

  test("round-trips the persisted pin and rejects corrupt JSON", () => {
    expect(parseStoredNetworkIdentity(JSON.stringify(identity))).toEqual(identity)
    expect(parseStoredNetworkIdentity("{")).toBeUndefined()
  })
})

describe("mobile OFXP endpoint identity verdicts", () => {
  test("parses a tunnel-shaped projection without treating transport fields as identity", () => {
    expect(
      parseNetworkIdentityProjection({
        instanceID: identity.instanceID,
        realmID: identity.realmID,
        ofxp: {
          enabled: true,
          peerID: identity.peerID,
          fingerprint: identity.fingerprint,
          protocolMin: identity.protocolMin,
          protocolMax: identity.protocolMax,
          pairing: true,
          endpointHints: [{ port: 41_234 }],
          publicOrigin: "https://api.example.com",
        },
      }),
    ).toEqual(identity)
  })

  test("keeps the pin independent of the transport hostname", () => {
    const overTunnel = { ...identity }
    expect(sameNetworkIdentity(identity, overTunnel)).toBe(true)
    expect(pinnedIdentityVerdict(identity, overTunnel)).toBe("match")
    expect(pinnedIdentityVerdict(identity, { ...identity, realmID: "realm-b" })).toBe("mismatch")
    expect(pinnedIdentityVerdict(identity, undefined)).toBe("unavailable")
    expect(pinnedIdentityVerdict(undefined, identity)).toBe("unpinned")
  })

  test("rejects a tunnel login page instead of pinning it", () => {
    expect(parseNetworkIdentityProjection("<html><body>Sign in</body></html>")).toBeUndefined()
    expect(parseNetworkIdentityProjection([])).toBeUndefined()
    expect(parseNetworkIdentityProjection(null)).toBeUndefined()
  })
})