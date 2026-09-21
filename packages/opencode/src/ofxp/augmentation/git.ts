export * as OfxpGitCapability from "./git"

import { Effect, Schema } from "effect"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import { GitTyped } from "@/git/typed"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpRoot } from "../root"

export const Parameters = GitTyped.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly invocations: OfxpInvocation.Interface
  readonly app: AppProcess.Interface
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

function preserveControlError(error: unknown): error is ControlError {
  return (
    error instanceof OfxpPeer.OfxpPeerSchema.NotFoundError ||
    error instanceof OfxpPeer.OfxpPeerSchema.StaleRevisionError ||
    error instanceof OfxpPeer.OfxpPeerSchema.AuthorityDeniedError ||
    error instanceof OfxpRoot.InvalidPathError ||
    error instanceof OfxpRoot.RootChangedError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.NotFoundError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.CollisionError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.InvalidTransitionError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.ValidationError
  )
}

function mapExecutionError(error: unknown, signal?: AbortSignal) {
  if (preserveControlError(error)) return error
  if (signal?.aborted) return new ExchangeError.Cancelled({ detail: "OFXP Git operation was cancelled" })
  return new ExchangeError.Conflict({
    detail: error instanceof Error ? error.message.slice(0, 1000) : "OFXP Git operation failed",
  })
}

export const execute = Effect.fn("OfxpGitCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  const args = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP Git arguments are invalid" }),
  })
  const admission = yield* deps.peers.authorize({ peerID: peer.peerID, capability: "git", rootID: call.rootID })
  const root = yield* deps.roots.resolve(admission)
  const worktree = yield* GitTyped.resolveWorktreeRoot(deps.app, root.rootPath).pipe(
    Effect.mapError(() => new ExchangeError.InvalidArgument({ detail: "The approved OFXP root is not a Git worktree" })),
  )
  if (FSUtil.normalizePath(worktree) !== FSUtil.normalizePath(root.rootPath)) {
    return yield* new ExchangeError.InvalidArgument({
      detail: "OFXP Git requires the approved root itself to be the repository worktree root",
    })
  }

  const revalidate = Effect.fn("OfxpGitCapability.revalidate")(function* () {
    const fresh = yield* deps.peers.authorize({
      peerID: peer.peerID,
      capability: "git",
      rootID: call.rootID,
      expectedGrantRevision: admission.grantRevision,
    })
    const verified = yield* deps.roots.verify(fresh)
    if (FSUtil.normalizePath(verified.rootPath) !== FSUtil.normalizePath(worktree)) {
      return yield* new OfxpRoot.RootChangedError({ detail: "OFXP Git repository identity changed" })
    }
  })

  const mutating = GitTyped.isMutating(args)
  if (!mutating) {
    const result = yield* GitTyped.execute(deps.app, args, worktree, signal).pipe(
      Effect.mapError((error) => mapExecutionError(error, signal)),
    )
    yield* revalidate()
    return {
      title: result.title,
      output: result.output,
      metadata: { ...result.metadata, root: root.virtualPath },
      grantRevision: admission.grantRevision,
    } satisfies Result
  }

  const requestDigest = ExchangeRequestDigest.sha256("ofxp:git:v1", { rootID: call.rootID, args })
  const admitted = yield* deps.invocations.admit({
    invocationID: call.context.invocationID,
    sourcePeerID: peer.peerID,
    operation: `git.${args.mode ?? "status"}`,
    commitClass: "non_idempotent_mutation",
    requestDigest,
    targetRef: root.virtualPath,
  })

  if (!admitted.fresh) {
    const receipt = admitted.receipt
    if (receipt.state === "committed") {
      return {
        title: `git ${args.mode ?? "status"}`,
        output: `OFXP Git invocation ${receipt.invocationID} was already committed; no duplicate mutation was executed.`,
        metadata: { duplicate: true, receipt, root: root.virtualPath },
        grantRevision: admission.grantRevision,
      } satisfies Result
    }
    if (receipt.state === "started") {
      return yield* new ExchangeError.AmbiguousCommit({
        detail: `OFXP Git invocation ${receipt.invocationID} crossed its mutation-start boundary; reconcile repository state before issuing another mutation`,
        targetRef: root.virtualPath,
      })
    }
    if (receipt.state === "cancelled") {
      return yield* new ExchangeError.Cancelled({ detail: `OFXP Git invocation ${receipt.invocationID} was already cancelled` })
    }
    if (receipt.state === "failed") {
      return yield* new ExchangeError.Conflict({
        detail: `OFXP Git invocation ${receipt.invocationID} already failed; inspect repository state before using a new InvocationID`,
      })
    }
    // admitted means the mutation-start boundary was never crossed; resuming
    // the SAME invocation is safe.
  }

  let started = false
  const beforeMutation = Effect.fn("OfxpGitCapability.beforeMutation")(function* () {
    yield* revalidate()
    yield* deps.invocations.prepare({
      invocationID: call.context.invocationID,
      targetRef: root.virtualPath,
    })
    started = true
  })

  const result = yield* GitTyped.execute(deps.app, args, worktree, signal, beforeMutation).pipe(
    Effect.mapError((error) =>
      started
        ? new ExchangeError.AmbiguousCommit({
            detail: `OFXP Git invocation ${call.context.invocationID} may have mutated the repository; inspect its receipt and repository state before retrying`,
            targetRef: root.virtualPath,
          })
        : mapExecutionError(error, signal),
    ),
    Effect.tapError((error) => {
      if (started || error instanceof ExchangeError.AmbiguousCommit) return Effect.void
      const state = error instanceof ExchangeError.Cancelled ? "cancelled" : "failed"
      return deps.invocations
        .settle({ invocationID: call.context.invocationID, state })
        .pipe(Effect.catch(() => Effect.void), Effect.asVoid)
    }),
  )

  const settled = yield* deps.invocations
    .settle({ invocationID: call.context.invocationID, state: "committed", targetRef: root.virtualPath })
    .pipe(
      Effect.mapError(
        () =>
          new ExchangeError.AmbiguousCommit({
            detail: `OFXP Git mutation completed but its receipt could not be settled; reconcile InvocationID ${call.context.invocationID} before retrying`,
            targetRef: root.virtualPath,
          }),
      ),
    )

  return {
    title: result.title,
    output: result.output,
    metadata: {
      ...result.metadata,
      root: root.virtualPath,
      invocationID: call.context.invocationID,
      receipt: settled,
    },
    grantRevision: admission.grantRevision,
  } satisfies Result
})

