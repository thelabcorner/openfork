export * as OfxpPatchCapability from "./patch"

import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeGrounding } from "@/exchange/grounding"
import { ExchangePatch } from "@/exchange/patch"
import { ExchangeRead } from "@/exchange/read"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpPrincipal } from "../principal"
import { OfxpRoot } from "../root"

export const Parameters = ExchangePatch.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly invocations: OfxpInvocation.Interface
  readonly grounding: ExchangeGrounding.Interface
  readonly fs: FSUtil.Interface
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly grantRevision: number
}

type ControlError =
  | OfxpPeer.OfxpPeerSchema.NotFoundError
  | OfxpPeer.OfxpPeerSchema.StaleRevisionError
  | OfxpPeer.OfxpPeerSchema.AuthorityDeniedError
  | OfxpRoot.InvalidPathError
  | OfxpRoot.RootChangedError
  | OfxpInvocation.OfxpInvocationSchema.NotFoundError
  | OfxpInvocation.OfxpInvocationSchema.CollisionError
  | OfxpInvocation.OfxpInvocationSchema.InvalidTransitionError
  | OfxpInvocation.OfxpInvocationSchema.ValidationError

export const execute = Effect.fn("OfxpPatchCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP patch arguments are invalid" }),
  })
  const admission = yield* deps.peers.authorize({ peerID: peer.peerID, capability: "write", rootID: call.rootID })
  const root = yield* deps.roots.resolve(admission)
  const principal = OfxpPrincipal.key(peer.peerID, call.context)
  const scopedGrounding = deps.grounding.scoped(principal)
  const targetRef = root.virtualPath
  const admitted = yield* deps.invocations.admit({
    invocationID: call.context.invocationID,
    sourcePeerID: peer.peerID,
    operation: "patch",
    commitClass: "non_idempotent_mutation",
    requestDigest: ExchangeRequestDigest.sha256("ofxp:patch:v1", {
      rootID: root.rootID,
      input,
      principal,
    }),
    targetRef,
  })

  if (!admitted.fresh) {
    const receipt = admitted.receipt
    if (receipt.state === "committed") {
      return {
        title: "patch",
        output: `OFXP patch invocation ${receipt.invocationID} was already committed; no duplicate patch was executed.`,
        metadata: { root: targetRef, duplicate: true, receipt },
        grantRevision: admission.grantRevision,
      } satisfies Result
    }
    if (receipt.state === "started") {
      return yield* new ExchangeError.AmbiguousCommit({
        detail: `OFXP patch invocation ${receipt.invocationID} crossed its commit boundary; inspect the affected files before issuing another patch`,
        targetRef,
      })
    }
    if (receipt.state === "cancelled") {
      return yield* new ExchangeError.Cancelled({ detail: `OFXP patch invocation ${receipt.invocationID} was already cancelled` })
    }
    if (receipt.state === "failed") {
      return yield* new ExchangeError.Conflict({ detail: `OFXP patch invocation ${receipt.invocationID} already failed; use a new InvocationID` })
    }
  }

  const revalidate = Effect.fn("OfxpPatchCapability.revalidate")(function* () {
    const fresh = yield* deps.peers.authorize({
      peerID: peer.peerID,
      capability: "write",
      rootID: call.rootID,
      expectedGrantRevision: admission.grantRevision,
    })
    const verified = yield* deps.roots.verify(fresh)
    if (FSUtil.normalizePath(verified.rootPath) !== FSUtil.normalizePath(root.rootPath)) {
      return yield* new OfxpRoot.RootChangedError({ detail: "OFXP patch root identity changed before commit" })
    }
  })

  let started = false
  const execution = yield* ExchangePatch.execute<ControlError>(
    deps.fs,
    input,
    {
      resolve: (relativePath, allowMissing) =>
        deps.roots
          .resolve(admission, relativePath, { allowMissing })
          .pipe(Effect.map((resolved) => ({ path: resolved.path, displayPath: resolved.virtualPath }))),
      revalidate: () => revalidate().pipe(Effect.asVoid),
      beforeCommit: () =>
        deps.invocations
          .prepare({ invocationID: call.context.invocationID, targetRef })
          .pipe(Effect.tap(() => Effect.sync(() => (started = true))), Effect.asVoid),
    },
    signal,
  ).pipe(
    Effect.tapError((error) => {
      if (error instanceof ExchangeError.AmbiguousCommit) return Effect.void
      const state = error instanceof ExchangeError.Cancelled ? "cancelled" : "failed"
      return deps.invocations
        .settle({ invocationID: call.context.invocationID, state, targetRef })
        .pipe(Effect.catch(() => Effect.void), Effect.asVoid)
    }),
  )

  if (!started) yield* revalidate()
  if (execution.result.mutation.committed) {
    for (const touch of execution.touched) {
      if (touch.type === "delete" || touch.type === "move") scopedGrounding.remove(root.rootID, touch.sourcePath)
      if (!touch.targetPath) continue
      const stat = yield* deps.fs.stat(touch.targetPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (stat) scopedGrounding.note(root.rootID, touch.targetPath, ExchangeRead.statFingerprint(stat))
      else scopedGrounding.remove(root.rootID, touch.targetPath)
    }
  }

  const receipt = yield* deps.invocations
    .settle({ invocationID: call.context.invocationID, state: "committed", targetRef })
    .pipe(
      Effect.mapError(
        () =>
          new ExchangeError.AmbiguousCommit({
            detail: `OFXP patch completed but its durable receipt could not be settled; reconcile InvocationID ${call.context.invocationID} before retrying`,
            targetRef,
          }),
      ),
    )
  return {
    title: execution.result.title,
    output: execution.result.output,
    metadata: { ...execution.result.metadata, invocationID: call.context.invocationID, receipt },
    grantRevision: admission.grantRevision,
  } satisfies Result
})

