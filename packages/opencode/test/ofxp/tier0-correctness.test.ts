import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
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
import { ExchangeRequestDigest } from "../../src/exchange/request-digest"
import { OfxpCapability } from "../../src/ofxp/capability"
import type { PeerCertificateIdentity } from "../../src/ofxp/certificate"
import { OfxpPrincipal } from "../../src/ofxp/principal"
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
    OfxpCapability.node,
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
      realmID: `realm:${label.toLowerCase().replaceAll(" ", "-")}`,
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
  rootID: Ofxp.RootID,
  capability: Ofxp.CapabilityID,
  contract: string,
  args: unknown,
  options: { invocationID?: Ofxp.InvocationID; sourceSessionID?: SessionID } = {},
): Ofxp.CapabilityCall {
  return {
    context: {
      invocationID: options.invocationID ?? Ofxp.InvocationID.create(),
      traceID: Ofxp.TraceID.create(),
      sourcePeerID: peerID,
      sourceSessionID: options.sourceSessionID ?? SessionID.descending(),
      plane: "augmentation",
      hopCount: 0,
    },
    rootID,
    capability,
    contract,
    args,
  }
}

function decodeResponse(value: unknown) {
  return Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(value, { onExcessProperty: "error" })
}

function describeCapability(
  capabilities: OfxpCapability.Interface,
  peer: PeerCertificateIdentity,
  capability: Ofxp.CapabilityID,
) {
  return capabilities.dispatch(peer, "capability.describe", { capability }).pipe(
    Effect.map((value) =>
      Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(value, { onExcessProperty: "error" }),
    ),
    Effect.map((value) => {
      if (!value.ok) throw new Error(value.error.message)
      return value.descriptor
    }),
  )
}

function handleOf(response: Ofxp.CapabilityResponse) {
  if (!response.ok) throw new Error(response.error.message)
  const handle = (response.result.metadata as { readonly handle?: unknown }).handle
  if (typeof handle !== "string") throw new Error("process response did not expose a handle")
  return ExchangeProcess.Handle.make(handle)
}

const waitUntil = (predicate: () => Effect.Effect<boolean>, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!(yield* predicate())) {
      if (Date.now() >= deadline) return false
      yield* Effect.sleep("50 millis")
    }
    return true
  })

function shQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function nodeCommand(script: string) {
  if (process.platform === "win32") {
    if (script.includes('"')) throw new Error("Windows OFXP process test scripts must not contain double quotes")
    return `"${process.execPath}" -e "${script}"`
  }
  return `${shQuote(process.execPath)} -e ${shQuote(script)}`
}

describe("OFXP Tier-0 correctness", () => {
  it.live("pins live processes to grant revisions, retires them on authority changes, and never respawns a committed stale start", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))

    const source = identity("Revision Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const processes = yield* ExchangeProcess.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    const granted = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, process: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    const descriptor = yield* describeCapability(capabilities, source.certificate, "process")
    const sourceSessionID = SessionID.descending()
    const invocationID = Ofxp.InvocationID.create()
    const start = call(
      source.key.peerID,
      root.id,
      "process",
      descriptor.contract,
      { action: "start", command: nodeCommand("setTimeout(()=>process.exit(0),30000)"), mode: "background" },
      { invocationID, sourceSessionID },
    )

    const started = decodeResponse(yield* capabilities.dispatch(source.certificate, "capability.call", start))
    expect(started.ok).toBe(true)
    const handle = handleOf(started)
    const ownerKey = OfxpPrincipal.key(source.key.peerID, start.context)
    expect((yield* processes.descriptor(ownerKey, handle))?.running).toBe(true)

    const revised = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: granted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, process: true },
    })
    expect(revised.info.grantRevision).toBe(granted.info.grantRevision + 1)
    expect(yield* waitUntil(Effect.fnUntraced(function* () {
      return (yield* processes.descriptor(ownerKey, handle)) === undefined
    }))).toBe(true)

    const replay = decodeResponse(yield* capabilities.dispatch(source.certificate, "capability.call", start))
    expect(replay.ok).toBe(false)
    if (replay.ok) throw new Error("committed stale process unexpectedly respawned")
    expect(replay.error.code).toBe("NOT_FOUND")
    expect(replay.error.message).toContain("will not respawn")

    const receipt = Schema.decodeUnknownSync(Ofxp.ReceiptGetResponse)(
      yield* capabilities.dispatch(source.certificate, "receipt.get", { invocationID }),
      { onExcessProperty: "error" },
    )
    expect(receipt.ok).toBe(true)
    if (!receipt.ok) throw new Error(receipt.error.message)
    expect(receipt.receipt.state).toBe("committed")

    const revokedInvocation = Ofxp.InvocationID.create()
    const revokedStart = call(
      source.key.peerID,
      root.id,
      "process",
      descriptor.contract,
      { action: "start", command: nodeCommand("setTimeout(()=>process.exit(0),30000)"), mode: "background" },
      { invocationID: revokedInvocation, sourceSessionID },
    )
    const liveAgain = decodeResponse(yield* capabilities.dispatch(source.certificate, "capability.call", revokedStart))
    expect(liveAgain.ok).toBe(true)
    const revokedHandle = handleOf(liveAgain)
    expect((yield* processes.descriptor(ownerKey, revokedHandle))?.running).toBe(true)

    expect(yield* peers.revoke(source.key.peerID)).toBe(true)
    expect(yield* waitUntil(Effect.fnUntraced(function* () {
      return (yield* processes.descriptor(ownerKey, revokedHandle)) === undefined
    }))).toBe(true)

    const revokedReceipt = Schema.decodeUnknownSync(Ofxp.ReceiptGetResponse)(
      yield* capabilities.dispatch(source.certificate, "receipt.get", { invocationID: revokedInvocation }),
      { onExcessProperty: "error" },
    )
    expect(revokedReceipt.ok).toBe(false)
    if (revokedReceipt.ok) throw new Error("revoked peer unexpectedly read a receipt")
    expect(revokedReceipt.error.code).toBe("PEER_REVOKED")
    expect(JSON.stringify({ started, replay, receipt, liveAgain, revokedReceipt })).not.toContain(repo)
  }))

  it.live("binds InvocationID to the exact write request and keeps the durable committed result on collision", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    const target = path.join(repo, "value.txt")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))

    const source = identity("Collision Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, write: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    const descriptor = yield* describeCapability(capabilities, source.certificate, "write")
    const sourceSessionID = SessionID.descending()
    const invocationID = Ofxp.InvocationID.create()
    const first = call(
      source.key.peerID,
      root.id,
      "write",
      descriptor.contract,
      { path: "value.txt", content: "alpha\n" },
      { invocationID, sourceSessionID },
    )

    const committed = decodeResponse(yield* capabilities.dispatch(source.certificate, "capability.call", first))
    expect(committed.ok).toBe(true)
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("alpha\n")

    const duplicate = decodeResponse(yield* capabilities.dispatch(source.certificate, "capability.call", first))
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error(duplicate.error.message)
    expect(duplicate.result.output).toContain("already committed")

    const collision = decodeResponse(
      yield* capabilities.dispatch(
        source.certificate,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          "write",
          descriptor.contract,
          { path: "value.txt", content: "bravo\n" },
          { invocationID, sourceSessionID },
        ),
      ),
    )
    expect(collision.ok).toBe(false)
    if (collision.ok) throw new Error("InvocationID collision unexpectedly executed")
    expect(collision.error.code).toBe("CONFLICT")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("alpha\n")

    const receipt = Schema.decodeUnknownSync(Ofxp.ReceiptGetResponse)(
      yield* capabilities.dispatch(source.certificate, "receipt.get", { invocationID }),
      { onExcessProperty: "error" },
    )
    expect(receipt.ok).toBe(true)
    if (!receipt.ok) throw new Error(receipt.error.message)
    expect(receipt.receipt.state).toBe("committed")
    expect(receipt.receipt.targetRef).toBe("/repo/value.txt")
    expect(JSON.stringify({ committed, duplicate, collision, receipt })).not.toContain(repo)
  }))

  it.live("refuses to replay a started non-idempotent process write through the public dispatcher", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))

    const source = identity("Ambiguous Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, process: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    const descriptor = yield* describeCapability(capabilities, source.certificate, "process")
    const sourceSessionID = SessionID.descending()
    const start = call(
      source.key.peerID,
      root.id,
      "process",
      descriptor.contract,
      {
        action: "start",
        command: nodeCommand("process.stdin.once('data',()=>{process.stdout.write('received');setTimeout(()=>process.exit(0),10000)})"),
        mode: "background",
      },
      { sourceSessionID },
    )
    const started = decodeResponse(yield* capabilities.dispatch(source.certificate, "capability.call", start))
    expect(started.ok).toBe(true)
    const handle = handleOf(started)

    const invocationID = Ofxp.InvocationID.create()
    const chars = "must-not-replay\n"
    const write = call(
      source.key.peerID,
      root.id,
      "process",
      descriptor.contract,
      { action: "write", handle, chars },
      { invocationID, sourceSessionID },
    )
    const ownerKey = OfxpPrincipal.key(source.key.peerID, write.context)
    const requestDigest = ExchangeRequestDigest.sha256("ofxp:process-write:v1", {
      rootID: root.id,
      handle,
      chars,
      ownerKey,
    })
    yield* invocations.admit({
      invocationID,
      sourcePeerID: source.key.peerID,
      operation: "process.write",
      commitClass: "non_idempotent_mutation",
      requestDigest,
      targetRef: handle,
    })
    yield* invocations.prepare({ invocationID, targetRef: handle })

    const ambiguous = decodeResponse(yield* capabilities.dispatch(source.certificate, "capability.call", write))
    expect(ambiguous.ok).toBe(false)
    if (ambiguous.ok) throw new Error("started non-idempotent process write unexpectedly replayed")
    expect(ambiguous.error.code).toBe("AMBIGUOUS_COMMIT")

    const receipt = Schema.decodeUnknownSync(Ofxp.ReceiptGetResponse)(
      yield* capabilities.dispatch(source.certificate, "receipt.get", { invocationID }),
      { onExcessProperty: "error" },
    )
    expect(receipt.ok).toBe(true)
    if (!receipt.ok) throw new Error(receipt.error.message)
    expect(receipt.receipt.state).toBe("started")

    yield* Effect.sleep("100 millis")
    const polled = decodeResponse(
      yield* capabilities.dispatch(
        source.certificate,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          "process",
          descriptor.contract,
          { action: "poll", handle, offset: 0, maxBytes: 64 * 1024 },
          { sourceSessionID },
        ),
      ),
    )
    expect(polled.ok).toBe(true)
    if (!polled.ok) throw new Error(polled.error.message)
    expect(polled.result.output).not.toContain("received")

    const killed = decodeResponse(
      yield* capabilities.dispatch(
        source.certificate,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          "process",
          descriptor.contract,
          { action: "kill", handle },
          { sourceSessionID },
        ),
      ),
    )
    expect(killed.ok).toBe(true)
    expect(JSON.stringify({ ambiguous, receipt, polled, killed })).not.toContain(repo)
  }))

  it.live("rejects allow-missing writes beneath escaping symlinks without leaking native paths", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    const outside = path.join(tmp.path, "outside")
    yield* Effect.promise(() => Promise.all([fs.mkdir(repo, { recursive: true }), fs.mkdir(outside, { recursive: true })]))
    const linked = yield* Effect.promise(async () => {
      try {
        await fs.symlink(outside, path.join(repo, "escape"), process.platform === "win32" ? "junction" : "dir")
        return true
      } catch {
        return false
      }
    })
    if (!linked) return

    const source = identity("Path Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, write: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    const descriptor = yield* describeCapability(capabilities, source.certificate, "write")

    const escaped = decodeResponse(
      yield* capabilities.dispatch(
        source.certificate,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          "write",
          descriptor.contract,
          { path: "escape/new.txt", content: "nope\n" },
        ),
      ),
    )
    expect(escaped.ok).toBe(false)
    if (escaped.ok) throw new Error("allow-missing write escaped the approved root")
    expect(escaped.error.code).toBe("INVALID_REQUEST")
    expect(yield* Effect.promise(() => fs.stat(path.join(outside, "new.txt")).then(() => true, () => false))).toBe(false)
    expect(JSON.stringify(escaped)).not.toContain(repo)
    expect(JSON.stringify(escaped)).not.toContain(outside)
  }))
})
