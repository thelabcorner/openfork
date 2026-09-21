export * as OfxpLspCapability from "./lsp"

import { Effect, Schema } from "effect"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeLsp } from "@/exchange/lsp"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpRoot } from "../root"

export const Parameters = ExchangeLsp.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
}

export interface Result extends ExchangeLsp.Result {
  readonly grantRevision: number
}

export const execute = Effect.fn("OfxpLspCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  const args = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP LSP arguments are invalid" }),
  })
  const admission = yield* deps.peers.authorize({ peerID: peer.peerID, capability: "read", rootID: call.rootID })
  const root = yield* deps.roots.resolve(admission)
  const target = yield* deps.roots.resolve(admission, args.filePath)

  const revalidate = Effect.fn("OfxpLspCapability.revalidate")(function* () {
    const fresh = yield* deps.peers.authorize({
      peerID: peer.peerID,
      capability: "read",
      rootID: call.rootID,
      expectedGrantRevision: admission.grantRevision,
    })
    yield* deps.roots.verify(fresh)
  })

  const result = yield* ExchangeLsp.execute(args, {
    rootPath: root.rootPath,
    filePath: target.path,
    virtualPath: target.virtualPath,
    signal,
    toVirtualPath: (absolutePath) => OfxpRoot.toVirtualPath(root, absolutePath),
    revalidate: () =>
      revalidate().pipe(
        Effect.mapError((error) =>
          new ExchangeError.AuthorityDenied({
            detail: error instanceof Error ? error.message : "OFXP LSP authority changed",
          }),
        ),
      ),
  })
  yield* revalidate()
  return { ...result, grantRevision: admission.grantRevision } satisfies Result
})

