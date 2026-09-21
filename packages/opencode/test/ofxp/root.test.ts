import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpRoot } from "../../src/ofxp/root"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, FSUtil.node, OfxpPeer.node, OfxpRoot.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

function identity() {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID: "realm:root-test",
      label: "Peer",
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    } satisfies Ofxp.PeerIdentity,
  }
}

describe("OFXP root resolution", () => {
  it.effect("canonicalizes approval and resolves only root-relative targets", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
      const repo = path.join(tmp.path, "repo")
      yield* Effect.promise(() => fs.mkdir(path.join(repo, "src"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(repo, "src", "a.txt"), "hello"))

      const peers = yield* OfxpPeer.Service
      const roots = yield* OfxpRoot.Service
      const remote = identity()
      const trusted = yield* peers.trust({ identity: remote.identity })
      const granted = yield* peers.setGrant({
        peerID: remote.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true },
      })
      const root = yield* roots.approve(remote.key.peerID, repo, "Repo")
      const admission = yield* peers.authorize({
        peerID: remote.key.peerID,
        capability: "read",
        rootID: root.id,
        expectedGrantRevision: granted.info.grantRevision,
      })
      const resolved = yield* roots.resolve(admission, "src/a.txt")
      expect(resolved.virtualPath).toBe("/repo/src/a.txt")
      expect(resolved.path).toBe(path.join(repo, "src", "a.txt"))

      const traversal = yield* roots.resolve(admission, "../outside").pipe(Effect.flip)
      expect(traversal._tag).toBe("OfxpRoot.InvalidPathError")
      const absolute = yield* roots.resolve(admission, path.resolve(repo, "src/a.txt")).pipe(Effect.flip)
      expect(absolute._tag).toBe("OfxpRoot.InvalidPathError")
    }),
  )

  it.effect("permits missing write targets only through a contained existing ancestor", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
      const repo = path.join(tmp.path, "repo")
      yield* Effect.promise(() => fs.mkdir(path.join(repo, "src"), { recursive: true }))
      const peers = yield* OfxpPeer.Service
      const roots = yield* OfxpRoot.Service
      const remote = identity()
      const trusted = yield* peers.trust({ identity: remote.identity })
      const granted = yield* peers.setGrant({
        peerID: remote.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, write: true },
      })
      const root = yield* roots.approve(remote.key.peerID, repo, "Repo")
      const admission = yield* peers.authorize({
        peerID: remote.key.peerID,
        capability: "write",
        rootID: root.id,
        expectedGrantRevision: granted.info.grantRevision,
      })

      const missing = yield* roots.resolve(admission, "src/new/deep/file.txt", { allowMissing: true })
      expect(missing.virtualPath).toBe("/repo/src/new/deep/file.txt")
      expect(missing.path).toBe(path.join(repo, "src", "new", "deep", "file.txt"))
      const denied = yield* roots.resolve(admission, "src/new/deep/file.txt").pipe(Effect.flip)
      expect(denied._tag).toBe("OfxpRoot.InvalidPathError")
    }),
  )

  it.effect("validates and fingerprints the filesystem root before forwarding the operator revision fence", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
      const repo = path.join(tmp.path, "repo")
      yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
      const peers = yield* OfxpPeer.Service
      const roots = yield* OfxpRoot.Service
      const remote = identity()
      const trusted = yield* peers.trust({ identity: remote.identity })
      const revised = yield* peers.setGrant({
        peerID: remote.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, read: true },
      })

      const invalid = yield* roots
        .approve(remote.key.peerID, path.join(tmp.path, "missing"), "Missing", "manual", trusted.info.grantRevision)
        .pipe(Effect.flip)
      expect(invalid._tag).toBe("OfxpRoot.InvalidPathError")

      const stale = yield* roots
        .approve(remote.key.peerID, repo, "Repo", "manual", trusted.info.grantRevision)
        .pipe(Effect.flip)
      expect(stale._tag).toBe("OfxpPeer.StaleRevisionError")

      const approved = yield* roots.approve(remote.key.peerID, repo, "Repo", "manual", revised.info.grantRevision)
      expect(approved.alias).toBe("repo")
    }),
  )

  it.effect("rejects a missing child beneath an existing symlink that resolves outside the approved root", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
      const repo = path.join(tmp.path, "repo")
      const outside = path.join(tmp.path, "outside")
      yield* Effect.promise(() => Promise.all([fs.mkdir(repo, { recursive: true }), fs.mkdir(outside, { recursive: true })]))
      const link = path.join(repo, "escape")
      const linked = yield* Effect.promise(async () => {
        try {
          await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
          return true
        } catch {
          return false
        }
      })
      if (!linked) return

      const peers = yield* OfxpPeer.Service
      const roots = yield* OfxpRoot.Service
      const remote = identity()
      const trusted = yield* peers.trust({ identity: remote.identity })
      const granted = yield* peers.setGrant({
        peerID: remote.key.peerID,
        expectedRevision: trusted.info.grantRevision,
        grant: { ...Ofxp.DENY_GRANT, write: true },
      })
      const root = yield* roots.approve(remote.key.peerID, repo, "Repo")
      const admission = yield* peers.authorize({
        peerID: remote.key.peerID,
        capability: "write",
        rootID: root.id,
        expectedGrantRevision: granted.info.grantRevision,
      })
      const escaped = yield* roots.resolve(admission, "escape/new.txt", { allowMissing: true }).pipe(Effect.flip)
      expect(escaped._tag).toBe("OfxpRoot.InvalidPathError")
    }),
  )
})
