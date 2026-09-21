import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { SessionID } from "@opencode-ai/schema/session-id"
import { ExchangeProcess } from "../../src/exchange/process"
import { OfxpProcessCapability } from "../../src/ofxp/augmentation/process"
import { OfxpSympyCapability } from "../../src/ofxp/augmentation/sympy"
import type { PeerCertificateIdentity } from "../../src/ofxp/certificate"
import { OfxpRoot } from "../../src/ofxp/root"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    FSUtil.node,
    OfxpPeer.node,
    OfxpInvocation.node,
    OfxpRoot.node,
    ExchangeProcess.node,
    OfxpProcessCapability.node,
  ]),
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
    certificate: {
      peerID: key.peerID,
      fingerprint: key.fingerprint,
      publicKeySpki: key.publicKeySpki,
    } satisfies PeerCertificateIdentity,
  }
}

function call(peerID: Ofxp.PeerID, rootID: Ofxp.RootID, args: unknown): Ofxp.CapabilityCall {
  return {
    context: {
      invocationID: Ofxp.InvocationID.create(),
      traceID: Ofxp.TraceID.create(),
      sourcePeerID: peerID,
      sourceSessionID: SessionID.descending(),
      plane: "augmentation",
      hopCount: 0,
    },
    rootID,
    capability: "sympy",
    contract: "broker-v1:000000000000000000000000",
    args,
  }
}

describe("OFXP SymPy capability", () => {
  it.live("requires process authority and strips ambient secrets from the Python child", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const processCapability = yield* OfxpProcessCapability.Service
    const source = identity("sympy")
    const trusted = yield* peers.trust({ identity: source.identity })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    const deps = { peers, roots, process: processCapability }

    const denied = yield* OfxpSympyCapability.execute(
      deps,
      source.certificate,
      call(source.key.peerID, root.id, { expr: "x**2 + 2*x + 1", operation: "factor" }),
    ).pipe(Effect.flip)
    expect(denied).toBeInstanceOf(OfxpPeer.OfxpPeerSchema.AuthorityDeniedError)

    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, process: true },
    })
    const factored = yield* OfxpSympyCapability.execute(
      deps,
      source.certificate,
      call(source.key.peerID, root.id, { expr: "x**2 + 2*x + 1", operation: "factor" }),
    )
    expect(factored.output).toContain("(x + 1)**2")
    expect(factored.metadata).toMatchObject({ status: "ok", kind: "expr", operation: "factor" })
    expect(JSON.stringify(factored)).not.toContain(repo)

    const key = "OPENFORK_OFXP_SYMPY_API_KEY"
    const prior = process.env[key]
    process.env[key] = "must-not-reach-ofxp-sympy"
    try {
      const isolated = yield* OfxpSympyCapability.execute(
        deps,
        source.certificate,
        call(source.key.peerID, root.id, {
          code: `import os\nos.environ.get("${key}", "missing")`,
        }),
      )
      expect(isolated.output).toContain("missing")
      expect(isolated.output).not.toContain("must-not-reach-ofxp-sympy")
    } finally {
      if (prior === undefined) delete process.env[key]
      else process.env[key] = prior
    }
  }))
})

