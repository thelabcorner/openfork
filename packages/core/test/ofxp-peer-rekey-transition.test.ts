import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpRekey } from "@opencode-ai/core/ofxp-peer/rekey"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, OfxpPeer.node]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

function generated(label: string, realmID = "realm:rekey-transition") {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID,
      label,
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    } satisfies Ofxp.PeerIdentity,
  }
}

function tempRoot(prefix: string) {
  return Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(join(os.tmpdir(), prefix))),
    (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
  )
}

describe("OFXP durable re-key transition", () => {
  it.effect("revokes old trust and creates the replacement deny-by-default without transferring roots", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const directory = yield* tempRoot("ofxp-rekey-transition-")
      const previous = generated("Previous")
      const next = generated("Next")
      const trusted = yield* peers.trust({ identity: previous.identity, now: 100 })
      yield* peers.setGrant({
        peerID: previous.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true, messaging: true },
        now: 110,
      })
      yield* peers.approveRoot({
        peerID: previous.key.peerID,
        alias: "work",
        canonicalPath: directory,
        now: 120,
      })
      const proof = OfxpRekey.create({
        current: previous.key,
        currentRealmID: previous.identity.realmID,
        next: next.identity,
        now: 130,
      })

      const rotated = yield* peers.rekeyTrust({ proof, now: 140 })
      expect(rotated.info.id).toBe(next.key.peerID)
      expect(rotated.info.pairedAt).toBe(140)
      expect(rotated.info.grantRevision).toBe(1)
      expect(rotated.grant).toEqual(Ofxp.DENY_GRANT)
      expect(yield* peers.roots(next.key.peerID)).toEqual([])

      const all = yield* peers.list({ includeRevoked: true })
      const old = all.find((item) => item.info.id === previous.key.peerID)
      expect(old?.info.revokedAt).toBe(140)
      expect(old?.info.rekeyState).toBe("required")
      expect((yield* peers.list()).map((item) => item.info.id)).toEqual([next.key.peerID])
    }),
  )

  it.effect("rejects replay after old trust was revoked", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const previous = generated("Previous replay")
      const next = generated("Next replay")
      yield* peers.trust({ identity: previous.identity, now: 200 })
      const proof = OfxpRekey.create({
        current: previous.key,
        currentRealmID: previous.identity.realmID,
        next: next.identity,
        now: 210,
      })
      yield* peers.rekeyTrust({ proof, now: 220 })
      const replay = yield* peers.rekeyTrust({ proof, now: 221 }).pipe(Effect.flip)
      expect(replay._tag).toBe("OfxpPeer.ValidationError")
      expect(replay.message).toContain("already revoked")
    }),
  )

  it.effect("rejects tampered continuity before mutating durable trust", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const previous = generated("Previous tamper")
      const next = generated("Next tamper")
      yield* peers.trust({ identity: previous.identity, now: 300 })
      const proof = OfxpRekey.create({
        current: previous.key,
        currentRealmID: previous.identity.realmID,
        next: next.identity,
        now: 310,
      })
      const tampered = { ...proof, next: { ...proof.next, label: "Tampered" } }
      const error = yield* peers.rekeyTrust({ proof: tampered, now: 320 }).pipe(Effect.flip)
      expect(error._tag).toBe("OfxpPeer.ValidationError")
      expect((yield* peers.list()).map((item) => item.info.id)).toEqual([previous.key.peerID])
    }),
  )

  it.effect("refuses to overwrite an independently trusted replacement identity", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const previous = generated("Previous collision")
      const next = generated("Next collision")
      yield* peers.trust({ identity: previous.identity, now: 400 })
      const nextTrusted = yield* peers.trust({ identity: next.identity, now: 401 })
      yield* peers.setGrant({
        peerID: next.key.peerID,
        expectedRevision: nextTrusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, process: true },
        now: 402,
      })
      const proof = OfxpRekey.create({
        current: previous.key,
        currentRealmID: previous.identity.realmID,
        next: next.identity,
        now: 410,
      })

      const error = yield* peers.rekeyTrust({ proof, now: 420 }).pipe(Effect.flip)
      expect(error._tag).toBe("OfxpPeer.ValidationError")
      expect(error.message).toContain("already trusted")
      expect((yield* peers.get(previous.key.peerID)).info.revokedAt).toBeUndefined()
      expect((yield* peers.get(next.key.peerID)).grant.process).toBe(true)
    }),
  )
})
