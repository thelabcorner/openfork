import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, PlatformError } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { OfxpIdentity } from "@opencode-ai/core/ofxp-peer/identity"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { SessionID } from "@opencode-ai/schema/session-id"
import { ExchangeError } from "../../src/exchange/error"
import { ExchangeGrounding } from "../../src/exchange/grounding"
import { ExchangeRead } from "../../src/exchange/read"
import { OfxpEditCapability } from "../../src/ofxp/augmentation/edit"
import { OfxpPatchCapability } from "../../src/ofxp/augmentation/patch"
import type { PeerCertificateIdentity } from "../../src/ofxp/certificate"
import { OfxpPrincipal } from "../../src/ofxp/principal"
import { OfxpRoot } from "../../src/ofxp/root"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, FSUtil.node, OfxpPeer.node, OfxpInvocation.node, OfxpRoot.node, ExchangeGrounding.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

function failure(method: string, description: string): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: "Unknown",
    module: "FSUtil",
    method,
    description,
  })
}

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
  rootID: Ofxp.RootID,
  capability: "edit" | "patch",
  args: unknown,
  invocationID = Ofxp.InvocationID.create(),
): Ofxp.CapabilityCall {
  return {
    context: {
      invocationID,
      traceID: Ofxp.TraceID.create(),
      sourcePeerID: peerID,
      sourceSessionID,
      plane: "augmentation",
      hopCount: 0,
    },
    rootID,
    capability,
    contract: "broker-v1:000000000000000000000000",
    args,
  }
}

function setup(
  peers: OfxpPeer.Interface,
  roots: OfxpRoot.Interface,
  repo: string,
  source: ReturnType<typeof identity>,
) {
  return Effect.gen(function* () {
    const trusted = yield* peers.trust({ identity: source.identity })
    const granted = yield* peers.setGrant({
      peerID: source.key.peerID,
      expectedRevision: trusted.info.grantRevision,
      grant: { ...Ofxp.DENY_GRANT, write: true },
    })
    const root = yield* roots.approve(source.key.peerID, repo, "repo")
    return { granted, root }
  })
}

describe("OFXP shared edit/patch capabilities", () => {
  it.live("runs shared precision edit and deduplicates the same InvocationID", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    const target = path.join(repo, "a.txt")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(target, "alpha\n"))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const grounding = yield* ExchangeGrounding.Service
    const afs = yield* FSUtil.Service
    const source = identity("edit")
    const { root } = yield* setup(peers, roots, repo, source)
    const session = SessionID.descending()
    const invocationID = Ofxp.InvocationID.create()
    const request = call(
      source.key.peerID,
      session,
      root.id,
      "edit",
      { path: "a.txt", oldString: "alpha", newString: "ALPHA" },
      invocationID,
    )
    const deps = { peers, roots, invocations, grounding, fs: afs }

    const first = yield* OfxpEditCapability.execute(deps, source.certificate, request)
    expect(first.output).toContain("Edit applied successfully")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("ALPHA\n")
    expect(JSON.stringify(first)).not.toContain(repo)

    const duplicate = yield* OfxpEditCapability.execute(deps, source.certificate, request)
    expect(duplicate.output).toContain("already committed")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("ALPHA\n")
    expect((yield* invocations.get(source.key.peerID, invocationID)).state).toBe("committed")
  }))

  it.live("keeps read-grounding isolated to the originating peer Session", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    const target = path.join(repo, "a.txt")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(target, "alpha\n"))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const grounding = yield* ExchangeGrounding.Service
    const afs = yield* FSUtil.Service
    const source = identity("grounding")
    const { root } = yield* setup(peers, roots, repo, source)
    const sessionA = SessionID.descending()
    const sessionB = SessionID.descending()
    const contextA: Ofxp.InvocationContext = {
      invocationID: Ofxp.InvocationID.create(),
      traceID: Ofxp.TraceID.create(),
      sourcePeerID: source.key.peerID,
      sourceSessionID: sessionA,
      plane: "augmentation",
      hopCount: 0,
    }
    const stat = yield* afs.stat(target)
    grounding.scoped(OfxpPrincipal.key(source.key.peerID, contextA)).note(root.id, target, ExchangeRead.statFingerprint(stat))
    yield* Effect.promise(() => fs.writeFile(target, "bravo\n"))
    const deps = { peers, roots, invocations, grounding, fs: afs }

    const stale = yield* OfxpEditCapability.execute(
      deps,
      source.certificate,
      call(source.key.peerID, sessionA, root.id, "edit", { path: "a.txt", oldString: "bravo", newString: "A" }),
    ).pipe(Effect.flip)
    expect(stale).toBeInstanceOf(Error)
    expect(String(stale)).toContain("changed after it was last read")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("bravo\n")

    const otherSession = yield* OfxpEditCapability.execute(
      deps,
      source.certificate,
      call(source.key.peerID, sessionB, root.id, "edit", { path: "a.txt", oldString: "bravo", newString: "BRAVO" }),
    )
    expect(otherSession.output).toContain("Edit applied successfully")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("BRAVO\n")
  }))

  it.live("applies one shared multi-file patch and deduplicates it by InvocationID", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "a.txt"), "alpha\n"))
    yield* Effect.promise(() => fs.writeFile(path.join(repo, "b.txt"), "bravo\n"))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const grounding = yield* ExchangeGrounding.Service
    const afs = yield* FSUtil.Service
    const source = identity("patch")
    const { root } = yield* setup(peers, roots, repo, source)
    const invocationID = Ofxp.InvocationID.create()
    const request = call(
      source.key.peerID,
      SessionID.descending(),
      root.id,
      "patch",
      {
        patchText: [
          "*** Begin Patch",
          "*** Update File: a.txt",
          "@@",
          "-alpha",
          "+ALPHA",
          "*** Update File: b.txt",
          "@@",
          "-bravo",
          "+BRAVO",
          "*** End Patch",
        ].join("\n"),
      },
      invocationID,
    )
    const deps = { peers, roots, invocations, grounding, fs: afs }

    const first = yield* OfxpPatchCapability.execute(deps, source.certificate, request)
    expect(first.output).toContain("applied")
    expect(yield* Effect.promise(() => fs.readFile(path.join(repo, "a.txt"), "utf8"))).toBe("ALPHA\n")
    expect(yield* Effect.promise(() => fs.readFile(path.join(repo, "b.txt"), "utf8"))).toBe("BRAVO\n")
    expect(JSON.stringify(first)).not.toContain(repo)

    const duplicate = yield* OfxpPatchCapability.execute(deps, source.certificate, request)
    expect(duplicate.output).toContain("already committed")
    expect((yield* invocations.get(source.key.peerID, invocationID)).state).toBe("committed")
  }))

  it.live("keeps patch dry-run mutation-free and rejects path escape before commit", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    const target = path.join(repo, "a.txt")
    const outside = path.join(tmp.path, "escape.txt")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(target, "alpha\n"))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const grounding = yield* ExchangeGrounding.Service
    const afs = yield* FSUtil.Service
    const source = identity("patch-safety")
    const { root } = yield* setup(peers, roots, repo, source)
    const deps = { peers, roots, invocations, grounding, fs: afs }
    const dryInvocation = Ofxp.InvocationID.create()

    const dry = yield* OfxpPatchCapability.execute(
      deps,
      source.certificate,
      call(
        source.key.peerID,
        SessionID.descending(),
        root.id,
        "patch",
        { apply: false, patchText: "*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+ALPHA\n*** End Patch" },
        dryInvocation,
      ),
    )
    expect(dry.output).toContain("dry-run")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("alpha\n")
    expect((yield* invocations.get(source.key.peerID, dryInvocation)).state).toBe("committed")

    const escapeInvocation = Ofxp.InvocationID.create()
    const escaped = yield* OfxpPatchCapability.execute(
      deps,
      source.certificate,
      call(
        source.key.peerID,
        SessionID.descending(),
        root.id,
        "patch",
        { patchText: "*** Begin Patch\n*** Add File: ../escape.txt\n+nope\n*** End Patch" },
        escapeInvocation,
      ),
    ).pipe(Effect.flip)
    expect(escaped).toBeInstanceOf(OfxpRoot.InvalidPathError)
    expect(yield* Effect.promise(() => fs.stat(outside).then(() => true, () => false))).toBe(false)
    expect((yield* invocations.get(source.key.peerID, escapeInvocation)).state).toBe("failed")
  }))

  it.live("refuses a patch when write authority changes during planning", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    const target = path.join(repo, "a.txt")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(target, "alpha\n"))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const grounding = yield* ExchangeGrounding.Service
    const afs = yield* FSUtil.Service
    const source = identity("patch-revoke")
    const { granted, root } = yield* setup(peers, roots, repo, source)
    const invocationID = Ofxp.InvocationID.create()
    let revoked = false
    const revokingFs = FSUtil.Service.of({
      ...afs,
      readFile: (pathname) => {
        if (pathname !== target || revoked) return afs.readFile(pathname)
        revoked = true
        return peers
          .setGrant({
            peerID: source.key.peerID,
            expectedRevision: granted.info.grantRevision,
            grant: { ...Ofxp.DENY_GRANT },
          })
          .pipe(Effect.orDie, Effect.andThen(afs.readFile(pathname)))
      },
    })
    const request = call(
      source.key.peerID,
      SessionID.descending(),
      root.id,
      "patch",
      { patchText: "*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+ALPHA\n*** End Patch" },
      invocationID,
    )

    const error = yield* OfxpPatchCapability.execute(
      { peers, roots, invocations, grounding, fs: revokingFs },
      source.certificate,
      request,
    ).pipe(Effect.flip)
    expect(error).toBeInstanceOf(OfxpPeer.OfxpPeerSchema.StaleRevisionError)
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("alpha\n")
    expect((yield* invocations.get(source.key.peerID, invocationID)).state).toBe("failed")
  }))

  it.live("keeps an ambiguous edit receipt started and refuses to replay the same InvocationID", Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (item) => Effect.promise(() => item[Symbol.asyncDispose]()))
    const repo = path.join(tmp.path, "repo")
    const target = path.join(repo, "a.txt")
    yield* Effect.promise(() => fs.mkdir(repo, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(target, "alpha\n"))
    const peers = yield* OfxpPeer.Service
    const roots = yield* OfxpRoot.Service
    const invocations = yield* OfxpInvocation.Service
    const grounding = yield* ExchangeGrounding.Service
    const afs = yield* FSUtil.Service
    const source = identity("edit-ambiguous")
    const { root } = yield* setup(peers, roots, repo, source)
    const invocationID = Ofxp.InvocationID.create()
    const request = call(
      source.key.peerID,
      SessionID.descending(),
      root.id,
      "edit",
      { path: "a.txt", oldString: "alpha", newString: "ALPHA" },
      invocationID,
    )
    let renameCount = 0
    const uncertain = FSUtil.Service.of({
      ...afs,
      rename: (from, to) => {
        renameCount++
        if (renameCount === 1) {
          return afs.rename(from, to).pipe(Effect.andThen(Effect.fail(failure("rename", "injected visible failure"))))
        }
        if (renameCount === 2) {
          return Effect.fail(failure("rename", "injected rollback failure"))
        }
        return afs.rename(from, to)
      },
    })
    const deps = { peers, roots, invocations, grounding, fs: uncertain }

    const ambiguous = yield* OfxpEditCapability.execute(deps, source.certificate, request).pipe(Effect.flip)
    expect(ambiguous).toBeInstanceOf(ExchangeError.AmbiguousCommit)
    expect((yield* invocations.get(source.key.peerID, invocationID)).state).toBe("started")
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("ALPHA\n")
    const renameCountAfterFailure = renameCount

    const replay = yield* OfxpEditCapability.execute(deps, source.certificate, request).pipe(Effect.flip)
    expect(replay).toBeInstanceOf(ExchangeError.AmbiguousCommit)
    expect(renameCount).toBe(renameCountAfterFailure)
    expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("ALPHA\n")
  }))
})

