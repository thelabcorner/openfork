import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, OfxpPeer.node]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

function identity(label = "Expiry") {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID: "realm:test",
      label,
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    } satisfies Ofxp.PeerIdentity,
  }
}

describe("OFXP peer grant expiry replacement", () => {
  it.effect("preserves a bounded expiry when granular authority changes omit lifetime", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity()
      const trusted = yield* peers.trust({ identity: generated.identity, now: 100 })
      const bounded = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true },
        expiresAt: 1_000,
        now: 110,
      })

      const edited = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: bounded.info.grantRevision,
        grant: { ...bounded.grant, messaging: true },
        now: 120,
      })

      expect(edited.info.grantRevision).toBe(bounded.info.grantRevision + 1)
      expect(edited.info.grantExpiresAt).toBe(1_000)
      expect(edited.grant.messaging).toBe(true)

      const stale = yield* peers
        .setGrant({
          peerID: generated.key.peerID,
          expectedRevision: bounded.info.grantRevision,
          grant: Ofxp.DENY_GRANT,
          expiresAt: null,
          now: 130,
        })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("OfxpPeer.StaleRevisionError")

      const afterStale = yield* peers.get(generated.key.peerID)
      expect(afterStale.info.grantExpiresAt).toBe(1_000)
      expect(afterStale.info.grantRevision).toBe(edited.info.grantRevision)
    }),
  )

  it.effect("clears a bounded expiry only when the caller explicitly sends null", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity("Explicit clear")
      const trusted = yield* peers.trust({ identity: generated.identity, now: 200 })
      const bounded = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true },
        expiresAt: 2_000,
        now: 210,
      })

      const cleared = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: bounded.info.grantRevision,
        grant: bounded.grant,
        expiresAt: null,
        now: 220,
      })

      expect(cleared.info.grantExpiresAt).toBeUndefined()
      expect(cleared.info.grantRevision).toBe(bounded.info.grantRevision + 1)
    }),
  )
})
