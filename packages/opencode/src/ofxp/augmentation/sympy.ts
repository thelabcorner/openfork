export * as OfxpSympyCapability from "./sympy"

import { Effect, Schema } from "effect"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeSympy } from "@/exchange/sympy"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpRoot } from "../root"
import { OfxpProcessCapability } from "./process"

export const Parameters = ExchangeSympy.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly process: OfxpProcessCapability.Interface
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly grantRevision: number
}

export const execute = Effect.fn("OfxpSympyCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  if (!call.rootID) return yield* new ExchangeError.InvalidArgument({ detail: "OFXP SymPy requires an approved root" })
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP SymPy arguments are invalid" }),
  })
  const admission = yield* deps.peers.authorize({ peerID: peer.peerID, capability: "process", rootID: call.rootID })
  yield* deps.roots.verify(admission)

  const result = yield* ExchangeSympy.execute<unknown>(
    input,
    {
      run: (request) =>
        deps.process.runArgv(
          peer,
          call.context,
          {
            rootID: call.rootID!,
            argv: request.argv,
            workdir: request.workdir,
            env: request.env,
            title: request.title,
            operation: request.operation,
            timeoutMs: request.timeoutMs,
            outputCapBytes: request.outputCapBytes,
            expectedGrantRevision: admission.grantRevision,
          },
          request.signal ?? signal,
        ),
      isCandidateUnavailable: (error) => error instanceof ExchangeError.DependencyUnavailable,
    },
    signal,
  )

  const fresh = yield* deps.peers.authorize({
    peerID: peer.peerID,
    capability: "process",
    rootID: call.rootID,
    expectedGrantRevision: admission.grantRevision,
  })
  yield* deps.roots.verify(fresh)
  return {
    title: result.title,
    output: result.output,
    metadata: result.metadata,
    grantRevision: admission.grantRevision,
  } satisfies Result
})

