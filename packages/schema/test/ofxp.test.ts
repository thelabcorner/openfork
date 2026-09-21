import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Ofxp } from "../src/ofxp"
import { SessionID } from "../src/session-id"

describe("OFXP protocol schema", () => {
  test("encodes protocol v1 hello without endpoint or secret fields", () => {
    const peerID = Ofxp.PeerID.make(`ofxp_${"A".repeat(43)}`)
    const hello: Ofxp.Hello = {
      protocolMin: 1,
      protocolMax: 1,
      peerID,
      realmID: "realm:test",
      openforkVersion: "1.18.30",
      surfaceFingerprint: "sha256:test-surface",
      features: {
        pairing: true,
        capabilityExchange: false,
        messaging: false,
        supervision: false,
        delegation: false,
      },
    }
    const encoded = Schema.encodeSync(Ofxp.Hello)(hello)
    expect(encoded.peerID).toBe(peerID)
    expect(Object.hasOwn(encoded, "port")).toBe(false)
    expect(Object.hasOwn(encoded, "token")).toBe(false)
  })

  test("invocation context carries explicit causal lineage and bounded hop count", () => {
    const peerID = Ofxp.PeerID.make(`ofxp_${"B".repeat(43)}`)
    const value: Ofxp.InvocationContext = {
      invocationID: Ofxp.InvocationID.create(),
      traceID: Ofxp.TraceID.create(),
      sourcePeerID: peerID,
      sourceSessionID: SessionID.descending(),
      plane: "augmentation",
      hopCount: 0,
    }
    expect(Schema.decodeUnknownSync(Ofxp.InvocationContext)(value).sourcePeerID).toBe(peerID)
    expect(() => Schema.decodeUnknownSync(Ofxp.InvocationContext)({ ...value, hopCount: 17 })).toThrow()
  })

  test("invocation context can represent an external principal without fabricating a Session", () => {
    const peerID = Ofxp.PeerID.make(`ofxp_${"C".repeat(43)}`)
    const value: Ofxp.InvocationContext = {
      invocationID: Ofxp.InvocationID.create(),
      traceID: Ofxp.TraceID.create(),
      sourcePeerID: peerID,
      source: { kind: "external", principal: "oxp:connector-test" },
      plane: "augmentation",
      hopCount: 0,
    }
    const decoded = Schema.decodeUnknownSync(Ofxp.InvocationContext)(value)
    expect(decoded.source).toEqual({ kind: "external", principal: "oxp:connector-test" })
    expect(decoded.sourceSessionID).toBeUndefined()
  })
})
