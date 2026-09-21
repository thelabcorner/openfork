export * as OfxpSkillCapability from "./skill"

import { Effect, Schema } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeSkill } from "@/exchange/skill"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpRoot } from "../root"

export const Parameters = ExchangeSkill.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly fs: FSUtil.Interface
}

export interface Result extends ExchangeSkill.Result {
  readonly grantRevision: number
}

export const execute = Effect.fn("OfxpSkillCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  const args = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP skill arguments are invalid" }),
  })
  const admission = yield* deps.peers.authorize({ peerID: peer.peerID, capability: "read", rootID: call.rootID })
  const root = yield* deps.roots.resolve(admission)

  const revalidate = Effect.fn("OfxpSkillCapability.revalidate")(function* () {
    const fresh = yield* deps.peers.authorize({
      peerID: peer.peerID,
      capability: "read",
      rootID: call.rootID,
      expectedGrantRevision: admission.grantRevision,
    })
    yield* deps.roots.verify(fresh)
  })

  const result = yield* ExchangeSkill.execute(deps.fs, args, {
    rootPath: root.rootPath,
    signal,
    resolvePath: (value) =>
      Effect.gen(function* () {
        const fresh = yield* deps.peers.authorize({
          peerID: peer.peerID,
          capability: "read",
          rootID: call.rootID,
          expectedGrantRevision: admission.grantRevision,
        })
        const resolved = yield* deps.roots.resolve(fresh, value)
        return { path: resolved.path, virtualPath: resolved.virtualPath }
      }).pipe(
        Effect.mapError((error) =>
          error instanceof ExchangeError.InvalidArgument || error instanceof ExchangeError.Cancelled
            ? error
            : new ExchangeError.AuthorityDenied({ detail: error instanceof Error ? error.message : "OFXP skill path authorization failed" }),
        ),
      ),
    toVirtualPath: (absolutePath) => OfxpRoot.toVirtualPath(root, absolutePath),
    revalidate: () => revalidate().pipe(
      Effect.mapError((error) => new ExchangeError.AuthorityDenied({ detail: error instanceof Error ? error.message : "OFXP skill authority changed" })),
    ),
  })
  yield* revalidate()
  return { ...result, grantRevision: admission.grantRevision } satisfies Result
})

