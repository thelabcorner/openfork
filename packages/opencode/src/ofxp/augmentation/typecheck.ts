export * as OfxpTypecheckCapability from "./typecheck"

import path from "node:path"
import { Effect, Schema } from "effect"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeTypecheck } from "@/exchange/typecheck"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpRoot } from "../root"
import { OfxpProcessCapability } from "./process"

export const Parameters = Schema.Struct({
  workdir: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  ...ExchangeTypecheck.Parameters.fields,
})

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

function relativeInside(rootPath: string, absolutePath: string) {
  const relative = path.relative(rootPath, absolutePath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ExchangeError.PathEscape({ detail: "Typecheck path escapes the approved OFXP root" })
  }
  return relative === "" ? undefined : relative.split(path.sep).join("/")
}

export const execute = Effect.fn("OfxpTypecheckCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  if (!call.rootID) return yield* new ExchangeError.InvalidArgument({ detail: "OFXP typecheck requires an approved root" })
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP typecheck arguments are invalid" }),
  })
  const mode = ExchangeTypecheck.resolveMode(input)
  const authority: Ofxp.CapabilityClass = mode === "explain" ? "read" : "process"
  const admission = yield* deps.peers.authorize({ peerID: peer.peerID, capability: authority, rootID: call.rootID })
  const root = yield* deps.roots.verify(admission)
  const directory = input.workdir ? (yield* deps.roots.resolve(admission, input.workdir)).path : root.rootPath

  const reauthorize = () =>
    deps.peers.authorize({
      peerID: peer.peerID,
      capability: authority,
      rootID: call.rootID,
      expectedGrantRevision: admission.grantRevision,
    })

  const result = yield* ExchangeTypecheck.execute<unknown>(
    input,
    {
      rootPath: root.rootPath,
      directory,
      authorizePath: (absolutePath) =>
        Effect.gen(function* () {
          const relative = yield* Effect.try({
            try: () => relativeInside(root.rootPath, absolutePath),
            catch: (error) =>
              error instanceof ExchangeError.PathEscape
                ? error
                : new ExchangeError.PathEscape({ detail: "Typecheck path escapes the approved OFXP root" }),
          })
          const fresh = yield* reauthorize()
          return (yield* deps.roots.resolve(fresh, relative)).path
        }),
      toVirtualPath: (absolutePath) => OfxpRoot.toVirtualPath(root, absolutePath),
      run: (request) =>
        Effect.gen(function* () {
          const workdir = yield* Effect.try({
            try: () => relativeInside(root.rootPath, request.cwd),
            catch: (error) =>
              error instanceof ExchangeError.PathEscape
                ? error
                : new ExchangeError.PathEscape({ detail: "Typecheck subprocess workdir escapes the approved OFXP root" }),
          })
          return yield* deps.process.runArgv(
            peer,
            call.context,
            {
              rootID: call.rootID!,
              workdir,
              argv: request.argv,
              env: request.env,
              title: request.title,
              operation: request.operation,
              timeoutMs: request.timeoutMs,
              outputCapBytes: request.outputCapBytes,
              expectedGrantRevision: admission.grantRevision,
            },
            request.signal ?? signal,
          )
        }),
      revalidate: () =>
        reauthorize().pipe(
          Effect.flatMap((fresh) => deps.roots.verify(fresh)),
          Effect.asVoid,
        ),
    },
    signal,
  )

  return {
    title: result.title,
    output: result.output,
    metadata: result.metadata,
    grantRevision: admission.grantRevision,
  } satisfies Result
})

