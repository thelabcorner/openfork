import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { BrowserHostBroker } from "@opencode-ai/core/browser/host-broker"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { SessionID } from "@opencode-ai/schema/session-id"
import { OfxpBrowserCapability } from "../../src/ofxp/augmentation/browser"
import type { PeerCertificateIdentity } from "../../src/ofxp/certificate"
import { OfxpRoot } from "../../src/ofxp/root"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, FSUtil.node, OfxpPeer.node, OfxpInvocation.node, OfxpRoot.node]),
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

function call(
  peerID: Ofxp.PeerID,
  sourceSessionID: SessionID,
  args: unknown,
  input: { rootID?: Ofxp.RootID; invocationID?: Ofxp.InvocationID } = {},
): Ofxp.CapabilityCall {
  return {
    context: {
      invocationID: input.invocationID ?? Ofxp.InvocationID.create(),
      traceID: Ofxp.TraceID.create(),
      sourcePeerID: peerID,
      sourceSessionID,
      plane: "augmentation",
      hopCount: 0,
    },
    ...(input.rootID ? { rootID: input.rootID } : {}),
    capability: "browser",
    contract: "broker-v1:000000000000000000000000",
    args,
  }
}

function broker(requests: BrowserHostBroker.BrokerRequestInput[], options: { escapeVisualPath?: boolean } = {}): BrowserHostBroker.Interface {
  return BrowserHostBroker.Service.of({
    register: () => Effect.die("browser test does not register hosts"),
    dispatch: (request) => {
      requests.push(request)
      if (request.operation.name === "status") {
        const principal = request.principal
        if (!principal || principal.kind !== "external") return Effect.die("expected external browser principal")
        return Effect.succeed({
          ok: true as const,
          requestId: "status-request",
          elapsedMs: 1,
          result: {
            status: { connected: true, appearance: "system", recording: { active: false } },
            tabs: [
              { tabId: "own", url: "https://own.example", title: "Own", active: true, owner: principal, muted: false },
              { tabId: "human", url: "https://private.example", title: "Human", active: false, owner: { kind: "user" }, muted: false },
              { tabId: "other", url: "https://other.example", title: "Other", active: false, owner: { kind: "external", principalId: "other-principal" }, muted: false },
            ],
          },
        })
      }
      if (request.operation.name === "visual_history") {
        return Effect.succeed({
          ok: true as const,
          requestId: "history-request",
          elapsedMs: 2,
          result: {
            history: {
              root: ".snapeye",
              baselines: [
                {
                  name: "panel",
                  imagePath: options.escapeVisualPath ? "../outside.png" : ".snapeye/baselines/panel.png",
                  metadataPath: ".snapeye/baselines/panel.json",
                  byteLength: 128,
                },
              ],
              runs: [
                {
                  runId: "run1",
                  resultPath: ".snapeye/runs/run1/result.json",
                  status: "ok",
                  operation: "capture",
                  artifacts: ["current", "result"],
                },
              ],
            },
          },
        })
      }
      if (request.operation.name === "navigate") {
        return Effect.succeed({
          ok: true as const,
          requestId: "navigate-request",
          elapsedMs: 3,
          result: {
            navigated: {
              tabId: "own",
              url: "https://example.com/next",
              title: "Next",
              readyState: "Success",
              httpStatus: 200,
              viewport: { width: 1280, height: 720, dpr: 1, scrollX: 0, scrollY: 0 },
            },
          },
        })
      }
      return Effect.die(`unexpected browser operation ${request.operation.name}`)
    },
    abort: () => Effect.void,
    pushEvent: () => Effect.void,
    list: () => Effect.succeed([]),
    listTabs: () => Effect.succeed([]),
    assign: () => Effect.die("browser test does not assign tabs"),
    orphanSession: () => Effect.void,
  })
}

describe("OFXP browser capability", () => {
  it.live("uses rootless browser authority and isolates status to the remote source Session", Effect.gen(function* () {
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const source = identity("source")
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, browser: true },
    })
    const requests: BrowserHostBroker.BrokerRequestInput[] = []
    const host = broker(requests)
    const sessionA = SessionID.descending()
    const first = yield* OfxpBrowserCapability.execute(
      { peers, roots, invocations, broker: host },
      source.certificate,
      call(source.key.peerID, sessionA, { operation: "status", args: {} }),
    )
    const parsed = JSON.parse(first.output) as { tabs: Array<{ tabId: string; owner: { principalId?: string } }> }
    expect(parsed.tabs.map((tab) => tab.tabId)).toEqual(["own"])
    expect(JSON.stringify(parsed)).not.toContain("private.example")
    expect(JSON.stringify(parsed)).not.toContain("other-principal")
    const principalA = requests[0]?.principal
    expect(principalA?.kind).toBe("external")

    yield* OfxpBrowserCapability.execute(
      { peers, roots, invocations, broker: host },
      source.certificate,
      call(source.key.peerID, SessionID.descending(), { operation: "status", args: {} }),
    )
    expect(requests[1]?.principal).not.toEqual(principalA)
  }))

  it.live("virtualizes SnapEye paths and fails closed on a path outside the approved root", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const rootDir = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const source = identity("visual")
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, browser: true },
    })
    const root = yield* roots.approve(source.key.peerID, rootDir, "repo")
    const good = yield* OfxpBrowserCapability.execute(
      { peers, roots, invocations, broker: broker([]) },
      source.certificate,
      call(source.key.peerID, SessionID.descending(), { operation: "visual_history", args: {} }, { rootID: root.id }),
    )
    expect(good.output).toContain("/repo/.snapeye/baselines/panel.png")
    expect(good.output).toContain("/repo/.snapeye/runs/run1/result.json")
    expect(good.output).not.toContain(rootDir)

    const escaped = yield* OfxpBrowserCapability.execute(
      { peers, roots, invocations, broker: broker([], { escapeVisualPath: true }) },
      source.certificate,
      call(source.key.peerID, SessionID.descending(), { operation: "visual_history", args: {} }, { rootID: root.id }),
    ).pipe(Effect.flip)
    expect(escaped).toBeInstanceOf(Error)
    expect(String(escaped)).toContain("escapes the approved root")
  }))

  it.live("deduplicates a browser mutation by InvocationID without dispatching twice", Effect.gen(function* () {
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const source = identity("mutation")
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, browser: true },
    })
    const requests: BrowserHostBroker.BrokerRequestInput[] = []
    const host = broker(requests)
    const invocationID = Ofxp.InvocationID.create()
    const request = call(
      source.key.peerID,
      SessionID.descending(),
      { operation: "navigate", args: { url: "https://example.com/next" } },
      { invocationID },
    )
    const first = yield* OfxpBrowserCapability.execute({ peers, roots, invocations, broker: host }, source.certificate, request)
    expect(first.output).toContain("https://example.com/next")
    expect(requests.filter((item) => item.operation.name === "navigate")).toHaveLength(1)

    const duplicate = yield* OfxpBrowserCapability.execute({ peers, roots, invocations, broker: host }, source.certificate, request)
    expect(duplicate.output).toContain("already committed")
    expect(requests.filter((item) => item.operation.name === "navigate")).toHaveLength(1)
    expect((yield* invocations.get(source.key.peerID, invocationID)).state).toBe("committed")
  }))
})

