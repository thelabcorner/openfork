export * as OfxpEditCapability from "./edit"

import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeEdit } from "@/exchange/edit"
import { ExchangeError } from "@/exchange/error"
import { ExchangeGrounding } from "@/exchange/grounding"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpPrincipal } from "../principal"
import { OfxpRoot } from "../root"

export const Parameters = ExchangeEdit.Parameters

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

export const execute = Effect.fn("OfxpEditCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP edit arguments are invalid" }),
  })
  const admission = yield* deps.peers.authorize({ peerID: peer.peerID, capability: "write", rootID: call.rootID })
  const resolved = yield* deps.roots.resolve(admission, input.path)
  const principal = OfxpPrincipal.key(peer.peerID, call.context)
  const scopedGrounding = deps.grounding.scoped(principal)
  const groundedFingerprint = scopedGrounding.get(resolved.rootID, resolved.path)
  const targetRef = resolved.virtualPath
  const admitted = yield* deps.invocations.admit({
    invocationID: call.context.invocationID,
    sourcePeerID: peer.peerID,
    operation: "edit",
    commitClass: "non_idempotent_mutation",
    requestDigest: ExchangeRequestDigest.sha256("ofxp:edit:v1", {
      rootID: resolved.rootID,
      input,
      principal,
    }),
    targetRef,
  })

  if (!admitted.fresh) {
    const receipt = admitted.receipt
    if (receipt.state === "committed") {
      return {
        title: targetRef,
        output: `OFXP edit invocation ${receipt.invocationID} was already committed; no duplicate edit was executed.`,
        metadata: { path: targetRef, duplicate: true, receipt },
        grantRevision: admission.grantRevision,
      } satisfies Result
    }
    if (receipt.state === "started") {
      return yield* new ExchangeError.AmbiguousCommit({
        detail: `OFXP edit invocation ${receipt.invocationID} crossed its commit boundary; read ${targetRef} before issuing another edit`,
        targetRef,
      })
    }
    if (receipt.state === "cancelled") {
      return yield* new ExchangeError.Cancelled({ detail: `OFXP edit invocation ${receipt.invocationID} was already cancelled` })
    }
    if (receipt.state === "failed") {
      return yield* new ExchangeError.Conflict({ detail: `OFXP edit invocation ${receipt.invocationID} already failed; use a new InvocationID` })
    }
  }

  const revalidate = Effect.fn("OfxpEditCapability.revalidate")(function* () {
    const fresh = yield* deps.peers.authorize({
      peerID: peer.peerID,
      capability: "write",
      rootID: call.rootID,
      expectedGrantRevision: admission.grantRevision,
    })
    const target = yield* deps.roots.resolve(fresh, input.path)
    if (FSUtil.normalizePath(target.path) !== FSUtil.normalizePath(resolved.path)) {
      return yield* new OfxpRoot.RootChangedError({ detail: "OFXP edit target identity changed before commit" })
    }
  })

  let started = false
  const execution = yield* ExchangeEdit.execute<ControlError>(
    deps.fs,
    {
      ...input,
      canonicalPath: resolved.path,
      displayPath: resolved.virtualPath,
      ...(groundedFingerprint === undefined ? {} : { groundedFingerprint }),
      ungroundedWarning:
        "This file has no OFXP read-grounding record for this peer/session. The edit is still verified against current content, but read it first when relying on line coordinates.",
      signal,
    },
    {
      revalidate: () => revalidate().pipe(Effect.asVoid),
      beforeCommit: () =>
        deps.invocations
          .prepare({ invocationID: call.context.invocationID, targetRef })
          .pipe(Effect.tap(() => Effect.sync(() => (started = true))), Effect.asVoid),
    },
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
  scopedGrounding.note(resolved.rootID, resolved.path, execution.fingerprint)
  const receipt = yield* deps.invocations
    .settle({ invocationID: call.context.invocationID, state: "committed", targetRef })
    .pipe(
      Effect.mapError(
        () =>
          new ExchangeError.AmbiguousCommit({
            detail: `OFXP edit completed but its durable receipt could not be settled; reconcile InvocationID ${call.context.invocationID} before retrying`,
            targetRef,
          }),
      ),
    )
  return {
    title: execution.title,
    output: execution.output,
    metadata: { ...execution.metadata, invocationID: call.context.invocationID, receipt },
    grantRevision: admission.grantRevision,
  } satisfies Result
})

