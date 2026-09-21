import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, OfxpPeer.node]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

function identity(label = "Homelab") {
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

function peerLayer(filename: string) {
  return AppNodeBuilder.build(
    LayerNode.group([Database.node, OfxpPeer.node]),
    [[Database.node, Database.layerFromPath(filename)]],
  )
}

function runPeer<A, E>(filename: string, effect: Effect.Effect<A, E, OfxpPeer.Service>) {
  return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(peerLayer(filename)))) as Effect.Effect<A, E>)
}

function tempRoot(prefix: string) {
  return Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(join(os.tmpdir(), prefix))),
    (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
  )
}

describe("OFXP peer trust domain", () => {
  test("propagates durable authority generations between independent services sharing one SQLite file", async () => {
    await using tmp = await tmpdir()
    const filename = join(tmp.path, "shared-ofxp-authority.db")
    const rootPath = join(tmp.path, "approved-root")
    await fs.mkdir(rootPath, { recursive: true })
    const generated = identity("Cross-process authority")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const contextA = yield* Layer.build(Layer.fresh(peerLayer(filename)))
          const contextB = yield* Layer.build(Layer.fresh(peerLayer(filename)))
          const peersA = Context.get(contextA, OfxpPeer.Service)
          const peersB = Context.get(contextB, OfxpPeer.Service)
          const changesB: OfxpPeer.Change[] = []
          const unsubscribeB = peersB.subscribe((change) => changesB.push(change))

          const expectExternal = (peerID: Ofxp.PeerID) =>
            Effect.gen(function* () {
              const before = changesB.length
              expect(yield* peersB.syncExternalChanges()).toBe(1)
              expect(changesB.slice(before)).toEqual([{ peerID, kind: "authority-changed" }])
            })

          const trusted = yield* peersA.trust({ identity: generated.identity, now: 100 })
          yield* expectExternal(generated.key.peerID)

          const granted = yield* peersA.setGrant({
            peerID: generated.key.peerID,
            expectedRevision: trusted.info.grantRevision,
            grant: { ...Ofxp.DENY_GRANT, read: true },
            now: 110,
          })
          expect(granted.info.grantRevision).toBe(2)
          yield* expectExternal(generated.key.peerID)

          const root = yield* peersA.approveRoot({
            peerID: generated.key.peerID,
            alias: "repo",
            canonicalPath: rootPath,
            now: 120,
          })
          yield* expectExternal(generated.key.peerID)

          // Reachability/liveness metadata is explicitly not an authority
          // generation and must not retire sibling-process resources.
          expect(yield* peersA.markSeen(generated.key.peerID, 130)).toBe(true)
          expect(yield* peersB.syncExternalChanges()).toBe(0)

          expect(yield* peersA.removeRoot({ peerID: generated.key.peerID, rootID: root.id })).toBe(true)
          yield* expectExternal(generated.key.peerID)

          expect(yield* peersA.revokeFenced({ peerID: generated.key.peerID, expectedRevision: 2, now: 140 })).toBe(true)
          yield* expectExternal(generated.key.peerID)

          unsubscribeB()
        }),
      ),
    )
  })

  it.effect("trusts cryptographic identity with deny-by-default grant", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity()
      const peer = yield* peers.trust({ identity: generated.identity, now: 100 })

      expect(peer.info.id).toBe(generated.key.peerID)
      expect(peer.info.fingerprint).toBe(generated.key.fingerprint)
      expect(peer.info.pairedAt).toBe(100)
      expect(peer.info.grantRevision).toBe(1)
      expect(peer.grant).toEqual(Ofxp.DENY_GRANT)
      expect((yield* peers.list()).map((item) => item.info.id)).toEqual([generated.key.peerID])
    }),
  )

  it.effect("rejects a peer ID or fingerprint that is not derived from the presented public key", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const a = identity("A")
      const b = identity("B")
      const error = yield* peers
        .trust({
          identity: { ...a.identity, id: b.key.peerID },
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("OfxpPeer.ValidationError")
    }),
  )

  it.effect("grant updates are optimistic and never merge authority implicitly", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity()
      const trusted = yield* peers.trust({ identity: generated.identity })
      const nextGrant: Ofxp.Grant = { ...Ofxp.DENY_GRANT, read: true, messaging: true }
      const updated = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: nextGrant,
      })
      expect(updated.info.grantRevision).toBe(2)
      expect(updated.grant.read).toBe(true)
      expect(updated.grant.write).toBe(false)

      const stale = yield* peers
        .setGrant({ peerID: generated.key.peerID, expectedRevision: 1, grant: Ofxp.DENY_GRANT })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("OfxpPeer.StaleRevisionError")
    }),
  )

  it.effect("revocation immediately removes a peer from the active projection", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity()
      yield* peers.trust({ identity: generated.identity })
      expect(yield* peers.revoke(generated.key.peerID, 200)).toBe(true)
      expect(yield* peers.markSeen(generated.key.peerID, 300)).toBe(false)
      expect(yield* peers.list()).toHaveLength(0)
      const revoked = yield* peers.list({ includeRevoked: true })
      expect(revoked[0]?.info.revokedAt).toBe(200)
    }),
  )

  it.effect("re-pairing a revoked identity resets authority and approved roots", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const directory = yield* tempRoot("ofxp-repair-")
      const generated = identity()
      const trusted = yield* peers.trust({ identity: generated.identity, now: 100 })
      const granted = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true, process: true },
        now: 110,
      })
      yield* peers.approveRoot({
        peerID: generated.key.peerID,
        alias: "repo",
        canonicalPath: directory,
        now: 120,
      })
      yield* peers.revoke(generated.key.peerID, 130)

      const repaired = yield* peers.trust({ identity: generated.identity, now: 200 })
      expect(repaired.info.pairedAt).toBe(200)
      expect(repaired.info.grantRevision).toBe(granted.info.grantRevision + 1)
      expect(repaired.grant).toEqual(Ofxp.DENY_GRANT)
      expect(yield* peers.roots(generated.key.peerID)).toEqual([])
    }),
  )

  it.effect("approves only absolute root paths and exposes no canonical path in the public projection", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const directory = yield* tempRoot("ofxp-root-")
      const generated = identity()
      yield* peers.trust({ identity: generated.identity })

      const invalid = yield* peers
        .approveRoot({ peerID: generated.key.peerID, alias: "repo", canonicalPath: "relative/repo" })
        .pipe(Effect.flip)
      expect(invalid._tag).toBe("OfxpPeer.ValidationError")

      const root = yield* peers.approveRoot({
        peerID: generated.key.peerID,
        alias: "AlphaGym",
        canonicalPath: directory,
        now: 400,
      })
      expect(root.alias).toBe("alphagym")
      expect(Object.hasOwn(root, "canonicalPath")).toBe(false)
      expect(yield* peers.roots(generated.key.peerID)).toEqual([root])
    }),
  )

  it.effect("revalidates live grant revision, expiry, capability, and root at admission", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const directory = yield* tempRoot("ofxp-auth-")
      const generated = identity()
      const trusted = yield* peers.trust({ identity: generated.identity, now: 1_000 })

      const denied = yield* peers
        .authorize({ peerID: generated.key.peerID, capability: "read", now: 1_001 })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OfxpPeer.AuthorityDeniedError")
      if (denied._tag !== "OfxpPeer.AuthorityDeniedError") throw new Error("expected authority denial")
      expect(denied.reason).toBe("capability_denied")

      const granted = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true, messaging: true, integrations: true, browser: true },
        expiresAt: 2_000,
        now: 1_010,
      })
      const root = yield* peers.approveRoot({
        peerID: generated.key.peerID,
        alias: "repo",
        canonicalPath: directory,
        now: 1_020,
      })

      const missingRoot = yield* peers
        .authorize({ peerID: generated.key.peerID, capability: "read", now: 1_030 })
        .pipe(Effect.flip)
      expect(missingRoot._tag).toBe("OfxpPeer.AuthorityDeniedError")
      if (missingRoot._tag !== "OfxpPeer.AuthorityDeniedError") throw new Error("expected authority denial")
      expect(missingRoot.reason).toBe("root_required")

      const authorized = yield* peers.authorize({
        peerID: generated.key.peerID,
        capability: "read",
        rootID: root.id,
        expectedGrantRevision: granted.info.grantRevision,
        now: 1_030,
      })
      expect(authorized.grantRevision).toBe(granted.info.grantRevision)
      expect(authorized.grantExpiresAt).toBe(2_000)
      expect(authorized.root?.alias).toBe(root.alias)

      const messaging = yield* peers.authorize({
        peerID: generated.key.peerID,
        capability: "messaging",
        expectedGrantRevision: granted.info.grantRevision,
        now: 1_030,
      })
      expect(messaging.root).toBeUndefined()

      const integrations = yield* peers.authorize({
        peerID: generated.key.peerID,
        capability: "integrations",
        expectedGrantRevision: granted.info.grantRevision,
        now: 1_030,
      })
      expect(integrations.root).toBeUndefined()

      const browser = yield* peers.authorize({
        peerID: generated.key.peerID,
        capability: "browser",
        expectedGrantRevision: granted.info.grantRevision,
        now: 1_030,
      })
      expect(browser.root).toBeUndefined()

      const visualBrowser = yield* peers.authorize({
        peerID: generated.key.peerID,
        capability: "browser",
        rootID: root.id,
        requireRoot: true,
        expectedGrantRevision: granted.info.grantRevision,
        now: 1_030,
      })
      expect(visualBrowser.root?.id).toBe(root.id)

      const stale = yield* peers
        .authorize({
          peerID: generated.key.peerID,
          capability: "read",
          rootID: root.id,
          expectedGrantRevision: granted.info.grantRevision - 1,
          now: 1_030,
        })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("OfxpPeer.StaleRevisionError")

      const expired = yield* peers
        .authorize({
          peerID: generated.key.peerID,
          capability: "read",
          rootID: root.id,
          now: 2_000,
        })
        .pipe(Effect.flip)
      expect(expired._tag).toBe("OfxpPeer.AuthorityDeniedError")
      if (expired._tag !== "OfxpPeer.AuthorityDeniedError") throw new Error("expected authority denial")
      expect(expired.reason).toBe("grant_expired")
    }),
  )

  it.effect("publishes authority-relevant peer changes after durable mutations", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const directory = yield* tempRoot("ofxp-events-")
      const generated = identity("Events")
      const changes: OfxpPeer.Change[] = []
      const unsubscribe = peers.subscribe((change) => changes.push(change))

      const trusted = yield* peers.trust({ identity: generated.identity })
      const granted = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, process: true },
      })
      const root = yield* peers.approveRoot({
        peerID: generated.key.peerID,
        alias: "repo",
        canonicalPath: directory,
      })
      expect(yield* peers.removeRoot({ peerID: generated.key.peerID, rootID: root.id })).toBe(true)
      expect(yield* peers.requireRekey(generated.key.peerID)).toBe(true)
      unsubscribe()
      yield* peers.revoke(generated.key.peerID)

      expect(granted.grant.process).toBe(true)
      expect(changes.map((change) => change.kind)).toEqual([
        "trusted",
        "grant-updated",
        "root-upserted",
        "root-removed",
        "rekey-required",
      ])
      expect(changes.find((change) => change.kind === "root-removed")).toMatchObject({ rootID: root.id })
    }),
  )

  it.effect("fails closed when an approved root disappears before execution", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const directory = yield* tempRoot("ofxp-root-gone-")
      const generated = identity()
      const trusted = yield* peers.trust({ identity: generated.identity, now: 100 })
      const granted = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true },
        now: 110,
      })
      const root = yield* peers.approveRoot({ peerID: generated.key.peerID, alias: "repo", canonicalPath: directory, now: 120 })
      yield* Effect.promise(() => fs.rm(directory, { recursive: true, force: true }))
      const denied = yield* peers
        .authorize({
          peerID: generated.key.peerID,
          capability: "read",
          rootID: root.id,
          expectedGrantRevision: granted.info.grantRevision,
          now: 130,
        })
        .pipe(Effect.flip)
      expect(denied._tag).toBe("OfxpPeer.AuthorityDeniedError")
      if (denied._tag !== "OfxpPeer.AuthorityDeniedError") throw new Error("expected authority denial")
      expect(denied.reason).toBe("root_not_found")
    }),
  )

  it.effect("revocation and re-key state fail closed at live admission", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity()
      const trusted = yield* peers.trust({ identity: generated.identity, now: 100 })
      const granted = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, messaging: true },
        now: 110,
      })

      yield* peers.requireRekey(generated.key.peerID, 120)
      const rekey = yield* peers
        .authorize({
          peerID: generated.key.peerID,
          capability: "messaging",
          expectedGrantRevision: granted.info.grantRevision,
          now: 121,
        })
        .pipe(Effect.flip)
      expect(rekey._tag).toBe("OfxpPeer.AuthorityDeniedError")
      if (rekey._tag !== "OfxpPeer.AuthorityDeniedError") throw new Error("expected authority denial")
      expect(rekey.reason).toBe("rekey_required")

      yield* peers.trust({ identity: generated.identity, now: 130 })
      yield* peers.revoke(generated.key.peerID, 140)
      const revoked = yield* peers
        .authorize({ peerID: generated.key.peerID, capability: "messaging", now: 141 })
        .pipe(Effect.flip)
      expect(revoked._tag).toBe("OfxpPeer.AuthorityDeniedError")
      if (revoked._tag !== "OfxpPeer.AuthorityDeniedError") throw new Error("expected authority denial")
      expect(revoked.reason).toBe("peer_revoked")
    }),
  )

  it.effect("active-peer catalog access rejects expiry, re-key, and revocation without requiring a capability/root", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity()
      const trusted = yield* peers.trust({ identity: generated.identity, now: 100 })
      const granted = yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true },
        expiresAt: 200,
        now: 110,
      })
      expect((yield* peers.access(generated.key.peerID, 150)).info.grantRevision).toBe(granted.info.grantRevision)

      const expired = yield* peers.access(generated.key.peerID, 200).pipe(Effect.flip)
      expect(expired._tag).toBe("OfxpPeer.PeerAccessDeniedError")
      if (expired._tag !== "OfxpPeer.PeerAccessDeniedError") throw new Error("expected peer access denial")
      expect(expired.reason).toBe("grant_expired")

      yield* peers.setGrant({
        peerID: generated.key.peerID,
        expectedRevision: granted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true },
        now: 210,
      })
      yield* peers.requireRekey(generated.key.peerID, 220)
      const rekey = yield* peers.access(generated.key.peerID, 221).pipe(Effect.flip)
      expect(rekey._tag).toBe("OfxpPeer.PeerAccessDeniedError")
      if (rekey._tag !== "OfxpPeer.PeerAccessDeniedError") throw new Error("expected peer access denial")
      expect(rekey.reason).toBe("rekey_required")

      yield* peers.trust({ identity: generated.identity, now: 230 })
      yield* peers.revoke(generated.key.peerID, 240)
      const revoked = yield* peers.access(generated.key.peerID, 241).pipe(Effect.flip)
      expect(revoked._tag).toBe("OfxpPeer.PeerAccessDeniedError")
      if (revoked._tag !== "OfxpPeer.PeerAccessDeniedError") throw new Error("expected peer access denial")
      expect(revoked.reason).toBe("peer_revoked")
    }),
  )

  it.effect("stale fenced revoke cannot revoke a repaired trust generation", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity()
      const first = yield* peers.trust({ identity: generated.identity, now: 100 })
      yield* peers.revoke(generated.key.peerID, 110)
      const repaired = yield* peers.trust({ identity: generated.identity, now: 120 })
      expect(repaired.info.grantRevision).toBe(first.info.grantRevision + 1)

      const stale = yield* peers
        .revokeFenced({
          peerID: generated.key.peerID,
          expectedRevision: first.info.grantRevision,
          now: 130,
        })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("OfxpPeer.StaleRevisionError")
      expect((yield* peers.get(generated.key.peerID)).info.revokedAt).toBeUndefined()

      expect(
        yield* peers.revokeFenced({
          peerID: generated.key.peerID,
          expectedRevision: repaired.info.grantRevision,
          now: 140,
        }),
      ).toBe(true)
      expect((yield* peers.get(generated.key.peerID)).info.revokedAt).toBe(140)
    }),
  )

  it.effect("stale root approval cannot attach authority after revoke and repair", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const directory = yield* tempRoot("ofxp-stale-root-")
      const generated = identity()
      const first = yield* peers.trust({ identity: generated.identity, now: 100 })
      yield* peers.revoke(generated.key.peerID, 110)
      const repaired = yield* peers.trust({ identity: generated.identity, now: 120 })

      const stale = yield* peers
        .approveRoot({
          peerID: generated.key.peerID,
          expectedGrantRevision: first.info.grantRevision,
          alias: "repo",
          canonicalPath: directory,
          now: 130,
        })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("OfxpPeer.StaleRevisionError")
      expect(yield* peers.roots(generated.key.peerID)).toEqual([])

      const root = yield* peers.approveRoot({
        peerID: generated.key.peerID,
        expectedGrantRevision: repaired.info.grantRevision,
        alias: "repo",
        canonicalPath: directory,
        now: 140,
      })
      expect(root.alias).toBe("repo")
      expect(yield* peers.roots(generated.key.peerID)).toEqual([root])
    }),
  )
})

describe("OFXP identity primitives", () => {
  test("derives stable peer identity from canonical P-256 SPKI", () => {
    const key = OfxpIdentity.generateKeyPair()
    const validated = OfxpIdentity.validateKeyPair(key)
    expect(validated.peerID).toBe(key.peerID)
    expect(validated.fingerprint).toBe(key.fingerprint)
    expect(OfxpIdentity.peerIDFromPublicKey(key.publicKeySpki)).toBe(key.peerID)
  })

  test("derives the same fresh pairing SAS on both ends and changes with either nonce", () => {
    const a = OfxpIdentity.generateKeyPair()
    const b = OfxpIdentity.generateKeyPair()
    const initiatorNonce = OfxpIdentity.createPairingNonce()
    const responderNonce = OfxpIdentity.createPairingNonce()
    const input = {
      initiatorPeerID: a.peerID,
      responderPeerID: b.peerID,
      initiatorNonce,
      responderNonce,
    }
    const sas = OfxpIdentity.pairingSas(input)
    expect(sas).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(OfxpIdentity.pairingSas(input)).toBe(sas)
    expect(OfxpIdentity.pairingSas({ ...input, responderNonce: OfxpIdentity.createPairingNonce() })).not.toBe(sas)
  })

  test("pairing is bidirectional while each side keeps independent directional authority", async () => {
    await using tmp = await tmpdir()
    const a = identity("Desktop")
    const b = identity("Homelab")
    const aDb = join(tmp.path, "a.sqlite")
    const bDb = join(tmp.path, "b.sqlite")

    const aView = await runPeer(
      aDb,
      Effect.gen(function* () {
        const peers = yield* OfxpPeer.Service
        const trusted = yield* peers.trust({ identity: b.identity, now: 100 })
        return yield* peers.setGrant({
          peerID: b.key.peerID,
          expectedRevision: trusted.info.grantRevision,
          grant: { ...Ofxp.DENY_GRANT, read: true },
          now: 110,
        })
      }),
    )

    const bView = await runPeer(
      bDb,
      Effect.gen(function* () {
        const peers = yield* OfxpPeer.Service
        const trusted = yield* peers.trust({ identity: a.identity, now: 200 })
        return yield* peers.setGrant({
          peerID: a.key.peerID,
          expectedRevision: trusted.info.grantRevision,
          grant: { ...Ofxp.DENY_GRANT, messaging: true },
          now: 210,
        })
      }),
    )

    expect(aView.info.id).toBe(b.key.peerID)
    expect(aView.grant.read).toBe(true)
    expect(aView.grant.messaging).toBe(false)
    expect(bView.info.id).toBe(a.key.peerID)
    expect(bView.grant.messaging).toBe(true)
    expect(bView.grant.read).toBe(false)
  })
})
