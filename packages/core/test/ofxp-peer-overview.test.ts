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
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, OfxpPeer.node]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

function identity(label: string) {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID: "realm:settings-overview",
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

const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
  )

describe("OFXP settings projection", () => {
  it.effect("projects active peers with sorted public roots and current grants", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const alphaRoot = yield* tempRoot("ofxp-overview-alpha-")
      const zetaRoot = yield* tempRoot("ofxp-overview-zeta-")
      const revokedRoot = yield* tempRoot("ofxp-overview-revoked-")
      const alpha = identity("Alpha")
      const bravo = identity("Bravo")
      const revoked = identity("Revoked")

      const alphaTrusted = yield* peers.trust({ identity: alpha.identity, now: 100 })
      yield* peers.trust({ identity: bravo.identity, now: 110 })
      const revokedTrusted = yield* peers.trust({ identity: revoked.identity, now: 120 })

      const alphaGrant = yield* peers.setGrant({
        peerID: alpha.key.peerID,
        expectedRevision: alphaTrusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true, messaging: true },
        now: 130,
      })
      yield* peers.setGrant({
        peerID: revoked.key.peerID,
        expectedRevision: revokedTrusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, process: true },
        now: 140,
      })

      yield* peers.approveRoot({
        peerID: alpha.key.peerID,
        alias: "zeta",
        canonicalPath: zetaRoot,
        now: 150,
      })
      yield* peers.approveRoot({
        peerID: alpha.key.peerID,
        alias: "alpha",
        canonicalPath: alphaRoot,
        now: 160,
      })
      yield* peers.approveRoot({
        peerID: revoked.key.peerID,
        alias: "revoked",
        canonicalPath: revokedRoot,
        now: 170,
      })
      yield* peers.revoke(revoked.key.peerID, 180)

      const overview = yield* peers.overview()

      expect(overview.map((item) => item.record.info.label)).toEqual(["Alpha", "Bravo"])
      expect(overview.some((item) => item.record.info.id === revoked.key.peerID)).toBe(false)

      const alphaView = overview.find((item) => item.record.info.id === alpha.key.peerID)
      expect(alphaView?.record.info.grantRevision).toBe(alphaGrant.info.grantRevision)
      expect(alphaView?.record.grant).toEqual(alphaGrant.grant)
      expect(alphaView?.roots.map((root) => String(root.alias))).toEqual(["alpha", "zeta"])
      expect(alphaView?.roots.every((root) => root.available)).toBe(true)
      expect(alphaView?.roots.every((root) => !Object.hasOwn(root, "canonicalPath"))).toBe(true)

      const bravoView = overview.find((item) => item.record.info.id === bravo.key.peerID)
      expect(bravoView?.record.grant).toEqual(Ofxp.DENY_GRANT)
      expect(bravoView?.roots).toEqual([])
    }),
  )

  it.effect("admits exactly one concurrent grant replacement for one expected revision", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity("Concurrent")
      const trusted = yield* peers.trust({ identity: generated.identity, now: 100 })

      const [readAttempt, writeAttempt] = yield* Effect.all(
        [
          settle(
            peers.setGrant({
              peerID: generated.key.peerID,
              expectedRevision: trusted.info.grantRevision,
              grant: { ...Ofxp.DENY_GRANT, read: true },
              now: 110,
            }),
          ),
          settle(
            peers.setGrant({
              peerID: generated.key.peerID,
              expectedRevision: trusted.info.grantRevision,
              grant: { ...Ofxp.DENY_GRANT, write: true },
              now: 111,
            }),
          ),
        ],
        { concurrency: "unbounded" },
      )

      const attempts = [readAttempt, writeAttempt]
      const winners = attempts.filter((attempt) => attempt.ok)
      const losers = attempts.filter((attempt) => !attempt.ok)

      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      if (losers[0]?.ok !== false) throw new Error("expected one stale grant update")
      expect(losers[0].error._tag).toBe("OfxpPeer.StaleRevisionError")

      const final = yield* peers.get(generated.key.peerID)
      expect(final.info.grantRevision).toBe(trusted.info.grantRevision + 1)
      expect([final.grant.read, final.grant.write].filter(Boolean)).toHaveLength(1)
    }),
  )

  it.effect("re-approves the same canonical root idempotently with a stable root ID", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const directory = yield* tempRoot("ofxp-root-idempotent-")
      const generated = identity("Root Idempotency")
      yield* peers.trust({ identity: generated.identity, now: 100 })

      const first = yield* peers.approveRoot({
        peerID: generated.key.peerID,
        alias: "project",
        canonicalPath: directory,
        source: "project",
        now: 110,
      })
      const second = yield* peers.approveRoot({
        peerID: generated.key.peerID,
        alias: "project",
        canonicalPath: directory,
        source: "project",
        now: 120,
      })

      expect(second.id).toBe(first.id)
      expect(second.alias).toBe(first.alias)
      expect((yield* peers.roots(generated.key.peerID)).map((root) => root.id)).toEqual([first.id])
    }),
  )

  it.effect("serializes concurrent approval retries onto one stable root", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const directory = yield* tempRoot("ofxp-root-concurrent-")
      const generated = identity("Concurrent Root")
      yield* peers.trust({ identity: generated.identity, now: 100 })

      const [first, second] = yield* Effect.all(
        [
          peers.approveRoot({
            peerID: generated.key.peerID,
            alias: "project",
            canonicalPath: directory,
            source: "project",
            now: 110,
          }),
          peers.approveRoot({
            peerID: generated.key.peerID,
            alias: "project",
            canonicalPath: directory,
            source: "project",
            now: 111,
          }),
        ],
        { concurrency: "unbounded" },
      )

      expect(second.id).toBe(first.id)
      expect(yield* peers.roots(generated.key.peerID)).toHaveLength(1)
    }),
  )

  it.effect("rejects an alias already owned by a different canonical root with a typed validation error", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const firstDirectory = yield* tempRoot("ofxp-root-alias-a-")
      const secondDirectory = yield* tempRoot("ofxp-root-alias-b-")
      const generated = identity("Root Alias")
      yield* peers.trust({ identity: generated.identity, now: 100 })

      yield* peers.approveRoot({
        peerID: generated.key.peerID,
        alias: "project",
        canonicalPath: firstDirectory,
        now: 110,
      })
      const collision = yield* peers
        .approveRoot({
          peerID: generated.key.peerID,
          alias: "project",
          canonicalPath: secondDirectory,
          now: 120,
        })
        .pipe(Effect.flip)

      expect(collision._tag).toBe("OfxpPeer.ValidationError")
      expect(collision.message).toContain("alias")
    }),
  )
})
