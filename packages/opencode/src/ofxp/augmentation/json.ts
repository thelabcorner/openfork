export * as OfxpJsonCapability from "./json"

import path from "node:path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeGrounding } from "@/exchange/grounding"
import { ExchangeJson } from "@/exchange/json"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpPrincipal } from "../principal"
import { OfxpRoot } from "../root"

export const Parameters = ExchangeJson.Parameters

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

function relativeInside(rootPath: string, absolutePath: string) {
  const relative = path.relative(rootPath, absolutePath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ExchangeError.PathEscape({ detail: "JSON path escapes the approved OFXP root" })
  }
  return relative === "" ? undefined : relative.split(path.sep).join("/")
}

export const execute = Effect.fn("OfxpJsonCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP JSON arguments are invalid" }),
  })
  const mode = input.mode ?? "scaffold"
  const primaryUsesFile = input.jsonText === undefined && input.filePath !== undefined
  const compareUsesFile = mode === "diff" && input.compareJsonText === undefined && input.compareFilePath !== undefined
  const wantsWrite = primaryUsesFile && (mode === "format" || mode === "patch") && input.dryRun === false
  const usesFile = primaryUsesFile || compareUsesFile
  const principal = OfxpPrincipal.key(peer.peerID, call.context)
  const scopedGrounding = deps.grounding.scoped(principal)

  let grantRevision: number
  let root: OfxpRoot.Resolved | undefined
  if (usesFile) {
    const capability: Ofxp.CapabilityClass = wantsWrite ? "write" : "read"
    const admission = yield* deps.peers.authorize({
      peerID: peer.peerID,
      capability,
      rootID: call.rootID,
    })
    grantRevision = admission.grantRevision
    root = yield* deps.roots.verify(admission)
  } else {
    const access = yield* deps.peers.access(peer.peerID)
    if (!access.grant.read && !access.grant.write) {
      return yield* new ExchangeError.AuthorityDenied({
        detail: "OFXP JSON inline analysis requires read or write authority",
      })
    }
    grantRevision = access.info.grantRevision
  }

  const authorize = (capability: "read" | "write") =>
    deps.peers.authorize({
      peerID: peer.peerID,
      capability,
      rootID: call.rootID,
      expectedGrantRevision: grantRevision,
    })

  const resolve = (capability: "read" | "write", inputPath: string) =>
    Effect.gen(function* () {
      const fresh = yield* authorize(capability)
      const resolved = yield* deps.roots.resolve(fresh, inputPath)
      return {
        native: resolved.path,
        virtual: resolved.virtualPath,
        rootID: resolved.rootID,
      } satisfies ExchangeJson.ApprovedPath
    })

  const revalidate = (capability: "read" | "write", target: ExchangeJson.ApprovedPath) =>
    Effect.gen(function* () {
      if (!root) {
        return yield* new ExchangeError.InvalidArgument({
          detail: "File-backed OFXP JSON operation lost its approved root",
        })
      }
      const relative = yield* Effect.try({
        try: () => relativeInside(root!.rootPath, target.native),
        catch: (error) =>
          error instanceof ExchangeError.PathEscape
            ? error
            : new ExchangeError.PathEscape({ detail: "JSON path escapes the approved OFXP root" }),
      })
      const fresh = yield* authorize(capability)
      const resolved = yield* deps.roots.resolve(fresh, relative)
      if (FSUtil.normalizePath(resolved.path) !== FSUtil.normalizePath(target.native)) {
        return yield* new OfxpRoot.RootChangedError({ detail: "OFXP JSON target identity changed before use" })
      }
    })

  let receipt: Ofxp.InvocationReceipt | undefined
  let started = false
  if (wantsWrite) {
    const admitted = yield* deps.invocations.admit({
      invocationID: call.context.invocationID,
      sourcePeerID: peer.peerID,
      operation: `json.${mode}`,
      commitClass: "non_idempotent_mutation",
      requestDigest: ExchangeRequestDigest.sha256("ofxp:json:v1", {
        rootID: call.rootID ?? null,
        principal,
        input,
      }),
    })
    receipt = admitted.receipt
    if (!admitted.fresh) {
      if (receipt.state === "committed") {
        return {
          title: receipt.targetRef ?? "json",
          output: `OFXP JSON invocation ${receipt.invocationID} was already committed; no duplicate JSON mutation was executed.`,
          metadata: { mode, duplicate: true, receipt },
          grantRevision,
        } satisfies Result
      }
      if (receipt.state === "started") {
        return yield* new ExchangeError.AmbiguousCommit({
          detail: `OFXP JSON invocation ${receipt.invocationID} crossed its write boundary; inspect the file before retrying`,
          targetRef: receipt.targetRef,
        })
      }
      if (receipt.state === "cancelled") {
        return yield* new ExchangeError.Cancelled({
          detail: `OFXP JSON invocation ${receipt.invocationID} was already cancelled`,
        })
      }
      if (receipt.state === "failed") {
        return yield* new ExchangeError.Conflict({
          detail: `OFXP JSON invocation ${receipt.invocationID} already failed; use a new InvocationID`,
        })
      }
    }
  }

  const execution = yield* ExchangeJson.execute<unknown>(
    deps.fs,
    input,
    {
      resolveRead: (inputPath) => resolve("read", inputPath),
      resolveWrite: (inputPath) => resolve("write", inputPath),
      revalidateRead: (target) => revalidate("read", target),
      revalidateWrite: (target) => revalidate("write", target),
      beforeWriteMutation: (target) =>
        Effect.gen(function* () {
          if (!wantsWrite || started) return
          receipt = yield* deps.invocations.prepare({
            invocationID: call.context.invocationID,
            targetRef: target.virtual,
          })
          started = true
        }),
      grounding: scopedGrounding,
    },
    signal,
  ).pipe(
    Effect.catch((error) => {
      if (!wantsWrite || !receipt) return Effect.fail(error)
      if (started || error instanceof ExchangeError.AmbiguousCommit) {
        return Effect.fail(
          error instanceof ExchangeError.AmbiguousCommit
            ? error
            : new ExchangeError.AmbiguousCommit({
                detail: `OFXP JSON invocation ${call.context.invocationID} may have changed the file; inspect it before retrying`,
                targetRef: receipt.targetRef,
              }),
        )
      }
      return deps.invocations
        .settle({
          invocationID: call.context.invocationID,
          state: error instanceof ExchangeError.Cancelled ? "cancelled" : "failed",
        })
        .pipe(Effect.catch(() => Effect.void), Effect.andThen(Effect.fail(error)))
    }),
  )

  if (!usesFile) {
    const fresh = yield* deps.peers.access(peer.peerID)
    if (fresh.info.grantRevision !== grantRevision) {
      return yield* new OfxpPeer.OfxpPeerSchema.StaleRevisionError({
        peerID: peer.peerID,
        expectedRevision: grantRevision,
        actualRevision: fresh.info.grantRevision,
      })
    }
  }

  if (wantsWrite && receipt) {
    const resultDigest = ExchangeRequestDigest.sha256("ofxp:json-result:v1", {
      title: execution.title,
      output: execution.output,
      metadata: execution.metadata,
    })
    const settled = yield* deps.invocations
      .settle({
        invocationID: call.context.invocationID,
        state: "committed",
        targetRef: execution.targetRef ?? receipt.targetRef,
        resultDigest,
      })
      .pipe(
        Effect.mapError(
          () =>
            new ExchangeError.AmbiguousCommit({
              detail: `OFXP JSON operation completed, but its durable receipt could not be settled; reconcile InvocationID ${call.context.invocationID} before retrying`,
              targetRef: execution.targetRef ?? receipt?.targetRef,
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

