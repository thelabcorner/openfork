import { describe, expect } from "bun:test"
import { $ } from "bun"
import { Database as BunDatabase } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { OfxpPairing } from "@opencode-ai/core/ofxp-peer/pairing"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { SessionID } from "@opencode-ai/schema/session-id"
import { OfxpCapability } from "../../src/ofxp/capability"
import { OfxpCertificate } from "../../src/ofxp/certificate"
import { OfxpRoot } from "../../src/ofxp/root"
import { OfxpTransport } from "../../src/ofxp/transport"
import { ZipFile } from "../../src/tool/archive/zipfile"
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

function context(
  peerID: Ofxp.PeerID,
  invocationID = Ofxp.InvocationID.create(),
  sourceSessionID = SessionID.descending(),
): Ofxp.InvocationContext {
  return {
    invocationID,
    traceID: Ofxp.TraceID.create(),
    sourcePeerID: peerID,
    sourceSessionID,
    plane: "augmentation",
    hopCount: 0,
  }
}

function call(
  peerID: Ofxp.PeerID,
  rootID: Ofxp.RootID,
  args: unknown,
  contract: string,
  capability: Ofxp.CapabilityID = "read",
  invocationID?: Ofxp.InvocationID,
  sourceSessionID?: SessionID,
): Ofxp.CapabilityCall {
  return { context: context(peerID, invocationID, sourceSessionID), rootID, capability, contract, args }
}

async function describeCapability(connection: OfxpTransport.ClientConnection, capability: Ofxp.CapabilityID) {
  const response = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
    await connection.request<unknown>("capability.describe", { capability }),
    { onExcessProperty: "error" },
  )
  if (!response.ok) throw new Error(response.error.message)
  return response.descriptor
}

function hello(identity: Ofxp.PeerIdentity): Ofxp.Hello {
  return {
    protocolMin: 1,
    protocolMax: 1,
    peerID: identity.id,
    realmID: identity.realmID,
    openforkVersion: "test",
    surfaceFingerprint: "sha256:test",
    features: {
      pairing: true,
      capabilityExchange: true,
      messaging: false,
      supervision: false,
      delegation: false,
    },
  }
}

function shQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function nodeCommand(script: string) {
  if (process.platform === "win32") {
    if (script.includes('"')) throw new Error("Windows OFXP process test scripts must not contain double quotes")
    return `"${process.execPath}" -e "${script}"`
  }
  return `${shQuote(process.execPath)} -e ${shQuote(script)}`
}

describe("OFXP capability exchange", () => {
  it.live("executes a TLS-authenticated remote read only inside the calling peer's approved root", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(path.join(repo, "src"), { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "src", "hello.txt"), "remote hello\nsecond line\n"))
    yield* Effect.promise(() =>
      fs.writeFile(path.join(repo, "src", "symbols.ts"), "export function remoteSymbol(value: number) { return value + 1 }\n"),
    )

    const source = identity("Machine A")
    const target = identity("Machine B")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service

    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")

    const targetMaterial = yield* Effect.promise(() => OfxpCertificate.issue(target.key))
    const sourceMaterial = yield* Effect.promise(() => OfxpCertificate.issue(source.key))
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
    const connection = yield* Effect.acquireRelease(
      Effect.promise(() =>
        OfxpTransport.ClientConnection.connect({
          material: sourceMaterial,
          host: endpoint.host,
          port: endpoint.port,
          expectedPeerID: target.key.peerID,
        }),
      ),
      (value) => Effect.promise(() => value.close()),
    )

    const listedRoots = Schema.decodeUnknownSync(Ofxp.RootListResponse)(
      yield* Effect.promise(() => connection.request<unknown>("root.list")),
      { onExcessProperty: "error" },
    )
    expect(listedRoots.ok).toBe(true)
    if (!listedRoots.ok) throw new Error(listedRoots.error.message)
    expect(listedRoots.roots).toEqual([root])
    expect(JSON.stringify(listedRoots)).not.toContain(repo)
    expect(Object.keys(listedRoots.roots[0] ?? {}).sort()).toEqual(["alias", "approvedAt", "available", "id", "source"])

    const listed = Schema.decodeUnknownSync(Ofxp.CapabilityListResponse)(
      yield* Effect.promise(() => connection.request<unknown>("capability.list", { rootID: root.id })),
      { onExcessProperty: "error" },
    )
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.capabilities.map((item) => item.id)).toEqual(["read", "find", "project", "skill", "archive", "json", "sqlite", "memory", "refactor", "symbols", "lsp", "typecheck", "test"])
    const readDescriptor = yield* Effect.promise(() => describeCapability(connection, "read"))
    const symbolsDescriptor = yield* Effect.promise(() => describeCapability(connection, "symbols"))
    const lspDescriptor = yield* Effect.promise(() => describeCapability(connection, "lsp"))

    const response = yield* Effect.promise(() =>
      connection.request<unknown>(
        "capability.call",
        call(source.key.peerID, root.id, { path: "src/hello.txt", offset: 2, limit: 1 }, readDescriptor.contract),
      ),
    )
    const parsed = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(response, { onExcessProperty: "error" })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error.message)
    expect(parsed.result.output).toContain("2: second line")
    expect(parsed.result.output).toContain("/repo/src/hello.txt")
    expect(JSON.stringify(parsed)).not.toContain(repo)

    const symbols = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* Effect.promise(() =>
        connection.request<unknown>(
          "capability.call",
          call(
            source.key.peerID,
            root.id,
            { action: "search", query: "remoteSymbol", path: "src", lang: "ts" },
            symbolsDescriptor.contract,
            "symbols",
          ),
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(symbols.ok).toBe(true)
    if (!symbols.ok) throw new Error(symbols.error.message)
    expect(symbols.result.output).toContain("remoteSymbol")
    expect(symbols.result.output).toContain("symbols.ts")
    expect(JSON.stringify(symbols)).not.toContain(repo)

    const lsp = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* Effect.promise(() =>
        connection.request<unknown>(
          "capability.call",
          call(
            source.key.peerID,
            root.id,
            { operation: "documentSymbol", filePath: "src/symbols.ts", line: 1, character: 1 },
            lspDescriptor.contract,
            "lsp",
          ),
        ),
      ),
      { onExcessProperty: "error" },
    )
    if (!lsp.ok) {
      // CI does not guarantee an installed language server, but reaching the
      // shared runtime must never look like an unimplemented OFXP capability.
      expect(["NOT_FOUND", "DEPENDENCY_UNAVAILABLE"]).toContain(lsp.error.code)
    } else {
      expect(JSON.stringify(lsp)).not.toContain(repo)
    }

    const stale = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* Effect.promise(() =>
        connection.request<unknown>(
          "capability.call",
          call(source.key.peerID, root.id, { path: "src/hello.txt" }, "broker-v1:000000000000000000000000"),
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(stale.ok).toBe(false)
    if (stale.ok) throw new Error("expected stale contract rejection")
    expect(stale.error.code).toBe("STALE_CONTRACT")

    const traversal = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* Effect.promise(() =>
        connection.request<unknown>(
          "capability.call",
          call(source.key.peerID, root.id, { path: "../outside.txt" }, readDescriptor.contract),
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(traversal.ok).toBe(false)
    if (traversal.ok) throw new Error("expected traversal denial")
    expect(traversal.error.code).toBe("INVALID_REQUEST")

    const missingRoot = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* Effect.promise(() =>
        connection.request<unknown>(
          "capability.call",
          call(source.key.peerID, Ofxp.RootID.create(), { path: "src/hello.txt" }, readDescriptor.contract),
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(missingRoot.ok).toBe(false)
    if (missingRoot.ok) throw new Error("expected missing-root denial")
    expect(missingRoot.error.code).toBe("ROOT_NOT_FOUND")
  }))

  it.live("does not trust a sourcePeerID claimed in JSON when TLS authenticated a different peer", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "a.txt"), "a\n"))

    const source = identity("Actual")
    const spoofed = identity("Claimed")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")

    const descriptorRaw = yield* capabilities.dispatch(
      { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki },
      "capability.describe",
      { capability: "read" },
    )
    const descriptorResponse = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(descriptorRaw, {
      onExcessProperty: "error",
    })
    if (!descriptorResponse.ok) throw new Error(descriptorResponse.error.message)

    const result = yield* capabilities.dispatch(
      { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki },
      "capability.call",
      call(spoofed.key.peerID, root.id, { path: "a.txt" }, descriptorResponse.descriptor.contract),
    )
    const parsed = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(result, { onExcessProperty: "error" })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected identity mismatch")
    expect(parsed.error.code).toBe("IDENTITY_MISMATCH")
  }))

  it.live("keeps deny-by-default authority for a separately paired peer", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "a.txt"), "a\n"))
    const remote = identity("No Read")
    const reader = identity("Reader")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    yield* peers.trust({ identity: remote.identity })
    const root = yield* roots.approve(remote.key.peerID, repo, "repo")
    const trustedReader = yield* peers.trust({ identity: reader.identity })
    yield* peers.setGrant({
      peerID: reader.key.peerID,
      expectedRevision: trustedReader.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const descriptorRaw = yield* capabilities.dispatch(
      { peerID: reader.key.peerID, fingerprint: reader.key.fingerprint, publicKeySpki: reader.key.publicKeySpki },
      "capability.describe",
      { capability: "read" },
    )
    const descriptorResponse = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(descriptorRaw, {
      onExcessProperty: "error",
    })
    if (!descriptorResponse.ok) throw new Error(descriptorResponse.error.message)

    const result = yield* capabilities.dispatch(
      { peerID: remote.key.peerID, fingerprint: remote.key.fingerprint, publicKeySpki: remote.key.publicKeySpki },
      "capability.call",
      call(remote.key.peerID, root.id, { path: "a.txt" }, descriptorResponse.descriptor.contract),
    )
    const parsed = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(result, { onExcessProperty: "error" })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected authority denial")
    expect(parsed.error.code).toBe("AUTHORITY_DENIED")
  }))

  it.live("routes find and project through shared Exchange owners without leaking canonical paths", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(path.join(repo, "src"), { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "remote-project", scripts: { test: "bun test" } })))
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "src", "alpha.txt"), "needle one\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "src", "beta.txt"), "needle two\n"))

    const source = identity("Machine A")
    const target = identity("Machine B")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")

    const targetMaterial = yield* Effect.promise(() => OfxpCertificate.issue(target.key))
    const sourceMaterial = yield* Effect.promise(() => OfxpCertificate.issue(source.key))
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
    const connection = yield* Effect.acquireRelease(
      Effect.promise(() =>
        OfxpTransport.ClientConnection.connect({
          material: sourceMaterial,
          host: endpoint.host,
          port: endpoint.port,
          expectedPeerID: target.key.peerID,
        }),
      ),
      (value) => Effect.promise(() => value.close()),
    )

    const findDescriptor = yield* Effect.promise(() => describeCapability(connection, "find"))
    const projectDescriptor = yield* Effect.promise(() => describeCapability(connection, "project"))

    const found = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* Effect.promise(() =>
        connection.request<unknown>(
          "capability.call",
          call(source.key.peerID, root.id, { grep: "needle", path: "src" }, findDescriptor.contract, "find"),
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(found.ok).toBe(true)
    if (!found.ok) throw new Error(found.error.message)
    expect(found.result.output).toContain("/repo/src/alpha.txt")
    expect(found.result.output).toContain("/repo/src/beta.txt")
    expect(JSON.stringify(found)).not.toContain(repo)

    const project = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* Effect.promise(() =>
        connection.request<unknown>(
          "capability.call",
          call(source.key.peerID, root.id, { action: "summary" }, projectDescriptor.contract, "project"),
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(project.ok).toBe(true)
    if (!project.ok) throw new Error(project.error.message)
    expect(project.result.output).toContain("ecosystem=")
    expect(project.result.title).toBe("/repo")
    expect(JSON.stringify(project)).not.toContain(repo)
  }))

  it.live("executes typed Git and deduplicates a mutation by InvocationID with a durable receipt", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => $`git init`.cwd(repo).quiet())
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "a.txt"), "hello\n"))

    const source = identity("Git Source")
    const target = identity("Git Target")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, git: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")

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
    const connection = yield* Effect.acquireRelease(
      Effect.promise(() =>
        OfxpTransport.ClientConnection.connect({
          material: sourceMaterial,
          host: endpoint.host,
          port: endpoint.port,
          expectedPeerID: target.key.peerID,
        }),
      ),
      (value) => Effect.promise(() => value.close()),
    )

    const listed = Schema.decodeUnknownSync(Ofxp.CapabilityListResponse)(
      yield* Effect.promise(() => connection.request<unknown>("capability.list", { rootID: root.id })),
      { onExcessProperty: "error" },
    )
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.capabilities.map((item) => item.id)).toEqual(["git"])
    const descriptor = yield* Effect.promise(() => describeCapability(connection, "git"))

    const status = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* Effect.promise(() =>
        connection.request<unknown>("capability.call", call(source.key.peerID, root.id, { mode: "status" }, descriptor.contract, "git")),
      ),
      { onExcessProperty: "error" },
    )
    expect(status.ok).toBe(true)
    if (!status.ok) throw new Error(status.error.message)
    expect(status.result.output).toContain("a.txt")
    expect(JSON.stringify(status)).not.toContain(repo)

    const invocationID = Ofxp.InvocationID.create()
    const stageCall = call(
      source.key.peerID,
      root.id,
      { mode: "stage", paths: ["a.txt"] },
      descriptor.contract,
      "git",
      invocationID,
    )
    const staged = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* Effect.promise(() => connection.request<unknown>("capability.call", stageCall)),
      { onExcessProperty: "error" },
    )
    expect(staged.ok).toBe(true)
    if (!staged.ok) throw new Error(staged.error.message)
    expect((yield* Effect.promise(() => $`git diff --cached --name-only`.cwd(repo).text())).trim()).toBe("a.txt")

    const duplicate = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* Effect.promise(() => connection.request<unknown>("capability.call", stageCall)),
      { onExcessProperty: "error" },
    )
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error(duplicate.error.message)
    expect(duplicate.result.output).toContain("already committed")

    const receipt = Schema.decodeUnknownSync(Ofxp.ReceiptGetResponse)(
      yield* Effect.promise(() => connection.request<unknown>("receipt.get", { invocationID })),
      { onExcessProperty: "error" },
    )
    expect(receipt.ok).toBe(true)
    if (!receipt.ok) throw new Error(receipt.error.message)
    expect(receipt.receipt.state).toBe("committed")
    expect(receipt.receipt.operation).toBe("git.stage")
  }))

  it.live("exposes process through the lazy OFXP catalog, descriptor contract, and dispatcher", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    const source = identity("Process Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, process: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }

    const listed = Schema.decodeUnknownSync(Ofxp.CapabilityListResponse)(
      yield* capabilities.dispatch(peer, "capability.list", { rootID: root.id }),
      { onExcessProperty: "error" },
    )
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.capabilities.map((item) => item.id)).toContain("process")

    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "process" }),
      { onExcessProperty: "error" },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)
    expect(described.descriptor.capability.requiresRoot).toBe(true)
    expect(described.descriptor.capability.commitClass).toBe("durable_start")

    const response = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "start", command: nodeCommand("process.stdout.write('dispatcher\\n')"), mode: "foreground", yieldMs: 5_000 },
          described.descriptor.contract,
          "process",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.output).toBe("dispatcher\n")
    expect(response.result.metadata).toMatchObject({ capability: "process", rootID: root.id })
    expect(JSON.stringify(response)).not.toContain(repo)
    expect(JSON.stringify(response)).not.toContain('"pid"')
  }))

  it.live("shares read-grounding with edit and patch through the public OFXP dispatcher", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    const target = path.join(repo, "a.txt")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(target, "alpha\n"))
    const source = identity("Mutation Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true, write: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }

    const listed = Schema.decodeUnknownSync(Ofxp.CapabilityListResponse)(
      yield* capabilities.dispatch(peer, "capability.list", { rootID: root.id }),
      { onExcessProperty: "error" },
    )
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.capabilities.map((item) => item.id)).toEqual(expect.arrayContaining(["read", "write", "edit", "patch"]))

    const describe = (capability: Ofxp.CapabilityID) =>
      capabilities.dispatch(peer, "capability.describe", { capability }).pipe(
        Effect.map((value) => Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(value, { onExcessProperty: "error" })),
        Effect.map((value) => {
          if (!value.ok) throw new Error(value.error.message)
          return value.descriptor
        }),
      )
    const readDescriptor = yield* describe("read")
    const editDescriptor = yield* describe("edit")
    const patchDescriptor = yield* describe("patch")
    expect(editDescriptor.capability.commitClass).toBe("non_idempotent_mutation")
    expect(patchDescriptor.capability.commitClass).toBe("non_idempotent_mutation")

    const sessionA = SessionID.descending()
    const read = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { path: "a.txt" }, readDescriptor.contract, "read", undefined, sessionA),
      ),
      { onExcessProperty: "error" },
    )
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.error.message)
    expect((read.result.metadata as { grounded?: boolean }).grounded).toBe(true)
    expect(read.result.output).toContain("alpha")

    // Simulate a non-OFXP writer after Session A's read. The same Session must
    // now refuse even an edit that otherwise matches the current bytes.
    yield* Effect.promise(() => fs.writeFile(target, "bravo\n"))
    const stale = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { path: "a.txt", oldString: "bravo", newString: "STALE" },
          editDescriptor.contract,
          "edit",
          undefined,
          sessionA,
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(stale.ok).toBe(false)
    if (stale.ok) throw new Error("grounded stale edit unexpectedly succeeded")
    expect(stale.error.code).toBe("CONFLICT")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("bravo\n")

    const sessionB = SessionID.descending()
    const edited = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { path: "a.txt", oldString: "bravo", newString: "BRAVO" },
          editDescriptor.contract,
          "edit",
          undefined,
          sessionB,
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(edited.ok).toBe(true)
    if (!edited.ok) throw new Error(edited.error.message)
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("BRAVO\n")

    const patched = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { patchText: "*** Begin Patch\n*** Update File: a.txt\n@@\n-BRAVO\n+FINAL\n*** End Patch" },
          patchDescriptor.contract,
          "patch",
          undefined,
          sessionB,
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(patched.ok).toBe(true)
    if (!patched.ok) throw new Error(patched.error.message)
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("FINAL\n")
    expect(JSON.stringify({ read, stale, edited, patched })).not.toContain(repo)
  }))

  it.live("executes shared SymPy through the public lazy OFXP dispatcher", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    const source = identity("SymPy Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, process: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }
    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "sympy" }),
      { onExcessProperty: "error" },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)
    expect(described.descriptor.capability).toMatchObject({ authority: "process", commitClass: "safe_read", requiresRoot: true })

    const response = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { expr: "x**2 - 4", operation: "factor" },
          described.descriptor.contract,
          "sympy",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.output).toContain("(x - 2)*(x + 2)")
    expect(JSON.stringify(response)).not.toContain(repo)
  }))

  it.live("splits typecheck read/explain authority from compiler process authority through the public dispatcher", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const rootDir = path.join(tmp.path, "typecheck-root")
    const repo = path.join(rootDir, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() =>
      Promise.all([
        fs.writeFile(
          path.join(repo, "tsconfig.custom.json"),
          JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext" } }),
        ),
        fs.writeFile(path.join(repo, "ok.ts"), "export const answer: number = 42\n"),
        fs.writeFile(path.join(repo, "bad.ts"), 'export const answer: number = "forty-two"\n'),
      ]),
    )

    const source = identity("Typecheck Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    const readGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, rootDir, "repo-root")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }

    const readList = Schema.decodeUnknownSync(Ofxp.CapabilityListResponse)(
      yield* capabilities.dispatch(peer, "capability.list", { rootID: root.id }),
      { onExcessProperty: "error" },
    )
    expect(readList.ok).toBe(true)
    if (!readList.ok) throw new Error(readList.error.message)
    expect(readList.capabilities.map((item) => item.id)).toContain("typecheck")
    expect(readList.capabilities.map((item) => item.id)).not.toContain("process")

    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "typecheck" }),
      { onExcessProperty: "error" },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)
    const contract = described.descriptor.contract

    const explained = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { mode: "explain", filePath: "TS2307" }, contract, "typecheck"),
      ),
      { onExcessProperty: "error" },
    )
    expect(explained.ok).toBe(true)
    if (!explained.ok) throw new Error(explained.error.message)
    expect(explained.result.output).toContain('code="TS2307"')

    const denied = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { workdir: "repo", mode: "file", filePath: "ok.ts", tsconfig: "tsconfig.custom.json" },
          contract,
          "typecheck",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(denied.ok).toBe(false)
    if (denied.ok) throw new Error("read-only peer unexpectedly ran the compiler")
    expect(denied.error.code).toBe("AUTHORITY_DENIED")

    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, process: true },
    })
    const processList = Schema.decodeUnknownSync(Ofxp.CapabilityListResponse)(
      yield* capabilities.dispatch(peer, "capability.list", { rootID: root.id }),
      { onExcessProperty: "error" },
    )
    expect(processList.ok).toBe(true)
    if (!processList.ok) throw new Error(processList.error.message)
    expect(processList.capabilities.map((item) => item.id)).toEqual(expect.arrayContaining(["process", "sympy", "typecheck"]))
    expect(processList.capabilities.map((item) => item.id)).not.toContain("read")

    const passed = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { workdir: "repo", mode: "file", filePath: "ok.ts", tsconfig: "tsconfig.custom.json", timeoutMs: 20_000 },
          contract,
          "typecheck",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(passed.ok).toBe(true)
    if (!passed.ok) throw new Error(passed.error.message)
    expect(passed.result.output).toContain('status="passed"')
    expect(JSON.stringify(passed)).not.toContain(rootDir)

    const failed = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { workdir: "repo", mode: "file", filePath: "bad.ts", tsconfig: "tsconfig.custom.json", timeoutMs: 20_000 },
          contract,
          "typecheck",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(failed.ok).toBe(true)
    if (!failed.ok) throw new Error(failed.error.message)
    expect(failed.result.output).toContain('status="failed"')
    expect(failed.result.output).toContain("TS2322")
    expect(JSON.stringify(failed)).not.toContain(rootDir)

    const workspaceFiles = yield* Effect.promise(() => fs.readdir(repo))
    expect(workspaceFiles.some((name) => name.startsWith(".openfork-typecheck-") || name.startsWith(".opencode-typecheck-"))).toBe(false)

    const escaped = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { workdir: "repo", mode: "file", filePath: "../outside.ts", tsconfig: "tsconfig.custom.json" },
          contract,
          "typecheck",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(escaped.ok).toBe(false)
    if (escaped.ok) throw new Error("typecheck path escape unexpectedly succeeded")
    expect(["INVALID_REQUEST", "ROOT_NOT_FOUND", "NOT_FOUND"]).toContain(escaped.error.code)
  }))

  it.live("routes archive through the shared owner with read/write split, path confinement, and mutation receipts", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const rootDir = path.join(tmp.path, "archive-root")
    const outside = path.join(tmp.path, "outside")
    yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
    yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(rootDir, "source.txt"), "archive probe\n"))
    yield* Effect.promise(() =>
      fs.symlink(outside, path.join(rootDir, "linked-outside"), process.platform === "win32" ? "junction" : "dir"),
    )

    const source = identity("Archive Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    const readGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, rootDir, "archive-root")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }
    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "archive" }),
      { onExcessProperty: "error" },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)
    expect(described.descriptor.capability).toMatchObject({
      authority: "read",
      commitClass: "non_idempotent_mutation",
    })
    const contract = described.descriptor.contract
    const listedCatalog = Schema.decodeUnknownSync(Ofxp.CapabilityListResponse)(
      yield* capabilities.dispatch(peer, "capability.list", { rootID: root.id }),
      { onExcessProperty: "error" },
    )
    expect(listedCatalog.ok).toBe(true)
    if (!listedCatalog.ok) throw new Error(listedCatalog.error.message)
    expect(listedCatalog.capabilities.map((item) => item.id)).toContain("archive")

    const deniedCreate = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "create", path: "bundle.zip", source: ["source.txt"] },
          contract,
          "archive",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(deniedCreate.ok).toBe(false)
    if (deniedCreate.ok) throw new Error("read-only peer unexpectedly created an archive")
    expect(deniedCreate.error.code).toBe("AUTHORITY_DENIED")

    const readWriteGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true, write: true },
    })
    const createInvocation = Ofxp.InvocationID.create()
    const createRequest = call(
      source.key.peerID,
      root.id,
      { action: "create", path: "bundle.zip", source: ["source.txt"] },
      contract,
      "archive",
      createInvocation,
    )
    const created = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(peer, "capability.call", createRequest),
      { onExcessProperty: "error" },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.error.message)
    expect(created.result.output).not.toContain(rootDir)
    expect(created.result.metadata).toMatchObject({
      action: "create",
      receipt: { state: "committed", invocationID: createInvocation },
    })
    const firstArchive = yield* Effect.promise(() => fs.readFile(path.join(rootDir, "bundle.zip")))
    const duplicate = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(peer, "capability.call", createRequest),
      { onExcessProperty: "error" },
    )
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error(duplicate.error.message)
    expect(duplicate.result.output).toContain("already committed")
    expect((yield* Effect.promise(() => fs.readFile(path.join(rootDir, "bundle.zip")))).equals(firstArchive)).toBe(true)

    const readOnlyAgain = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readWriteGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const listed = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { action: "list", path: "bundle.zip" }, contract, "archive"),
      ),
      { onExcessProperty: "error" },
    )
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.result.output).toContain("source.txt")
    expect(JSON.stringify(listed)).not.toContain(rootDir)

    const read = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "read", path: "bundle.zip", entry: "source.txt" },
          contract,
          "archive",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.error.message)
    expect(read.result.output).toContain("archive probe")

    const deniedExtract = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "extract", path: "bundle.zip", destination: "out" },
          contract,
          "archive",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(deniedExtract.ok).toBe(false)
    if (deniedExtract.ok) throw new Error("read-only peer unexpectedly extracted an archive")
    expect(deniedExtract.error.code).toBe("AUTHORITY_DENIED")

    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readOnlyAgain.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true, write: true },
    })
    const extracted = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "extract", path: "bundle.zip", destination: "out" },
          contract,
          "archive",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) throw new Error(extracted.error.message)
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "out", "source.txt"), "utf8"))).toBe("archive probe\n")
    expect(JSON.stringify(extracted)).not.toContain(rootDir)

    const symlinkEscape = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "extract", path: "bundle.zip", destination: "linked-outside/out" },
          contract,
          "archive",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(symlinkEscape.ok).toBe(false)
    if (symlinkEscape.ok) throw new Error("archive extraction escaped through a symlink")
    expect(["INVALID_REQUEST", "ROOT_CHANGED"]).toContain(symlinkEscape.error.code)
    expect(yield* Effect.promise(() => fs.readdir(outside))).toEqual([])
  }))

  it.live("requires process authority for system-backed OFXP archive inspection and fails closed for extraction", Effect.gen(function* () {
    if (!Bun.which("python") || !Bun.which("tar")) return
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const rootDir = path.join(tmp.path, "archive-system")
    yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
    const payload = path.join(rootDir, "payload.txt")
    const archivePath = path.join(rootDir, "data.tar.xz")
    yield* Effect.promise(() => fs.writeFile(payload, "system archive content\n"))
    const code = yield* Effect.promise(
      () =>
        Bun.spawn([
          "python",
          "-c",
          "import tarfile,sys; t=tarfile.open(sys.argv[1],'w:xz'); t.add(sys.argv[2], arcname='folder/payload.txt'); t.close()",
          archivePath,
          payload,
        ]).exited,
    )
    expect(code).toBe(0)

    const source = identity("System Archive Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    const readGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, rootDir, "archive-system")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }
    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "archive" }),
      { onExcessProperty: "error" },
    )
    if (!described.ok) throw new Error(described.error.message)
    const contract = described.descriptor.contract

    const denied = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { action: "list", path: "data.tar.xz" }, contract, "archive"),
      ),
      { onExcessProperty: "error" },
    )
    expect(denied.ok).toBe(false)
    if (denied.ok) throw new Error("system-backed archive inspection unexpectedly ran without process authority")
    expect(denied.error.code).toBe("AUTHORITY_DENIED")

    const readProcessGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true, process: true },
    })
    const listed = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { action: "list", path: "data.tar.xz" }, contract, "archive"),
      ),
      { onExcessProperty: "error" },
    )
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.result.output).toContain("folder/payload.txt")
    expect(JSON.stringify(listed)).not.toContain(rootDir)

    const read = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "read", path: "data.tar.xz", entry: "folder/payload.txt" },
          contract,
          "archive",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.error.message)
    expect(read.result.output).toContain("system archive content")

    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readProcessGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true, write: true, process: true },
    })
    const failClosed = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "extract", path: "data.tar.xz", destination: "out" },
          contract,
          "archive",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(failClosed.ok).toBe(false)
    if (failClosed.ok) throw new Error("system-backed archive extraction unexpectedly succeeded")
    expect(failClosed.error.code).toBe("INVALID_REQUEST")
    expect(failClosed.error.message).toContain("system-backed archive extraction is disabled")
  }))

  it.live("routes file-backed JSON through the shared owner with operation-specific authority and receipt non-replay", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const rootDir = path.join(tmp.path, "json-root")
    const outside = path.join(tmp.path, "outside-json")
    const file = path.join(rootDir, "app.json")
    yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
    yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(file, '{ "name": "openfork", "version": 1 }\n'))
    yield* Effect.promise(() => fs.writeFile(path.join(outside, "secret.json"), '{"secret":true}\n'))
    yield* Effect.promise(() =>
      fs.symlink(outside, path.join(rootDir, "linked-outside"), process.platform === "win32" ? "junction" : "dir"),
    )

    const source = identity("JSON Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    const readGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, rootDir, "json-root")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }
    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "json" }),
      { onExcessProperty: "error" },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)
    expect(described.descriptor.capability).toMatchObject({
      authority: "read",
      requiresRoot: false,
      commitClass: "non_idempotent_mutation",
    })
    const contract = described.descriptor.contract

    const queried = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { mode: "query", filePath: "app.json", path: "$.name" },
          contract,
          "json",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(queried.ok).toBe(true)
    if (!queried.ok) throw new Error(queried.error.message)
    expect(queried.result.output).toContain("openfork")
    expect(JSON.stringify(queried)).not.toContain(rootDir)

    const symlinkEscape = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { mode: "query", filePath: "linked-outside/secret.json", path: "$.secret" },
          contract,
          "json",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(symlinkEscape.ok).toBe(false)
    if (symlinkEscape.ok) throw new Error("JSON read escaped through a symlink")
    expect(["INVALID_REQUEST", "ROOT_CHANGED"]).toContain(symlinkEscape.error.code)
    expect(JSON.stringify(symlinkEscape)).not.toContain(outside)

    const deniedWrite = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { mode: "format", filePath: "app.json", indent: 0, dryRun: false },
          contract,
          "json",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(deniedWrite.ok).toBe(false)
    if (deniedWrite.ok) throw new Error("read-only peer unexpectedly committed JSON")
    expect(deniedWrite.error.code).toBe("AUTHORITY_DENIED")

    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, write: true },
    })
    const writeCatalog = Schema.decodeUnknownSync(Ofxp.CapabilityListResponse)(
      yield* capabilities.dispatch(peer, "capability.list", { rootID: root.id }),
      { onExcessProperty: "error" },
    )
    expect(writeCatalog.ok).toBe(true)
    if (!writeCatalog.ok) throw new Error(writeCatalog.error.message)
    expect(writeCatalog.capabilities.map((item) => item.id)).toContain("json")

    const invocationID = Ofxp.InvocationID.create()
    const request = call(
      source.key.peerID,
      root.id,
      { mode: "format", filePath: "app.json", indent: 0, dryRun: false },
      contract,
      "json",
      invocationID,
    )
    const formatted = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(peer, "capability.call", request),
      { onExcessProperty: "error" },
    )
    expect(formatted.ok).toBe(true)
    if (!formatted.ok) throw new Error(formatted.error.message)
    expect(formatted.result.output).toContain('written="true"')
    expect(formatted.result.metadata).toMatchObject({
      receipt: { state: "committed", invocationID },
    })
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe('{"name":"openfork","version":1}')
    expect(JSON.stringify(formatted)).not.toContain(rootDir)

    yield* Effect.promise(() => fs.writeFile(file, '{"externally":"changed"}\n'))
    const duplicate = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(peer, "capability.call", request),
      { onExcessProperty: "error" },
    )
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error(duplicate.error.message)
    expect(duplicate.result.output).toContain("already committed")
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe('{"externally":"changed"}\n')
  }))

  it.live("allows rootless bounded inline JSON analysis while still requiring a JSON authority grant", Effect.gen(function* () {
    const source = identity("Inline JSON Peer")
    const peers = yield* OfxpPeer.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }
    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "json" }),
      { onExcessProperty: "error" },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)

    const response = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        {
          context: context(source.key.peerID),
          capability: "json",
          contract: described.descriptor.contract,
          args: { mode: "query", jsonText: '{"nested":{"value":42}}', path: "$.nested.value" },
        },
      ),
      { onExcessProperty: "error" },
    )
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.output).toContain("42")
    expect(response.result.metadata).toMatchObject({ capability: "json" })
  }))

  it.live("routes SQLite through the shared owner with read/write authority, path confinement, and run non-replay", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const rootDir = path.join(tmp.path, "sqlite-root")
    const outside = path.join(tmp.path, "sqlite-outside")
    const dbPath = path.join(rootDir, "app.db")
    yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
    yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
    yield* Effect.sync(() => {
      const db = new BunDatabase(dbPath)
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items(name) VALUES ('one')")
      db.close()
      const external = new BunDatabase(path.join(outside, "outside.db"))
      external.exec("CREATE TABLE secrets (value TEXT); INSERT INTO secrets(value) VALUES ('outside')")
      external.close()
    })
    yield* Effect.promise(() =>
      fs.symlink(outside, path.join(rootDir, "linked-outside"), process.platform === "win32" ? "junction" : "dir"),
    )

    const source = identity("SQLite Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    const readGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, rootDir, "sqlite-root")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }
    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "sqlite" }),
      { onExcessProperty: "error" },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)
    expect(described.descriptor.capability).toMatchObject({
      authority: "read",
      requiresRoot: true,
      commitClass: "non_idempotent_mutation",
    })
    const contract = described.descriptor.contract

    const queried = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "query", db: "app.db", sql: "SELECT name FROM items ORDER BY id" },
          contract,
          "sqlite",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(queried.ok).toBe(true)
    if (!queried.ok) throw new Error(queried.error.message)
    expect(queried.result.output).toContain("one")
    expect(JSON.stringify(queried)).not.toContain(rootDir)

    const deniedRun = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "run", db: "app.db", sql: "INSERT INTO items(name) VALUES ('two')", dryRun: false },
          contract,
          "sqlite",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(deniedRun.ok).toBe(false)
    if (deniedRun.ok) throw new Error("read-only peer unexpectedly ran a SQLite mutation")
    expect(deniedRun.error.code).toBe("AUTHORITY_DENIED")

    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, write: true },
    })
    const writeCatalog = Schema.decodeUnknownSync(Ofxp.CapabilityListResponse)(
      yield* capabilities.dispatch(peer, "capability.list", { rootID: root.id }),
      { onExcessProperty: "error" },
    )
    expect(writeCatalog.ok).toBe(true)
    if (!writeCatalog.ok) throw new Error(writeCatalog.error.message)
    expect(writeCatalog.capabilities.map((item) => item.id)).toContain("sqlite")

    const invocationID = Ofxp.InvocationID.create()
    const request = call(
      source.key.peerID,
      root.id,
      { action: "run", db: "app.db", sql: "INSERT INTO items(name) VALUES ('two')", dryRun: false },
      contract,
      "sqlite",
      invocationID,
    )
    const ran = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(peer, "capability.call", request),
      { onExcessProperty: "error" },
    )
    expect(ran.ok).toBe(true)
    if (!ran.ok) throw new Error(ran.error.message)
    expect(ran.result.output).toContain("COMMITTED")
    expect(ran.result.metadata).toMatchObject({
      receipt: { state: "committed", invocationID },
    })

    const duplicate = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(peer, "capability.call", request),
      { onExcessProperty: "error" },
    )
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error(duplicate.error.message)
    expect(duplicate.result.output).toContain("already committed")
    expect(
      yield* Effect.sync(() => {
        const db = new BunDatabase(dbPath, { readonly: true })
        const count = (db.query("SELECT COUNT(*) AS c FROM items").get() as { c: number }).c
        db.close()
        return count
      }),
    ).toBe(2)

    const escapedAttach = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          {
            action: "run",
            db: "app.db",
            attach: ["linked-outside/outside.db"],
            sql: "INSERT INTO items(name) VALUES ('escape')",
            dryRun: false,
          },
          contract,
          "sqlite",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(escapedAttach.ok).toBe(false)
    if (escapedAttach.ok) throw new Error("SQLite attach escaped through a symlink")
    expect(["INVALID_REQUEST", "ROOT_CHANGED"]).toContain(escapedAttach.error.code)
  }))

  it.live("requires separate read/write authority for SQLite export and confines the output path", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const rootDir = path.join(tmp.path, "sqlite-export")
    const outside = path.join(tmp.path, "sqlite-export-outside")
    const dbPath = path.join(rootDir, "app.db")
    yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
    yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
    yield* Effect.sync(() => {
      const db = new BunDatabase(dbPath)
      db.exec("CREATE TABLE items (name TEXT); INSERT INTO items(name) VALUES ('alpha'), ('beta')")
      db.close()
    })
    yield* Effect.promise(() =>
      fs.symlink(outside, path.join(rootDir, "linked-outside"), process.platform === "win32" ? "junction" : "dir"),
    )

    const source = identity("SQLite Export Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    const readGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, rootDir, "sqlite-export")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }
    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "sqlite" }),
      { onExcessProperty: "error" },
    )
    if (!described.ok) throw new Error(described.error.message)
    const contract = described.descriptor.contract
    const args = {
      action: "export" as const,
      db: "app.db",
      sql: "SELECT name FROM items ORDER BY name",
      outputPath: "out/items.csv",
    }

    const denied = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, args, contract, "sqlite"),
      ),
      { onExcessProperty: "error" },
    )
    expect(denied.ok).toBe(false)
    if (denied.ok) throw new Error("read-only peer unexpectedly exported SQLite data")
    expect(denied.error.code).toBe("AUTHORITY_DENIED")

    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true, write: true },
    })
    const exported = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, args, contract, "sqlite"),
      ),
      { onExcessProperty: "error" },
    )
    expect(exported.ok).toBe(true)
    if (!exported.ok) throw new Error(exported.error.message)
    expect(exported.result.output).toContain("Exported 2 rows")
    expect(yield* Effect.promise(() => fs.readFile(path.join(rootDir, "out", "items.csv"), "utf8"))).toContain("alpha")
    expect(JSON.stringify(exported)).not.toContain(rootDir)

    const escaped = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { ...args, outputPath: "linked-outside/items.csv" },
          contract,
          "sqlite",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(escaped.ok).toBe(false)
    if (escaped.ok) throw new Error("SQLite export escaped through a symlink")
    expect(["INVALID_REQUEST", "ROOT_CHANGED"]).toContain(escaped.error.code)
    expect(yield* Effect.promise(() => fs.readdir(outside))).toEqual([])
  }))

  it.live("routes durable memory through the shared owner with read/write authority and receipt-backed non-replay", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const rootDir = path.join(tmp.path, "memory-root")
    yield* Effect.promise(() => fs.mkdir(rootDir, { recursive: true }))
    const source = identity("Memory Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    const readGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, rootDir, "memory-root")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }
    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "memory" }),
      { onExcessProperty: "error" },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)
    expect(described.descriptor.capability).toMatchObject({
      authority: "read",
      requiresRoot: true,
      commitClass: "non_idempotent_mutation",
    })
    const contract = described.descriptor.contract

    const mapped = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { action: "map" }, contract, "memory"),
      ),
      { onExcessProperty: "error" },
    )
    expect(mapped.ok).toBe(true)
    if (!mapped.ok) throw new Error(mapped.error.message)
    expect(mapped.result.output).toContain("memory-map")
    expect(JSON.stringify(mapped)).not.toContain(rootDir)

    const denied = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          {
            action: "remember",
            content: "OFXP memory receipt probe uses the shared ExchangeMemory owner.",
            stableKey: "ofxp-memory-receipt-probe",
            evidence: [{ source_type: "user_message" }],
          },
          contract,
          "memory",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(denied.ok).toBe(false)
    if (denied.ok) throw new Error("read-only peer unexpectedly wrote durable memory")
    expect(denied.error.code).toBe("AUTHORITY_DENIED")

    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true, write: true },
    })
    const invocationID = Ofxp.InvocationID.create()
    const request = call(
      source.key.peerID,
      root.id,
      {
        action: "remember",
        content: "OFXP memory receipt probe uses the shared ExchangeMemory owner.",
        stableKey: "ofxp-memory-receipt-probe",
        evidence: [{ source_type: "user_message" }],
      },
      contract,
      "memory",
      invocationID,
    )
    const remembered = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(peer, "capability.call", request),
      { onExcessProperty: "error" },
    )
    expect(remembered.ok).toBe(true)
    if (!remembered.ok) throw new Error(remembered.error.message)
    expect(remembered.result.output).toContain("<memory id=")
    expect(remembered.result.metadata).toMatchObject({
      receipt: { state: "committed", invocationID },
    })
    expect(JSON.stringify(remembered)).not.toContain(rootDir)

    const duplicate = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(peer, "capability.call", request),
      { onExcessProperty: "error" },
    )
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error(duplicate.error.message)
    expect(duplicate.result.output).toContain("already committed")

    const searched = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { action: "search", query: "ofxp-memory-receipt-probe" },
          contract,
          "memory",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(searched.ok).toBe(true)
    if (!searched.ok) throw new Error(searched.error.message)
    expect(searched.result.output).toContain("ofxp-memory-receipt-probe")
  }))

  it.live("lists tests with read authority and receipt-backs non-idempotent test execution", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const rootDir = path.join(tmp.path, "test-root")
    const pkg = path.join(rootDir, "pkg")
    const marker = path.join(pkg, "runs.txt")
    yield* Effect.promise(() => fs.mkdir(pkg, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ scripts: { test: "bun test" } })))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(pkg, "probe.test.ts"),
        [
          'import { test, expect } from "bun:test"',
          'import { appendFileSync } from "node:fs"',
          'appendFileSync(new URL("./runs.txt", import.meta.url), "run\\n")',
          'test("ofxp test probe", () => expect(21 * 2).toBe(42))',
          "",
        ].join("\n"),
      ),
    )
    const outside = path.join(tmp.path, "outside-tests")
    const linkedOutside = path.join(pkg, "linked-outside")
    yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(outside, "escape.test.ts"), "throw new Error('must not run')\n"))
    yield* Effect.promise(() => fs.symlink(outside, linkedOutside, process.platform === "win32" ? "junction" : "dir"))

    const source = identity("Test Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    const readGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true },
    })
    const root = yield* roots.approve(source.key.peerID, rootDir, "test-root")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }

    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "test" }),
      { onExcessProperty: "error" },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)
    expect(described.descriptor.capability).toMatchObject({ authority: "process", commitClass: "non_idempotent_mutation" })
    const contract = described.descriptor.contract

    const listed = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { workdir: "pkg", action: "list" }, contract, "test"),
      ),
      { onExcessProperty: "error" },
    )
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.error.message)
    expect(listed.result.output).toContain("probe.test.ts")
    expect(JSON.stringify(listed)).not.toContain(rootDir)

    const traversal = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { workdir: "pkg", action: "list", path: "../pkg" }, contract, "test"),
      ),
      { onExcessProperty: "error" },
    )
    expect(traversal.ok).toBe(false)
    if (traversal.ok) throw new Error("test traversal unexpectedly succeeded")
    expect(traversal.error.code).toBe("INVALID_REQUEST")

    const symlinkEscape = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { workdir: "pkg", action: "list", path: "linked-outside" }, contract, "test"),
      ),
      { onExcessProperty: "error" },
    )
    expect(symlinkEscape.ok).toBe(false)
    if (symlinkEscape.ok) throw new Error("test symlink escape unexpectedly succeeded")
    expect(symlinkEscape.error.code).toBe("INVALID_REQUEST")
    expect(JSON.stringify(symlinkEscape)).not.toContain(outside)

    const denied = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { workdir: "pkg", action: "run", path: "probe.test.ts" }, contract, "test"),
      ),
      { onExcessProperty: "error" },
    )
    expect(denied.ok).toBe(false)
    if (denied.ok) throw new Error("read-only peer unexpectedly executed tests")
    expect(denied.error.code).toBe("AUTHORITY_DENIED")

    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: readGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, process: true },
    })
    const processOnlyCatalog = Schema.decodeUnknownSync(Ofxp.CapabilityListResponse)(
      yield* capabilities.dispatch(peer, "capability.list", { rootID: root.id }),
      { onExcessProperty: "error" },
    )
    expect(processOnlyCatalog.ok).toBe(true)
    if (!processOnlyCatalog.ok) throw new Error(processOnlyCatalog.error.message)
    expect(processOnlyCatalog.capabilities.map((item) => item.id)).toContain("test")
    const invocationID = Ofxp.InvocationID.create()
    const request = call(
      source.key.peerID,
      root.id,
      { workdir: "pkg", action: "run", path: "probe.test.ts", timeoutMs: 10_000 },
      contract,
      "test",
      invocationID,
    )
    const ran = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(peer, "capability.call", request),
      { onExcessProperty: "error" },
    )
    expect(ran.ok).toBe(true)
    if (!ran.ok) throw new Error(ran.error.message)
    expect(ran.result.output).toContain('status="passed"')
    expect(ran.result.output).toContain("1 passed / 0 failed")
    expect(JSON.stringify(ran)).not.toContain(rootDir)
    expect((yield* Effect.promise(() => fs.readFile(marker, "utf8"))).trim().split(/\r?\n/)).toHaveLength(1)

    const duplicate = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(peer, "capability.call", request),
      { onExcessProperty: "error" },
    )
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error(duplicate.error.message)
    expect(duplicate.result.output).toContain("already committed")
    expect(duplicate.result.metadata).toMatchObject({ duplicate: true })
    expect((yield* Effect.promise(() => fs.readFile(marker, "utf8"))).trim().split(/\r?\n/)).toHaveLength(1)
  }))

  it.live("retires timed-out test process trees, cleans reporter files, and strips ambient secrets", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const rootDir = path.join(tmp.path, "test-root")
    const pkg = path.join(rootDir, "pkg")
    const vitestDir = path.join(pkg, "node_modules", "vitest")
    const leakedSecret = path.join(pkg, "secret-seen.txt")
    const childPidFile = path.join(pkg, "child.pid")
    yield* Effect.promise(() => fs.mkdir(vitestDir, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(pkg, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "0.0.0-test" } }),
      ),
    )
    yield* Effect.promise(() => fs.writeFile(path.join(pkg, "probe.test.ts"), "export {}\n"))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(vitestDir, "package.json"),
        JSON.stringify({ name: "vitest", version: "0.0.0-test", type: "module", bin: "cli.mjs" }),
      ),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(vitestDir, "cli.mjs"),
        [
          'import fs from "node:fs"',
          'import path from "node:path"',
          'import { spawn } from "node:child_process"',
          'const outputArg = process.argv.find((arg) => arg.startsWith("--outputFile="))',
          'if (!outputArg) throw new Error("missing reporter output file")',
          'const outputFile = outputArg.slice("--outputFile=".length)',
          `const leakedSecret = ${JSON.stringify(leakedSecret)}`,
          `const childPidFile = ${JSON.stringify(childPidFile)}`,
          'if (process.env.OFXP_TEST_API_KEY) fs.writeFileSync(leakedSecret, "leaked")',
          'fs.writeFileSync(outputFile, JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, success: true, testResults: [] }))',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], { cwd: path.dirname(childPidFile), stdio: "ignore" })',
          'fs.writeFileSync(childPidFile, String(child.pid))',
          'setTimeout(() => {}, 30000)',
          "",
        ].join("\n"),
      ),
    )

    const previousSecret = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = process.env.OFXP_TEST_API_KEY
        process.env.OFXP_TEST_API_KEY = "must-not-reach-child"
        return previous
      }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OFXP_TEST_API_KEY
          else process.env.OFXP_TEST_API_KEY = previous
        }),
    )
    void previousSecret

    const source = identity("Timed Test Peer")
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, process: true },
    })
    const root = yield* roots.approve(source.key.peerID, rootDir, "test-root")
    const peer = { peerID: source.key.peerID, fingerprint: source.key.fingerprint, publicKeySpki: source.key.publicKeySpki }
    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(peer, "capability.describe", { capability: "test" }),
      { onExcessProperty: "error" },
    )
    expect(described.ok).toBe(true)
    if (!described.ok) throw new Error(described.error.message)

    const ran = Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { workdir: "pkg", action: "run", path: "probe.test.ts", timeoutMs: 1_000 },
          described.descriptor.contract,
          "test",
        ),
      ),
      { onExcessProperty: "error" },
    )
    expect(ran.ok).toBe(true)
    if (!ran.ok) throw new Error(ran.error.message)
    expect(ran.result.output).toContain('status="timed-out"')
    expect(ran.result.metadata).toMatchObject({ partial: true, status: "timed-out" })
    expect(JSON.stringify(ran)).not.toContain(rootDir)
    expect(yield* Effect.promise(() => fs.stat(leakedSecret).then(() => true).catch(() => false))).toBe(false)
    expect((yield* Effect.promise(() => fs.readdir(pkg))).some((name) => name.startsWith(".openfork-test-") && name.endsWith(".json"))).toBe(false)
    const childPid = Number((yield* Effect.promise(() => fs.readFile(childPidFile, "utf8"))).trim())
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true)
    const childGone = yield* Effect.promise(async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try {
          process.kill(childPid, 0)
        } catch {
          return true
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      try {
        process.kill(childPid, 0)
        return false
      } catch {
        return true
      }
    })
    expect(childGone).toBe(true)
  }))
})
