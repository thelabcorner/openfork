export * as OfxpMemoryCapability from "./memory"

import { Effect, Schema } from "effect"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeMemory } from "@/exchange/memory"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpPrincipal } from "../principal"
import { OfxpRoot } from "../root"

export const Parameters = ExchangeMemory.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly invocations: OfxpInvocation.Interface
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly grantRevision: number
}

const READ_ACTIONS = new Set<ExchangeMemory.Input["action"]>(["map", "search", "open", "get", "timeline"])

function mutationBoundaryError(error: unknown): ExchangeError.Error {
  if (
    error instanceof ExchangeError.InvalidArgument ||
    error instanceof ExchangeError.Cancelled ||
    error instanceof ExchangeError.NotFound ||
    error instanceof ExchangeError.Conflict ||
    error instanceof ExchangeError.AuthorityDenied ||
    error instanceof ExchangeError.PathEscape ||
    error instanceof ExchangeError.DependencyUnavailable ||
    error instanceof ExchangeError.AmbiguousCommit
  ) {
    return error
  }
  if (error instanceof OfxpRoot.InvalidPathError) return new ExchangeError.PathEscape({ detail: error.detail })
  if (error instanceof OfxpRoot.RootChangedError) return new ExchangeError.AuthorityDenied({ detail: error.detail })
  if (
    error instanceof OfxpPeer.OfxpPeerSchema.NotFoundError ||
    error instanceof OfxpPeer.OfxpPeerSchema.StaleRevisionError ||
    error instanceof OfxpPeer.OfxpPeerSchema.AuthorityDeniedError
  ) {
    return new ExchangeError.AuthorityDenied({ detail: error.message })
  }
  if (
    error instanceof OfxpInvocation.OfxpInvocationSchema.NotFoundError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.CollisionError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.InvalidTransitionError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.ValidationError
  ) {
    return new ExchangeError.Conflict({ detail: error.message })
  }
  return new ExchangeError.DependencyUnavailable({ detail: "OFXP memory mutation boundary failed" })
}

export const execute = Effect.fn("OfxpMemoryCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  if (!call.rootID) return yield* new ExchangeError.InvalidArgument({ detail: "OFXP memory requires an approved root" })
  const rootID = call.rootID
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP memory arguments are invalid" }),
  })
  const readOnly = READ_ACTIONS.has(input.action)
  const capability: "read" | "write" = readOnly ? "read" : "write"
  const admission = yield* deps.peers.authorize({
    peerID: peer.peerID,
    capability,
    rootID,
  })
  const root = yield* deps.roots.verify(admission)
  const grantRevision = admission.grantRevision
  const principal = OfxpPrincipal.key(peer.peerID, call.context)

  const revalidate = () =>
    deps.peers
      .authorize({
        peerID: peer.peerID,
        capability,
        rootID,
        expectedGrantRevision: grantRevision,
      })
      .pipe(
        Effect.flatMap((fresh) => deps.roots.verify(fresh)),
        Effect.asVoid,
      )

  let receipt: Ofxp.InvocationReceipt | undefined
  let started = false
  const targetRef = root.virtualPath
  if (!readOnly) {
    const admitted = yield* deps.invocations.admit({
      invocationID: call.context.invocationID,
      sourcePeerID: peer.peerID,
      operation: `memory.${input.action}`,
      commitClass: "non_idempotent_mutation",
      requestDigest: ExchangeRequestDigest.sha256("ofxp:memory:v1", {
        rootID,
        principal,
        input,
      }),
      targetRef,
    })
    receipt = admitted.receipt
    if (!admitted.fresh) {
      if (receipt.state === "committed") {
        return {
          title: `Memory ${input.action}`,
          output: `OFXP memory invocation ${receipt.invocationID} was already committed; no duplicate memory mutation was executed.`,
          metadata: { action: input.action, duplicate: true, receipt },
          grantRevision,
        } satisfies Result
      }
      if (receipt.state === "started") {
        return yield* new ExchangeError.AmbiguousCommit({
          detail: `OFXP memory invocation ${receipt.invocationID} crossed its mutation boundary; inspect memory state before retrying`,
          targetRef,
        })
      }
      if (receipt.state === "cancelled") {
        return yield* new ExchangeError.Cancelled({
          detail: `OFXP memory invocation ${receipt.invocationID} was already cancelled`,
        })
      }
      if (receipt.state === "failed") {
        return yield* new ExchangeError.Conflict({
          detail: `OFXP memory invocation ${receipt.invocationID} already failed; use a new InvocationID`,
        })
      }
    }
  }

  const execution = yield* ExchangeMemory.executeRuntime(input, {
    rootPath: root.rootPath,
    signal,
    ...(readOnly
      ? {}
      : {
          beforeMutation: () =>
            Effect.gen(function* () {
              yield* revalidate()
              if (started) return
              receipt = yield* deps.invocations.prepare({
                invocationID: call.context.invocationID,
                targetRef,
              })
              started = true
            }).pipe(Effect.mapError(mutationBoundaryError)),
        }),
  }).pipe(
    Effect.catch((error) => {
      if (readOnly || !receipt) return Effect.fail(error)
      if (started || error instanceof ExchangeError.AmbiguousCommit) {
        return Effect.fail(
          error instanceof ExchangeError.AmbiguousCommit
            ? error
            : new ExchangeError.AmbiguousCommit({
                detail: `OFXP memory invocation ${call.context.invocationID} may have mutated durable memory; inspect it before retrying`,
                targetRef,
              }),
        )
      }
      return deps.invocations
        .settle({
          invocationID: call.context.invocationID,
          state: error instanceof ExchangeError.Cancelled ? "cancelled" : "failed",
          targetRef,
        })
        .pipe(Effect.catch(() => Effect.void), Effect.andThen(Effect.fail(error)))
    }),
  )

  yield* revalidate()

  if (!readOnly && receipt) {
    const resultDigest = ExchangeRequestDigest.sha256("ofxp:memory-result:v1", {
      title: execution.title,
      output: execution.output,
      metadata: execution.metadata,
      structured: execution.structured,
    })
    const settled = yield* deps.invocations
      .settle({
        invocationID: call.context.invocationID,
        state: "committed",
        targetRef,
        resultDigest,
      })
      .pipe(
        Effect.mapError(
          () =>
            new ExchangeError.AmbiguousCommit({
              detail: `OFXP memory mutation completed, but its durable receipt could not be settled; reconcile InvocationID ${call.context.invocationID} before retrying`,
              targetRef,
            }),
        ),
      )
    return {
      title: execution.title,
      output: execution.output,
      metadata: {
        ...execution.metadata,
        invocationID: call.context.invocationID,
        receipt: settled,
        resultDigest,
      },
      grantRevision,
    } satisfies Result
  }

  return {
    title: execution.title,
    output: execution.output,
    metadata: execution.metadata,
    grantRevision,
  } satisfies Result
})

