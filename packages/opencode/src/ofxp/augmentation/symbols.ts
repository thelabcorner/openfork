export * as OfxpSymbolsCapability from "./symbols"

import { Effect, Schema } from "effect"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { Symbols } from "@/symbols/service"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpRoot } from "../root"

export const Parameters = Symbols.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly symbols: Symbols.Interface
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly grantRevision: number
}

function projectRoot(text: string, root: OfxpRoot.Resolved) {
  return text.split(root.rootPath).join(`/${root.alias}`)
}

function projectValue(value: unknown, root: OfxpRoot.Resolved, depth = 0): unknown {
  if (depth > 12) return "[metadata-depth-redacted]"
  if (typeof value === "string") return projectRoot(value, root)
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => projectValue(item, root, depth + 1))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 256)
      .map(([key, item]) => [key, projectValue(item, root, depth + 1)]),
  )
}

export const execute = Effect.fn("OfxpSymbolsCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return yield* new ExchangeError.Cancelled({ detail: "OFXP symbols request was cancelled" })
  const args = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP symbols arguments are invalid" }),
  })
  const admission = yield* deps.peers.authorize({ peerID: peer.peerID, capability: "read", rootID: call.rootID })
  const root = yield* deps.roots.resolve(admission)

  const scopedPath = args.path ? yield* deps.roots.resolve(admission, args.path) : undefined
  const scopedFile = args.file ? yield* deps.roots.resolve(admission, args.file) : undefined
  const input: Symbols.Input = {
    ...args,
    ...(scopedPath ? { path: scopedPath.path } : {}),
    ...(scopedFile ? { file: scopedFile.path } : {}),
  }

  const result = yield* deps.symbols.execute(input, {
    directory: root.rootPath,
    worktree: root.rootPath,
    abort: signal,
    // Deliberately omit writeOverflow: an OFXP read must never create a host-
    // local recovery artifact outside the approved root.
  }).pipe(
    Effect.mapError((error) => {
      if (error._tag === "SymbolsInvalidInput") {
        return new ExchangeError.InvalidArgument({ detail: projectRoot(error.detail, root) })
      }
      if (error._tag === "Ripgrep.Error" && error.cause instanceof Error && error.cause.name === "AbortError") {
        return new ExchangeError.Cancelled({ detail: "OFXP symbols request was cancelled" })
      }
      return new ExchangeError.DependencyUnavailable({ detail: "OFXP symbol analysis is unavailable" })
    }),
  )

  const fresh = yield* deps.peers.authorize({
    peerID: peer.peerID,
    capability: "read",
    rootID: call.rootID,
    expectedGrantRevision: admission.grantRevision,
  })
  yield* deps.roots.verify(fresh)
  return {
    title: projectRoot(result.title, root),
    output: projectRoot(result.output, root),
    metadata: projectValue(result.metadata, root) as Readonly<Record<string, unknown>>,
    grantRevision: admission.grantRevision,
  } satisfies Result
})

