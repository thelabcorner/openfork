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
      realmID: "realm:root-idempotency",
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

describe("OFXP approved-root identity", () => {
  it.effect("reuses the stable root identity when the same alias and canonical path are approved again", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity("Retry")
      const directory = yield* tempRoot("ofxp-root-retry-")
      yield* peers.trust({ identity: generated.identity, now: 100 })

      const first = yield* peers.approveRoot({
        peerID: generated.key.peerID,
        alias: "repo",
        canonicalPath: directory,
        source: "project",
        now: 110,
      })
      const retry = yield* peers.approveRoot({
        peerID: generated.key.peerID,
        alias: "repo",
        canonicalPath: directory,
        source: "project",
        now: 120,
      })

      expect(retry.id).toBe(first.id)
      expect(retry.approvedAt).toBe(120)
      expect(yield* peers.roots(generated.key.peerID)).toEqual([retry])
    }),
  )

  it.effect("rejects reusing an alias for a different canonical root as a typed validation error", () =>
    Effect.gen(function* () {
      const peers = yield* OfxpPeer.Service
      const generated = identity("Alias collision")
      const firstDirectory = yield* tempRoot("ofxp-root-alias-a-")
      const secondDirectory = yield* tempRoot("ofxp-root-alias-b-")
      yield* peers.trust({ identity: generated.identity, now: 100 })
      yield* peers.approveRoot({
        peerID: generated.key.peerID,
        alias: "repo",
        canonicalPath: firstDirectory,
        now: 110,
      })

      const conflict = yield* peers
        .approveRoot({
          peerID: generated.key.peerID,
          alias: "repo",
          canonicalPath: secondDirectory,
          now: 120,
        })
        .pipe(Effect.flip)

      expect(conflict._tag).toBe("OfxpPeer.ValidationError")
      expect(conflict.reason).toContain("alias")
      expect(yield* peers.roots(generated.key.peerID)).toHaveLength(1)
    }),
  )
})
