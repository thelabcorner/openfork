export * as OfxpBrowserCapability from "./browser"

import { Effect, Schema } from "effect"
import { BrowserHostBroker } from "@opencode-ai/core/browser/host-broker"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeBrowser } from "@/exchange/browser"
import { ExchangeError } from "@/exchange/error"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpPrincipal } from "../principal"
import { OfxpRoot } from "../root"

export const Parameters = ExchangeBrowser.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly invocations: OfxpInvocation.Interface
  readonly broker: BrowserHostBroker.Interface
}

export interface Result extends ExchangeBrowser.Result {
  readonly grantRevision: number
}

export const execute = Effect.fn("OfxpBrowserCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP browser arguments are invalid" }),
  })
  const operation = input.operation
  const visualRoot = ExchangeBrowser.requiresRoot(operation)
  if (visualRoot && !call.rootID) {
    return yield* new ExchangeError.InvalidArgument({ detail: `browser.${operation} requires an approved root` })
  }

  const admission = yield* deps.peers.authorize({
    peerID: peer.peerID,
    capability: "browser",
    ...(visualRoot ? { rootID: call.rootID, requireRoot: true } : {}),
  })
  const resolved = visualRoot ? yield* deps.roots.resolve(admission) : undefined
  const principal = OfxpPrincipal.key(peer.peerID, call.context)

  const revalidate = Effect.fn("OfxpBrowserCapability.revalidate")(function* () {
    const fresh = yield* deps.peers.authorize({
      peerID: peer.peerID,
      capability: "browser",
      expectedGrantRevision: admission.grantRevision,
      ...(visualRoot ? { rootID: call.rootID, requireRoot: true } : {}),
    })
    if (visualRoot) yield* deps.roots.verify(fresh)
  })

  const context: ExchangeBrowser.Context = {
    principalId: principal,
    broker: deps.broker,
    signal,
    ...(resolved
      ? {
          project: {
            rootPath: resolved.rootPath,
            toVirtualPath: (absolutePath: string) => OfxpRoot.toVirtualPath(resolved, absolutePath),
          },
        }
      : {}),
    revalidate: () =>
      revalidate().pipe(
        Effect.mapError((error) =>
          new ExchangeError.AuthorityDenied({
            detail: error instanceof Error ? error.message : "OFXP browser authority changed",
          }),
        ),
      ),
  }

  if (!ExchangeBrowser.isMutating(operation)) {
    const result = yield* ExchangeBrowser.execute(input, context)
    return { ...result, grantRevision: admission.grantRevision } satisfies Result
  }

  const targetRef = resolved?.virtualPath ?? `browser:${principal}`
  const admitted = yield* deps.invocations.admit({
    invocationID: call.context.invocationID,
    sourcePeerID: peer.peerID,
    operation: `browser.${operation}`,
    commitClass: "non_idempotent_mutation",
    requestDigest: ExchangeRequestDigest.sha256("ofxp:browser:v1", {
      rootID: call.rootID ?? null,
      operation,
      args: input.args,
      principal,
    }),
    targetRef,
  })

  if (!admitted.fresh) {
    const receipt = admitted.receipt
    if (receipt.state === "committed") {
      return {
        title: `Browser ${operation}`,
        output: `OFXP browser invocation ${receipt.invocationID} was already committed; no duplicate browser mutation was executed.`,
        metadata: { operation, duplicate: true, receipt },
        mutation: { attempted: true, committed: true },
        grantRevision: admission.grantRevision,
      } satisfies Result
    }
    if (receipt.state === "started") {
      return yield* new ExchangeError.AmbiguousCommit({
        detail: `OFXP browser invocation ${receipt.invocationID} crossed its dispatch boundary; inspect browser state before issuing another mutation`,
        targetRef,
      })
    }
    if (receipt.state === "cancelled") {
      return yield* new ExchangeError.Cancelled({ detail: `OFXP browser invocation ${receipt.invocationID} was already cancelled` })
    }
    if (receipt.state === "failed") {
      return yield* new ExchangeError.Conflict({
        detail: `OFXP browser invocation ${receipt.invocationID} already failed; inspect browser state before using a new InvocationID`,
      })
    }
  }

  yield* revalidate()
  yield* deps.invocations.prepare({ invocationID: call.context.invocationID, targetRef })

  const result = yield* ExchangeBrowser.execute(input, context).pipe(
    Effect.mapError(
      () =>
        new ExchangeError.AmbiguousCommit({
          detail: `OFXP browser invocation ${call.context.invocationID} may have changed browser state; inspect its receipt/browser state before retrying`,
          targetRef,
        }),
    ),
  )

  const receipt = yield* deps.invocations
    .settle({ invocationID: call.context.invocationID, state: "committed", targetRef })
    .pipe(
      Effect.mapError(
        () =>
          new ExchangeError.AmbiguousCommit({
            detail: `OFXP browser mutation completed but its durable receipt could not be settled; reconcile InvocationID ${call.context.invocationID} before retrying`,
            targetRef,
          }),
      ),
    )
  return {
    ...result,
    metadata: { ...result.metadata, invocationID: call.context.invocationID, receipt },
    grantRevision: admission.grantRevision,
  } satisfies Result
})

