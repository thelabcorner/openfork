import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { SessionID } from "@opencode-ai/schema/session-id"
import { OfxpCapability } from "@/ofxp/capability"
import { OfxpRoot } from "@/ofxp/root"
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
      realmID: `realm:${label.toLowerCase().replaceAll(" ", "-")}`,
      label,
      publicKeySpki: key.publicKeySpki,
      fingerprint: key.fingerprint,
    } satisfies Ofxp.PeerIdentity,
  }
}

function authenticatedPeer(source: ReturnType<typeof identity>) {
  return {
    peerID: source.key.peerID,
    fingerprint: source.key.fingerprint,
    publicKeySpki: source.key.publicKeySpki,
  }
}

function context(peerID: Ofxp.PeerID, invocationID = Ofxp.InvocationID.create()): Ofxp.InvocationContext {
  return {
    invocationID,
    traceID: Ofxp.TraceID.create(),
    sourcePeerID: peerID,
    sourceSessionID: SessionID.descending(),
    plane: "augmentation",
    hopCount: 0,
  }
}

function call(
  peerID: Ofxp.PeerID,
  rootID: Ofxp.RootID,
  args: unknown,
  contract: string,
  invocationID = Ofxp.InvocationID.create(),
): Ofxp.CapabilityCall {
  return {
    context: context(peerID, invocationID),
    rootID,
    capability: "refactor",
    contract,
    args,
  }
}

function decodeCapability(value: unknown) {
  return Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(value, { onExcessProperty: "error" })
}

const describeRefactor = Effect.fnUntraced(function* (
  capabilities: OfxpCapability.Interface,
  peer: ReturnType<typeof authenticatedPeer>,
) {
  const response = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
    yield* capabilities.dispatch(peer, "capability.describe", { capability: "refactor" }),
    { onExcessProperty: "error" },
  )
  if (!response.ok) return yield* Effect.die(new Error(response.error.message))
  return response.descriptor.contract
})

describe("OFXP refactor capability", () => {
  it.live("resolves symbols with read authority only and never leaks the native root", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "a.ts"), "export const remoteValue = 1\n", "utf8"))

    const source = identity("Refactor Reader")
    const peer = authenticatedPeer(source)
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
    const contract = yield* describeRefactor(capabilities, peer)

    const response = decodeCapability(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(source.key.peerID, root.id, { mode: "resolveSymbol", filePath: "a.ts", line: 1, column: 14 }, contract),
      ),
    )
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.output).toContain("<symbol")
    expect(response.result.output).toContain("remoteValue")
    expect(response.result.metadata).toMatchObject({ capability: "refactor", rootID: root.id })
    expect(JSON.stringify(response)).not.toContain(repo)
  }))

  it.live("denies preview-producing refactors without write authority before durable plan mutation", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    const file = path.join(repo, "a.ts")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(file, "import x from 'old-module'\nexport { x }\n", "utf8"))

    const source = identity("Refactor Read Only")
    const peer = authenticatedPeer(source)
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
    const contract = yield* describeRefactor(capabilities, peer)

    const response = decodeCapability(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { mode: "updateImportSource", filePath: "a.ts", from: "old-module", to: "new-module" },
          contract,
        ),
      ),
    )
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error("read-only peer unexpectedly created a refactor preview")
    expect(response.error.code).toBe("AUTHORITY_DENIED")
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("old-module")
    expect(JSON.stringify(response)).not.toContain(repo)
  }))

  it.live("receipt-backs preview creation and never replays the same InvocationID", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    const file = path.join(repo, "a.ts")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(file, "import x from 'old-module'\nexport { x }\n", "utf8"))

    const source = identity("Refactor Preview")
    const peer = authenticatedPeer(source)
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
    const contract = yield* describeRefactor(capabilities, peer)
    const invocationID = Ofxp.InvocationID.create()
    const args = { mode: "updateImportSource", filePath: "a.ts", from: "old-module", to: "new-module" } as const
    const request = call(source.key.peerID, root.id, args, contract, invocationID)

    const preview = decodeCapability(yield* capabilities.dispatch(peer, "capability.call", request))
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error(preview.error.message)
    expect(preview.result.metadata).toMatchObject({
      planMutation: true,
      sourceMutation: false,
      invocationID,
      receipt: { state: "committed", invocationID },
    })
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("old-module")

    const duplicate = decodeCapability(yield* capabilities.dispatch(peer, "capability.call", request))
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error(duplicate.error.message)
    expect(duplicate.result.metadata).toMatchObject({ duplicate: true, receipt: { state: "committed", invocationID } })

    const receipt = Schema.decodeUnknownSync(Ofxp.ReceiptGetResponse)(
      yield* capabilities.dispatch(peer, "receipt.get", { invocationID }),
      { onExcessProperty: "error" },
    )
    expect(receipt.ok).toBe(true)
    if (!receipt.ok) throw new Error(receipt.error.message)
    expect(receipt.receipt).toMatchObject({
      invocationID,
      operation: "refactor.updateImportSource",
      commitClass: "non_idempotent_mutation",
      state: "committed",
    })
    expect(receipt.receipt.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const collision = decodeCapability(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { ...args, to: "different-module" },
          contract,
          invocationID,
        ),
      ),
    )
    expect(collision.ok).toBe(false)
    if (collision.ok) throw new Error("InvocationID collision unexpectedly replayed")
    expect(collision.error.code).toBe("CONFLICT")
    expect(JSON.stringify([preview, duplicate, receipt, collision])).not.toContain(repo)
  }))

  it.live("rejects stale previews, then applies a fresh confirmed plan exactly once", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    const file = path.join(repo, "a.ts")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(file, "import x from 'old-module'\nexport { x }\n", "utf8"))

    const source = identity("Refactor Apply")
    const peer = authenticatedPeer(source)
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
    const contract = yield* describeRefactor(capabilities, peer)
    const args = { mode: "updateImportSource", filePath: "a.ts", from: "old-module", to: "new-module" } as const

    const stalePreview = decodeCapability(
      yield* capabilities.dispatch(peer, "capability.call", call(source.key.peerID, root.id, args, contract)),
    )
    expect(stalePreview.ok).toBe(true)
    if (!stalePreview.ok) throw new Error(stalePreview.error.message)
    const stalePreviewID = String((stalePreview.result.metadata as { previewId?: unknown }).previewId)
    yield* Effect.promise(() => fs.appendFile(file, "// external change\n", "utf8"))

    const staleApply = decodeCapability(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { ...args, previewId: stalePreviewID, dryRun: false, confirm: "REFACTOR", runTypecheck: false },
          contract,
        ),
      ),
    )
    expect(staleApply.ok).toBe(false)
    if (staleApply.ok) throw new Error("stale preview unexpectedly applied")
    expect(staleApply.error.code).toBe("CONFLICT")
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("old-module")

    const freshPreview = decodeCapability(
      yield* capabilities.dispatch(peer, "capability.call", call(source.key.peerID, root.id, args, contract)),
    )
    expect(freshPreview.ok).toBe(true)
    if (!freshPreview.ok) throw new Error(freshPreview.error.message)
    const freshPreviewID = String((freshPreview.result.metadata as { previewId?: unknown }).previewId)
    const applyInvocationID = Ofxp.InvocationID.create()
    const applyRequest = call(
      source.key.peerID,
      root.id,
      { ...args, previewId: freshPreviewID, dryRun: false, confirm: "REFACTOR", runTypecheck: false },
      contract,
      applyInvocationID,
    )
    const applied = decodeCapability(yield* capabilities.dispatch(peer, "capability.call", applyRequest))
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error(applied.error.message)
    expect(applied.result.metadata).toMatchObject({
      sourceMutation: true,
      receipt: { state: "committed", invocationID: applyInvocationID },
    })
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("new-module")

    const duplicate = decodeCapability(yield* capabilities.dispatch(peer, "capability.call", applyRequest))
    expect(duplicate.ok).toBe(true)
    if (!duplicate.ok) throw new Error(duplicate.error.message)
    expect(duplicate.result.metadata).toMatchObject({ duplicate: true, receipt: { state: "committed" } })
    expect(JSON.stringify([staleApply, applied, duplicate])).not.toContain(repo)
  }))

  it.live("rejects a stale move plan when its source-to-delete changed after preview", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    const sourceFile = path.join(repo, "source.ts")
    const destinationFile = path.join(repo, "moved.ts")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(sourceFile, "export const moveMe = 1\n", "utf8"))

    const source = identity("Refactor Move Stale")
    const peer = authenticatedPeer(source)
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
    const contract = yield* describeRefactor(capabilities, peer)
    const args = { mode: "moveFileUpdateImports", filePath: "source.ts", to: "moved.ts" } as const

    const preview = decodeCapability(
      yield* capabilities.dispatch(peer, "capability.call", call(source.key.peerID, root.id, args, contract)),
    )
    if (!preview.ok) throw new Error(`${preview.error.code}: ${preview.error.message}`)
    expect(preview.ok).toBe(true)
    const previewID = String((preview.result.metadata as { previewId?: unknown }).previewId)
    yield* Effect.promise(() => fs.appendFile(sourceFile, "// changed after preview\n", "utf8"))

    const applied = decodeCapability(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { ...args, previewId: previewID, dryRun: false, confirm: "REFACTOR", runTypecheck: false },
          contract,
        ),
      ),
    )
    expect(applied.ok).toBe(false)
    if (applied.ok) throw new Error("stale source-to-delete unexpectedly applied")
    expect(applied.error.code).toBe("CONFLICT")
    expect(yield* Effect.promise(() => fs.readFile(sourceFile, "utf8"))).toContain("// changed after preview")
    expect(yield* Effect.promise(() => fs.stat(destinationFile).then(() => true).catch(() => false))).toBe(false)
    expect(JSON.stringify(applied)).not.toContain(repo)
  }))

  it.live("requires process authority only for real typecheck and executes the compiler through OFXP process ownership", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    const file = path.join(repo, "a.ts")
    const compiler = path.join(repo, "node_modules", "typescript", "lib", "tsc.js")
    const observation = path.join(repo, "compiler-observation.txt")
    yield* Effect.promise(() => fs.mkdir(path.dirname(compiler), { recursive: true }))
    yield* Effect.promise(() =>
      Promise.all([
        fs.writeFile(file, "import x from 'old-module'\nexport { x }\n", "utf8"),
        fs.writeFile(
          path.join(repo, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true }, include: ["*.ts"] }),
          "utf8",
        ),
        fs.writeFile(
          compiler,
          [
            "const fs = require('node:fs')",
            "fs.writeFileSync('compiler-observation.txt', process.env.OPENFORK_REFACTOR_SECRET_TOKEN || 'filtered')",
            "process.exit(0)",
            "",
          ].join("\n"),
          "utf8",
        ),
      ]),
    )

    const source = identity("Refactor Process")
    const peer = authenticatedPeer(source)
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const capabilities = yield* OfxpCapability.Service
    const trusted = yield* peers.trust({ identity: source.identity })
    const writeGrant = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true, write: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    const contract = yield* describeRefactor(capabilities, peer)
    const args = { mode: "updateImportSource", filePath: "a.ts", from: "old-module", to: "new-module" } as const
    const preview = decodeCapability(
      yield* capabilities.dispatch(peer, "capability.call", call(source.key.peerID, root.id, args, contract)),
    )
    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error(preview.error.message)
    const previewID = String((preview.result.metadata as { previewId?: unknown }).previewId)

    const denied = decodeCapability(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { ...args, previewId: previewID, dryRun: false, confirm: "REFACTOR" },
          contract,
        ),
      ),
    )
    expect(denied.ok).toBe(false)
    if (denied.ok) throw new Error("typechecking apply unexpectedly ran without process authority")
    expect(denied.error.code).toBe("AUTHORITY_DENIED")
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("old-module")
    expect(yield* Effect.promise(() => fs.stat(observation).then(() => true).catch(() => false))).toBe(false)

    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: writeGrant.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true, write: true, process: true },
    })
    const previous = process.env.OPENFORK_REFACTOR_SECRET_TOKEN
    process.env.OPENFORK_REFACTOR_SECRET_TOKEN = "must-not-reach-child"
    const applied = yield* capabilities.dispatch(
      peer,
      "capability.call",
      call(
        source.key.peerID,
        root.id,
        { ...args, previewId: previewID, dryRun: false, confirm: "REFACTOR" },
        contract,
      ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENFORK_REFACTOR_SECRET_TOKEN
          else process.env.OPENFORK_REFACTOR_SECRET_TOKEN = previous
        }),
      ),
    )
    const parsed = decodeCapability(applied)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error.message)
    expect(yield* Effect.promise(() => fs.readFile(observation, "utf8"))).toBe("filtered")
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("new-module")
    expect(JSON.stringify(parsed)).not.toContain(repo)
  }))

  it.live("confines existing and allow-missing paths across symlinks without native-path leakage", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (item) => Effect.promise(() => item[Symbol.asyncDispose]()),
    )
    const repo = path.join(tmp.path, "repo")
    const outside = path.join(tmp.path, "outside")
    const linkedOutside = path.join(repo, "linked-outside")
    yield* Effect.promise(() => Promise.all([fs.mkdir(repo, { recursive: true }), fs.mkdir(outside, { recursive: true })]))
    yield* Effect.promise(() =>
      Promise.all([
        fs.writeFile(path.join(repo, "a.ts"), "export const localValue = 1\n", "utf8"),
        fs.writeFile(path.join(outside, "outside.ts"), "export const outsideValue = 2\n", "utf8"),
      ]),
    )
    yield* Effect.promise(() => fs.symlink(outside, linkedOutside, process.platform === "win32" ? "junction" : "dir"))

    const source = identity("Refactor Paths")
    const peer = authenticatedPeer(source)
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
    const contract = yield* describeRefactor(capabilities, peer)

    const readEscape = decodeCapability(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { mode: "resolveSymbol", filePath: "linked-outside/outside.ts", line: 1, column: 14 },
          contract,
        ),
      ),
    )
    expect(readEscape.ok).toBe(false)
    if (readEscape.ok) throw new Error("refactor read followed a symlink outside the approved root")
    expect(readEscape.error.code).toBe("INVALID_REQUEST")

    const createEscape = decodeCapability(
      yield* capabilities.dispatch(
        peer,
        "capability.call",
        call(
          source.key.peerID,
          root.id,
          { mode: "moveFileUpdateImports", filePath: "a.ts", to: "linked-outside/new.ts" },
          contract,
        ),
      ),
    )
    expect(createEscape.ok).toBe(false)
    if (createEscape.ok) throw new Error("refactor allow-missing destination escaped through a symlink")
    expect(createEscape.error.code).toBe("INVALID_REQUEST")
    expect(yield* Effect.promise(() => fs.stat(path.join(outside, "new.ts")).then(() => true).catch(() => false))).toBe(false)
    expect(JSON.stringify([readEscape, createEscape])).not.toContain(repo)
    expect(JSON.stringify([readEscape, createEscape])).not.toContain(outside)
  }))
})
