import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, OfxpPeer.node, OfxpInvocation.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

function identity() {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID: "realm:test",
      label: "Peer",
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    },
  }
}

describe("OFXP invocation receipts", () => {
  it.effect("deduplicates the same invocation and rejects ID reuse with different input", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const receipts = yield* OfxpInvocation.Service
      const peer = identity()
      yield* peers.trust({ identity: peer.identity })
      const invocationID = Ofxp.InvocationID.create()
      const requestDigest = `sha256:${"a".repeat(64)}`
      const first = yield* receipts.admit({
        invocationID,
        sourcePeerID: peer.key.peerID,
        operation: "write",
        commitClass: "idempotent_mutation",
        requestDigest,
      })
      expect(first.fresh).toBe(true)
      const second = yield* receipts.admit({
        invocationID,
        sourcePeerID: peer.key.peerID,
        operation: "write",
        commitClass: "idempotent_mutation",
        requestDigest,
      })
      expect(second.fresh).toBe(false)
      expect(second.receipt.state).toBe("admitted")
      const collision = yield* receipts
        .admit({
          invocationID,
          sourcePeerID: peer.key.peerID,
          operation: "write",
          commitClass: "idempotent_mutation",
          requestDigest: `sha256:${"b".repeat(64)}`,
        })
        .pipe(Effect.flip)
      expect(collision._tag).toBe("OfxpInvocation.CollisionError")
    }),
  )

  it.effect("settles once and keeps settlement idempotent", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const receipts = yield* OfxpInvocation.Service
      const peer = identity()
      yield* peers.trust({ identity: peer.identity })
      const invocationID = Ofxp.InvocationID.create()
      yield* receipts.admit({
        invocationID,
        sourcePeerID: peer.key.peerID,
        operation: "write",
        commitClass: "idempotent_mutation",
        requestDigest: `sha256:${"c".repeat(64)}`,
        targetRef: "/repo/a.txt",
        resultDigest: `sha256:${"d".repeat(64)}`,
      })
      const committed = yield* receipts.settle({ invocationID, state: "committed", now: 200 })
      expect(committed.state).toBe("committed")
      const duplicate = yield* receipts.settle({ invocationID, state: "committed", now: 300 })
      expect(duplicate.settledAt).toBe(200)
      const invalid = yield* receipts.settle({ invocationID, state: "failed" }).pipe(Effect.flip)
      expect(invalid._tag).toBe("OfxpInvocation.InvalidTransitionError")
    }),
  )

  it.effect("durably prepares the intended post-state before commit and keeps it immutable", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const receipts = yield* OfxpInvocation.Service
      const peer = identity()
      yield* peers.trust({ identity: peer.identity })
      const invocationID = Ofxp.InvocationID.create()
      yield* receipts.admit({
        invocationID,
        sourcePeerID: peer.key.peerID,
        operation: "write",
        commitClass: "idempotent_mutation",
        requestDigest: `sha256:${"2".repeat(64)}`,
      })
      const prepared = yield* receipts.prepare({
        invocationID,
        targetRef: "/repo/a.txt",
        resultDigest: `sha256:${"3".repeat(64)}`,
      })
      expect(prepared.state).toBe("started")
      expect(prepared.targetRef).toBe("/repo/a.txt")
      expect(prepared.resultDigest).toBe(`sha256:${"3".repeat(64)}`)
      const duplicate = yield* receipts.prepare({
        invocationID,
        targetRef: "/repo/a.txt",
        resultDigest: `sha256:${"3".repeat(64)}`,
      })
      expect(duplicate.resultDigest).toBe(prepared.resultDigest)
      expect(duplicate.state).toBe("started")
      const changed = yield* receipts
        .prepare({
          invocationID,
          targetRef: "/repo/a.txt",
          resultDigest: `sha256:${"4".repeat(64)}`,
        })
        .pipe(Effect.flip)
      expect(changed._tag).toBe("OfxpInvocation.CollisionError")
    }),
  )

  it.effect("scopes receipt lookup to the authenticated source peer", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const receipts = yield* OfxpInvocation.Service
      const a = identity()
      const b = identity()
      yield* peers.trust({ identity: a.identity })
      yield* peers.trust({ identity: { ...b.identity, label: "Peer B", realmID: "realm:b" } })
      const invocationID = Ofxp.InvocationID.create()
      yield* receipts.admit({
        invocationID,
        sourcePeerID: a.key.peerID,
        operation: "write",
        commitClass: "idempotent_mutation",
        requestDigest: `sha256:${"e".repeat(64)}`,
      })
      expect((yield* receipts.get(a.key.peerID, invocationID)).sourcePeerID).toBe(a.key.peerID)
      const hidden = yield* receipts.get(b.key.peerID, invocationID).pipe(Effect.flip)
      expect(hidden._tag).toBe("OfxpInvocation.NotFoundError")
    }),
  )

  it.effect("prunes receipts older than the bounded retention horizon on admission", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const receipts = yield* OfxpInvocation.Service
      const peer = identity()
      yield* peers.trust({ identity: peer.identity })
      const old = Ofxp.InvocationID.create()
      yield* receipts.admit({
        invocationID: old,
        sourcePeerID: peer.key.peerID,
        operation: "write",
        commitClass: "idempotent_mutation",
        requestDigest: `sha256:${"f".repeat(64)}`,
        now: 1_000,
      })
      yield* receipts.admit({
        invocationID: Ofxp.InvocationID.create(),
        sourcePeerID: peer.key.peerID,
        operation: "write",
        commitClass: "idempotent_mutation",
        requestDigest: `sha256:${"1".repeat(64)}`,
        now: 1_000 + OfxpInvocation.RETENTION_MS + 1,
      })
      const expired = yield* receipts.get(peer.key.peerID, old).pipe(Effect.flip)
      expect(expired._tag).toBe("OfxpInvocation.NotFoundError")
    }),
  )
})
