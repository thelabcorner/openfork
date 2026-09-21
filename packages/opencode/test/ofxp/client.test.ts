import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpPairing } from "@opencode-ai/core/ofxp-peer/pairing"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { SessionID } from "@opencode-ai/schema/session-id"
import { OfxpCapability } from "../../src/ofxp/capability"
import { OfxpCertificate } from "../../src/ofxp/certificate"
import { OfxpClient } from "../../src/ofxp/client"
import { OfxpConnectionManager } from "../../src/ofxp/connection-manager"
import { OfxpRoot } from "../../src/ofxp/root"
import { OfxpTransport } from "../../src/ofxp/transport"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, FSUtil.node, OfxpPeer.node, OfxpRoot.node, OfxpCapability.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

function identity(label: string) {
  const key = OfxpIdentity.generateKeyPair()
  return {
    key,
    identity: {
      id: key.peerID,
      realmID: `realm:${label.toLowerCase()}`,
      label,
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    } satisfies Ofxp.PeerIdentity,
  }
}

function hello(value: Ofxp.PeerIdentity): Ofxp.Hello {
  return {
    protocolMin: 1,
    protocolMax: 1,
    peerID: value.id,
    realmID: value.realmID,
    openforkVersion: "test",
    surfaceFingerprint: "sha256:test-client",
    features: {
      pairing: true,
      capabilityExchange: true,
      messaging: false,
      supervision: false,
      delegation: false,
    },
  }
}

describe("OFXP semantic client", () => {
  it.live("performs lazy root/list/describe/call over one negotiated pooled connection", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(path.join(repo, "src"), { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "src", "remote.txt"), "semantic client\n"))

    const source = identity("Source")
    const target = identity("Target")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service

    // Target-side authority granted to Source.
    const sourceTrust = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: sourceTrust.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")

    // Local trust in Target remains deny-by-default. Outbound access must not
    // incorrectly reuse this machine's inbound grant for Target.
    const targetTrust = yield* peers.trust({ identity: target.identity })
    expect(targetTrust.grant.read).toBe(false)

    const [sourceMaterial, targetMaterial] = yield* Effect.promise(() =>
      Promise.all([OfxpCertificate.issue(source.key), OfxpCertificate.issue(target.key)]),
    )
    const endpoint = yield* Effect.acquireRelease(
      Effect.promise(() =>
        OfxpTransport.start({
          material: targetMaterial,
          identity: target.identity,
          hello: hello(target.identity),
          pairing: new OfxpPairing.Coordinator(target.identity),
          host: "127.0.0.1",
          application: ({ peer, method, body, signal }) => Effect.runPromise(capabilities.dispatch(peer, method, body, signal)),
        }),
      ),
      (value) => Effect.promise(() => value.stop()),
    )
    const manager = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new OfxpConnectionManager.Manager(
            sourceMaterial,
            OfxpConnectionManager.DEFAULT_MAX_CONNECTIONS,
            undefined,
            OfxpClient.negotiate,
          ),
      ),
      (value) => Effect.promise(() => value.stop()),
    )
    const client = new OfxpClient.Client(source.identity, peers, manager, (peerID) =>
      peerID === target.key.peerID ? [{ host: endpoint.host, port: endpoint.port }] : [],
    )

    const remoteRoots = yield* client.roots(target.key.peerID)
    expect(remoteRoots.ok).toBe(true)
    if (!remoteRoots.ok) throw new Error(remoteRoots.error.message)
    expect(remoteRoots.roots).toEqual([root])

    const listed = yield* client.capabilities(target.key.peerID, root.id)
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.capabilities.map((item) => item.id)).toEqual(["read", "find", "project", "skill", "archive", "json", "sqlite", "memory", "symbols", "lsp", "typecheck", "test"])

    const described = yield* client.describe(target.key.peerID, "read")
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)

    const result = yield* client.invoke({
      peerID: target.key.peerID,
      sourceSessionID: SessionID.descending(),
      rootID: root.id,
      capability: "read",
      contract: described.descriptor.contract,
      args: { path: "src/remote.txt" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.result.output).toContain("semantic client")
    expect(result.result.output).toContain("/repo/src/remote.txt")
    expect(JSON.stringify(result)).not.toContain(repo)
    expect(manager.size).toBe(1)
  }))

  it.live("rejects locally revoked outbound trust before dialing", Effect.gen(function* () {
    const source = identity("Source")
    const target = identity("Revoked Target")
    const peers = yield* OfxpPeer.Service
    yield* peers.trust({ identity: target.identity })
    yield* peers.revoke(target.key.peerID)
    const sourceMaterial = yield* Effect.promise(() => OfxpCertificate.issue(source.key))
    let dials = 0
    const manager = new OfxpConnectionManager.Manager(sourceMaterial, 8, async () => {
      dials++
      throw new Error("should not dial")
    })
    const client = new OfxpClient.Client(source.identity, peers, manager, () => [{ host: "127.0.0.1", port: 1 }])

    const exit = yield* Effect.exit(client.roots(target.key.peerID))
    expect(exit._tag).toBe("Failure")
    expect(dials).toBe(0)
    yield* Effect.promise(() => manager.stop())
  }))
})
