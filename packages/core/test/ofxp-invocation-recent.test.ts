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

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, OfxpPeer.node, OfxpInvocation.node]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

function identity(label: string) {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID: "realm:recent-activity",
      label,
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    } satisfies Ofxp.PeerIdentity,
  }
}

function admit(
  receipts: OfxpInvocation.Interface,
  sourcePeerID: Ofxp.PeerID,
  input: { operation: string; now: number; digestByte: string },
) {
  return receipts.admit({
    invocationID: Ofxp.InvocationID.create(),
    sourcePeerID,
    operation: input.operation,
    commitClass: "safe_read",
    requestDigest: `sha256:${input.digestByte.repeat(64)}`,
    now: input.now,
  })
}

describe("OFXP recent invocation projection", () => {
  it.effect("returns a bounded newest-first projection with optional peer filtering", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const receipts = yield* OfxpInvocation.Service
      const alpha = identity("Alpha")
      const bravo = identity("Bravo")
      yield* peers.trust({ identity: alpha.identity, now: 100 })
      yield* peers.trust({ identity: bravo.identity, now: 101 })

      const alphaOld = yield* admit(receipts, alpha.key.peerID, { operation: "read", now: 1_000, digestByte: "a" })
      const bravoMiddle = yield* admit(receipts, bravo.key.peerID, { operation: "find", now: 2_000, digestByte: "b" })
      const alphaNewest = yield* admit(receipts, alpha.key.peerID, { operation: "git.status", now: 3_000, digestByte: "c" })

      const global = yield* receipts.recent({ limit: 2, now: 3_000 })
      expect(global.map((item) => item.invocationID)).toEqual([
        alphaNewest.receipt.invocationID,
        bravoMiddle.receipt.invocationID,
      ])

      const alphaOnly = yield* receipts.recent({ sourcePeerID: alpha.key.peerID, limit: 10, now: 3_000 })
      expect(alphaOnly.map((item) => item.invocationID)).toEqual([
        alphaNewest.receipt.invocationID,
        alphaOld.receipt.invocationID,
      ])
    }),
  )

  it.effect("enforces retention at read time and clamps an oversized request", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const receipts = yield* OfxpInvocation.Service
      const peer = identity("Retention")
      yield* peers.trust({ identity: peer.identity, now: 100 })

      yield* admit(receipts, peer.key.peerID, { operation: "read", now: 1_000, digestByte: "d" })
      const expired = yield* receipts.recent({
        sourcePeerID: peer.key.peerID,
        now: 1_000 + OfxpInvocation.RETENTION_MS + 1,
      })
      expect(expired).toEqual([])

      for (let index = 0; index < OfxpInvocation.RECENT_MAX_LIMIT + 5; index++) {
        yield* admit(receipts, peer.key.peerID, {
          operation: "read",
          now: 2_000 + index,
          digestByte: "e",
        })
      }
      const capped = yield* receipts.recent({
        sourcePeerID: peer.key.peerID,
        limit: OfxpInvocation.RECENT_MAX_LIMIT + 1_000,
        now: 2_000 + OfxpInvocation.RECENT_MAX_LIMIT + 5,
      })
      expect(capped).toHaveLength(OfxpInvocation.RECENT_MAX_LIMIT)
    }),
  )

  it.effect("batches per-peer summaries in one bounded projection without cross-peer starvation", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const receipts = yield* OfxpInvocation.Service
      const alpha = identity("Alpha batch")
      const bravo = identity("Bravo batch")
      yield* peers.trust({ identity: alpha.identity, now: 100 })
      yield* peers.trust({ identity: bravo.identity, now: 101 })

      for (let index = 0; index < 12; index++) {
        yield* admit(receipts, alpha.key.peerID, {
          operation: "read",
          now: 10_000 + index,
          digestByte: "a",
        })
      }
      const bravoReceipt = yield* admit(receipts, bravo.key.peerID, {
        operation: "find",
        now: 9_000,
        digestByte: "b",
      })

      const activity = yield* receipts.recentByPeer({
        sourcePeerIDs: [alpha.key.peerID, bravo.key.peerID, alpha.key.peerID],
        perPeerLimit: 3,
        now: 10_020,
      })

      expect(activity).toHaveLength(2)
      expect(activity[0]?.sourcePeerID).toBe(alpha.key.peerID)
      expect(activity[0]?.receipts).toHaveLength(3)
      expect(activity[1]?.sourcePeerID).toBe(bravo.key.peerID)
      expect(activity[1]?.receipts.map((item) => item.invocationID)).toEqual([bravoReceipt.receipt.invocationID])
    }),
  )
})
