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
import { ExchangeGrounding } from "../../src/exchange/grounding"
import { OfxpAttribution } from "../../src/ofxp/attribution"
import { OfxpEditCapability } from "../../src/ofxp/augmentation/edit"
import { OfxpPatchCapability } from "../../src/ofxp/augmentation/patch"
import { OfxpCapability } from "../../src/ofxp/capability"
import type { PeerCertificateIdentity } from "../../src/ofxp/certificate"
import { OfxpPrincipal } from "../../src/ofxp/principal"
import { OfxpRoot } from "../../src/ofxp/root"
import { tmpdir } from "../fixture/fixture"
import { drainCodingActivity, subscribeCodingActivity } from "../lib/coding-activity"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    FSUtil.node,
    OfxpPeer.node,
    OfxpInvocation.node,
    OfxpRoot.node,
    ExchangeGrounding.node,
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

function trusted(peers: OfxpPeer.Interface, source: ReturnType<typeof identity>) {
  return Effect.gen(function* () {
    const record = yield* peers.trust({ identity: source.identity })
    yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: record.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, read: true, write: true },
    })
  })
}

function capabilityCall(
  source: ReturnType<typeof identity>,
  rootID: Ofxp.RootID,
  capability: Ofxp.CapabilityID,
  contract: string,
  args: unknown,
  invocationID = Ofxp.InvocationID.create(),
  sourceSessionID = SessionID.descending(),
): Ofxp.CapabilityCall {
  return {
    context: {
      invocationID,
      traceID: Ofxp.TraceID.create(),
      sourcePeerID: source.key.peerID,
      sourceSessionID,
      plane: "augmentation",
      hopCount: 0,
    },
    rootID,
    capability,
    contract,
    args,
  }
}

const decodeResponse = (value: unknown) =>
  Schema.decodeUnknownSync(Ofxp.CapabilityResponse)(value, { onExcessProperty: "error" })

const described = (capabilities: OfxpCapability.Interface, source: ReturnType<typeof identity>, id: Ofxp.CapabilityID) =>
  Effect.gen(function* () {
    const described = Schema.decodeUnknownSync(Ofxp.CapabilityDescribeResponse)(
      yield* capabilities.dispatch(source.certificate, "capability.describe", { capability: id }),
      { onExcessProperty: "error" },
    )
    if (!described.ok) throw new Error(described.error.message)
    return described.descriptor.contract
  })

const withTmp = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(tmp.path),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("OFXP coding-activity attribution", () => {
  it.live("names the canonical approved root, never the public alias or the display-path heuristic", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const peers = yield* OfxpPeer.Service
        const roots = yield* OfxpRoot.Service
        const capabilities = yield* OfxpCapability.Service
        const source = identity("canonical")
        yield* trusted(peers, source)

        // The alias deliberately collides with a real ancestor directory name so
        // the kernel's display-path heuristic would name "holder", and a second
        // root uses an alias that is not its directory name at all.
        const holder = path.join(dir, "holder")
        const nested = path.join(holder, "repo")
        const renamed = path.join(holder, "workspace")
        const nestedFile = path.join(nested, "a.txt")
        const renamedFile = path.join(renamed, "b.txt")
        yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(renamed, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(nestedFile, "nested\n"))
        yield* Effect.promise(() => fs.writeFile(renamedFile, "renamed\n"))

        const nestedRoot = yield* roots.approve(source.key.peerID, nested, "repo")
        const renamedRoot = yield* roots.approve(source.key.peerID, renamed, "totally-different")
        const contract = yield* described(capabilities, source, "read")
        const log = yield* subscribeCodingActivity

        for (const [root, file] of [
          [nestedRoot, nestedFile],
          [renamedRoot, renamedFile],
        ] as const) {
          const response = decodeResponse(
            yield* capabilities.dispatch(
              source.certificate,
              "capability.call",
              capabilityCall(source, root.id, "read", contract, { path: path.basename(file) }),
            ),
          )
          expect(response.ok).toBe(true)
        }

        const events = yield* drainCodingActivity(log, "ofxp-canonical")
        const mine = events.filter((event) => event.source === "ofxp")
        expect(mine).toHaveLength(2)
        expect(mine.find((event) => event.entity === nestedFile)?.project).toBe("repo")
        expect(mine.find((event) => event.entity === renamedFile)?.project).toBe("workspace")
        // The granted root's own path, re-verified at admission, is the folder.
        // The second root's alias is not its directory name at all, so only the
        // resolved rootPath can name it correctly.
        expect(mine.find((event) => event.entity === nestedFile)?.projectFolder).toBe(nested)
        expect(mine.find((event) => event.entity === renamedFile)?.projectFolder).toBe(renamed)
        for (const event of mine) {
          expect(path.isAbsolute(event.projectFolder!)).toBe(true)
        }
        // Neither the colliding alias nor the unrelated alias names a project.
        expect(events.some((event) => event.project === "holder")).toBe(false)
        expect(events.some((event) => event.project === "totally-different")).toBe(false)
        // ...and neither may stand in for a directory either.
        for (const leaked of ["holder", "repo", "totally-different", "workspace"]) {
          expect(mine.map((event) => event.projectFolder)).not.toContain(leaked)
        }
      }),
    ),
  )

  it.live("attributes a remote read and write exactly once, and stays silent on replay, conflict and no-op", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const peers = yield* OfxpPeer.Service
        const roots = yield* OfxpRoot.Service
        const capabilities = yield* OfxpCapability.Service
        const source = identity("rw")
        yield* trusted(peers, source)
        const repo = path.join(dir, "repo")
        const target = path.join(repo, "a.txt")
        yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
        const root = yield* roots.approve(source.key.peerID, repo, "remote-alias")
        const readContract = yield* described(capabilities, source, "read")
        const writeContract = yield* described(capabilities, source, "write")
        const log = yield* subscribeCodingActivity
        // One remote session, so every record in this call is one principal's work.
        const session = SessionID.descending()

        const readCall = capabilityCall(
          source,
          root.id,
          "read",
          readContract,
          { path: "a.txt" },
          Ofxp.InvocationID.create(),
          session,
        )
        const read = decodeResponse(
          yield* capabilities.dispatch(source.certificate, "capability.call", {
            ...readCall,
            args: { path: "missing.txt" },
          }),
        )
        expect(read.ok).toBe(false)

        const writeCall = capabilityCall(
          source,
          root.id,
          "write",
          writeContract,
          { path: "a.txt", content: "alpha\nbravo\n" },
          Ofxp.InvocationID.create(),
          session,
        )
        const first = decodeResponse(yield* capabilities.dispatch(source.certificate, "capability.call", writeCall))
        expect(first.ok).toBe(true)

        const replay = decodeResponse(yield* capabilities.dispatch(source.certificate, "capability.call", writeCall))
        expect(replay.ok).toBe(true)

        const noop = decodeResponse(
          yield* capabilities.dispatch(
            source.certificate,
            "capability.call",
            capabilityCall(
              source,
              root.id,
              "write",
              writeContract,
              { path: "a.txt", content: "alpha\nbravo\n" },
              Ofxp.InvocationID.create(),
              session,
            ),
          ),
        )
        expect(noop.ok).toBe(true)

        const conflict = decodeResponse(
          yield* capabilities.dispatch(
            source.certificate,
            "capability.call",
            capabilityCall(
              source,
              root.id,
              "write",
              writeContract,
              { path: "a.txt", content: "charlie\n", expectedFingerprint: "0:0" },
              Ofxp.InvocationID.create(),
              session,
            ),
          ),
        )
        expect(conflict.ok).toBe(false)

        const readAfter = decodeResponse(yield* capabilities.dispatch(source.certificate, "capability.call", readCall))
        expect(readAfter.ok).toBe(true)

        const events = yield* drainCodingActivity(log, "ofxp-readwrite")
        const mine = events.filter((event) => event.entity === target)
        expect(mine.map((event) => `${event.kind}:${event.aiLineChanges}`).slice().sort()).toEqual(["read:undefined", "write:2"])
        for (const event of mine) {
          expect(event.source).toBe("ofxp")
          expect(event.project).toBe("repo")
          expect(event.projectFolder).toBe(repo)
          // The stable principal key, not the per-call receipt token.
          expect(event.sourceRef).toBe(OfxpPrincipal.key(source.key.peerID, readCall.context))
        }
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("alpha\nbravo\n")
      }),
    ),
  )

  it.live("attributes shared edit and patch exactly once per committed file and never on replay", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const peers = yield* OfxpPeer.Service
        const roots = yield* OfxpRoot.Service
        const invocations = yield* OfxpInvocation.Service
        const grounding = yield* ExchangeGrounding.Service
        const afs = yield* FSUtil.Service
        const source = identity("editpatch")
        yield* trusted(peers, source)
        const repo = path.join(dir, "repo")
        const edited = path.join(repo, "a.txt")
        const patched = path.join(repo, "b.txt")
        yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(edited, "alpha\n"))
        yield* Effect.promise(() => fs.writeFile(patched, "bravo\n"))
        const root = yield* roots.approve(source.key.peerID, repo, "remote-alias")
        const deps = { peers, roots, invocations, grounding, fs: afs }
        const log = yield* subscribeCodingActivity

        const editInvocation = Ofxp.InvocationID.create()
        const editRequest = capabilityCall(
          source,
          root.id,
          "edit",
          "broker-v1:000000000000000000000000",
          { path: "a.txt", oldString: "alpha", newString: "ALPHA" },
          editInvocation,
        )
        yield* OfxpEditCapability.execute(deps, source.certificate, editRequest)
        const editReplay = yield* OfxpEditCapability.execute(deps, source.certificate, editRequest)
        expect(editReplay.output).toContain("already committed")

        const editConflict = yield* OfxpEditCapability.execute(
          deps,
          source.certificate,
          capabilityCall(source, root.id, "edit", "broker-v1:000000000000000000000000", {
            path: "a.txt",
            oldString: "not-present",
            newString: "nope",
          }),
        ).pipe(Effect.flip)
        expect(editConflict).toBeDefined()

        const patchInvocation = Ofxp.InvocationID.create()
        const patchRequest = capabilityCall(
          source,
          root.id,
          "patch",
          "broker-v1:000000000000000000000000",
          { patchText: "*** Begin Patch\n*** Update File: b.txt\n@@\n-bravo\n+BRAVO\n*** End Patch" },
          patchInvocation,
        )
        yield* OfxpPatchCapability.execute(deps, source.certificate, patchRequest)
        const patchReplay = yield* OfxpPatchCapability.execute(deps, source.certificate, patchRequest)
        expect(patchReplay.output).toContain("already committed")

        const dryInvocation = Ofxp.InvocationID.create()
        const dry = yield* OfxpPatchCapability.execute(
          deps,
          source.certificate,
          capabilityCall(
            source,
            root.id,
            "patch",
            "broker-v1:000000000000000000000000",
            { apply: false, patchText: "*** Begin Patch\n*** Update File: b.txt\n@@\n-BRAVO\n+bravissimo\n*** End Patch" },
            dryInvocation,
          ),
        )
        expect(dry.output).toContain("dry-run")

        const events = yield* drainCodingActivity(log, "ofxp-editpatch")
        const mine = events.filter((event) => event.source === "ofxp")
        expect(mine).toHaveLength(2)
        expect(mine.find((event) => event.entity === edited)).toMatchObject({
          kind: "write",
          project: "repo",
          projectFolder: repo,
          sourceRef: OfxpPrincipal.key(source.key.peerID, editRequest.context),
        })
        expect(mine.find((event) => event.entity === patched)).toMatchObject({
          kind: "write",
          project: "repo",
          projectFolder: repo,
          sourceRef: OfxpPrincipal.key(source.key.peerID, patchRequest.context),
        })
        expect(yield* Effect.promise(() => fs.readFile(edited, "utf8"))).toBe("ALPHA\n")
        expect(yield* Effect.promise(() => fs.readFile(patched, "utf8"))).toBe("BRAVO\n")
      }),
    ),
  )

  it.live("builds attribution from canonical root and principal metadata only", () =>
    Effect.sync(() => {
      const source = identity("shape")
      const request = capabilityCall(
        source,
        Ofxp.RootID.create(),
        "read",
        "broker-v1:000000000000000000000000",
        {},
      )
      const built = OfxpAttribution.attribution(
        { rootPath: path.join("C:", "workspaces", "canonical-repo"), alias: Ofxp.RootAlias.make("public-alias") },
        source.certificate,
        request,
      )
      expect(built.source).toBe("ofxp")
      expect(built.project).toBe("canonical-repo")
      // The folder is the granted root's own path, never its alias or basename.
      expect(built.projectFolder).toBe(path.join("C:", "workspaces", "canonical-repo"))
      expect(built.projectFolder).not.toBe("public-alias")
      expect(built.projectFolder).not.toBe("canonical-repo")
      expect(built.sourceRef).toBe(OfxpPrincipal.key(source.key.peerID, request.context))
      // The receipt token and the authorization scope are not actor identity.
      expect(built.sourceRef).not.toContain(request.context.invocationID)
      expect(Object.keys(built).slice().sort()).toEqual(["project", "projectFolder", "source", "sourceRef"])
    }),
  )
})
