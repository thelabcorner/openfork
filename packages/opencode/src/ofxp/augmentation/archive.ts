export * as OfxpArchiveCapability from "./archive"

import path from "node:path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeArchive } from "@/exchange/archive"
import { ExchangeError } from "@/exchange/error"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import { ArchiveSystem } from "@/tool/archive/system"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpPrincipal } from "../principal"
import { OfxpRoot } from "../root"
import { OfxpProcessCapability } from "./process"

export const Parameters = ExchangeArchive.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly invocations: OfxpInvocation.Interface
  readonly process: OfxpProcessCapability.Interface
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
    throw new ExchangeError.PathEscape({ detail: "Archive path escapes the approved OFXP root" })
  }
  return relative === "" ? undefined : relative.split(path.sep).join("/")
}

export const execute = Effect.fn("OfxpArchiveCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  if (!call.rootID) return yield* new ExchangeError.InvalidArgument({ detail: "OFXP archive requires an approved root" })
  const rootID = call.rootID
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP archive arguments are invalid" }),
  })
  const action = input.action
  const mutating = action === "create" || action === "extract"
  const primaryAuthority: Ofxp.CapabilityClass = mutating ? "write" : "read"
  const admission = yield* deps.peers.authorize({
    peerID: peer.peerID,
    capability: primaryAuthority,
    rootID,
  })
  const root = yield* deps.roots.verify(admission)
  const principal = OfxpPrincipal.key(peer.peerID, call.context)

  const authorize = (capability: Ofxp.CapabilityClass) =>
    deps.peers.authorize({
      peerID: peer.peerID,
      capability,
      rootID,
      expectedGrantRevision: admission.grantRevision,
    })

  const resolve = (
    capability: "read" | "write",
    inputPath: string,
    allowMissing = false,
  ): Effect.Effect<ExchangeArchive.ApprovedPath, unknown> =>
    Effect.gen(function* () {
      const fresh = yield* authorize(capability)
      const resolved = yield* deps.roots.resolve(fresh, inputPath, { allowMissing })
      return {
        native: resolved.path,
        virtual: resolved.virtualPath,
        rootPath: resolved.rootPath,
      } satisfies ExchangeArchive.ApprovedPath
    })

  const revalidateTarget = (
    capability: "read" | "write",
    absolutePath: string,
    allowMissing: boolean,
  ) =>
    Effect.gen(function* () {
      const relative = yield* Effect.try({
        try: () => relativeInside(root.rootPath, absolutePath),
        catch: (error) =>
          error instanceof ExchangeError.PathEscape
            ? error
            : new ExchangeError.PathEscape({ detail: "Archive path escapes the approved OFXP root" }),
      })
      const fresh = yield* authorize(capability)
      const resolved = yield* deps.roots.resolve(fresh, relative, { allowMissing })
      if (FSUtil.normalizePath(resolved.path) !== FSUtil.normalizePath(absolutePath)) {
        return yield* new OfxpRoot.RootChangedError({ detail: "OFXP archive target identity changed before use" })
      }
    })

  let receipt: Ofxp.InvocationReceipt | undefined
  let started = false
  if (mutating) {
    const admitted = yield* deps.invocations.admit({
      invocationID: call.context.invocationID,
      sourcePeerID: peer.peerID,
      operation: `archive.${action}`,
      commitClass: "non_idempotent_mutation",
      requestDigest: ExchangeRequestDigest.sha256("ofxp:archive:v1", {
        rootID,
        principal,
        input,
      }),
    })
    receipt = admitted.receipt
    if (!admitted.fresh) {
      if (receipt.state === "committed") {
        return {
          title: receipt.targetRef ?? root.virtualPath,
          output: `OFXP archive invocation ${receipt.invocationID} was already committed; no duplicate archive mutation was executed.`,
          metadata: { action, duplicate: true, receipt },
          grantRevision: admission.grantRevision,
        } satisfies Result
      }
      if (receipt.state === "started") {
        return yield* new ExchangeError.AmbiguousCommit({
          detail: `OFXP archive invocation ${receipt.invocationID} crossed its mutation boundary; inspect the destination before retrying`,
          targetRef: receipt.targetRef ?? root.virtualPath,
        })
      }
      if (receipt.state === "cancelled") {
        return yield* new ExchangeError.Cancelled({
          detail: `OFXP archive invocation ${receipt.invocationID} was already cancelled`,
        })
      }
      if (receipt.state === "failed") {
        return yield* new ExchangeError.Conflict({
          detail: `OFXP archive invocation ${receipt.invocationID} already failed; use a new InvocationID`,
        })
      }
    }
  }

  const prepareMutation = (destination: ExchangeArchive.ApprovedPath, target?: string) =>
    Effect.gen(function* () {
      yield* revalidateTarget("write", target ?? destination.native, true)
      if (started) return
      receipt = yield* deps.invocations.prepare({
        invocationID: call.context.invocationID,
        targetRef: destination.virtual,
      })
      started = true
    })

  const runSystem = (
    tool: string,
    args: readonly string[],
    runSignal?: AbortSignal,
  ): Effect.Effect<ArchiveSystem.RunResult, unknown> =>
    Effect.gen(function* () {
      const run = yield* deps.process.runArgv(
        peer,
        call.context,
        {
          rootID,
          argv: [tool, ...args],
          title: `archive system backend: ${path.basename(tool)}`,
          operation: "archive.system",
          timeoutMs: 120_000,
          outputCapBytes: ExchangeArchive.SYSTEM_OUTPUT_CAP,
          expectedGrantRevision: admission.grantRevision,
        },
        runSignal ?? signal,
      )
      if (run.timedOut) {
        return yield* new ExchangeError.Conflict({
          detail: "Archive system backend exceeded the 120 second execution bound",
        })
      }
      if (run.truncated) {
        return yield* new ExchangeError.InvalidArgument({
          detail: "Archive system backend output exceeded the bounded capture limit",
        })
      }
      return {
        code: run.exitCode ?? 1,
        stdout: new TextEncoder().encode(run.stdout),
        stderr: run.stderr,
      } satisfies ArchiveSystem.RunResult
    })

  const execution = yield* ExchangeArchive.execute<unknown>(
    deps.fs,
    input,
    {
      resolveRead: (inputPath) => resolve("read", inputPath),
      resolveWrite: (inputPath, allowMissing) => resolve("write", inputPath, allowMissing),
      runSystem,
      beforeCreateCommit: (destination) => prepareMutation(destination),
      beforeExtractMutation: (destination, target) => prepareMutation(destination, target),
    },
    signal,
  ).pipe(
    Effect.catch((error) => {
      if (!mutating || !receipt) return Effect.fail(error)
      if (started || error instanceof ExchangeError.AmbiguousCommit) {
        return Effect.fail(
          error instanceof ExchangeError.AmbiguousCommit
            ? error
            : new ExchangeError.AmbiguousCommit({
                detail: `OFXP archive invocation ${call.context.invocationID} may have changed the destination; inspect it before retrying`,
                targetRef: receipt.targetRef ?? root.virtualPath,
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

  const fresh = yield* authorize(primaryAuthority)
  yield* deps.roots.verify(fresh)

  if (mutating && receipt) {
    const resultDigest = ExchangeRequestDigest.sha256("ofxp:archive-result:v1", {
      title: execution.title,
      output: execution.output,
      metadata: execution.metadata,
    })
    const settled = yield* deps.invocations
      .settle({
        invocationID: call.context.invocationID,
        state: "committed",
        targetRef: execution.targetRef ?? receipt.targetRef ?? root.virtualPath,
        resultDigest,
      })
      .pipe(
        Effect.mapError(
          () =>
            new ExchangeError.AmbiguousCommit({
              detail: `OFXP archive mutation completed, but its durable receipt could not be settled; reconcile InvocationID ${call.context.invocationID} before retrying`,
              targetRef: execution.targetRef ?? receipt?.targetRef ?? root.virtualPath,
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
      grantRevision: admission.grantRevision,
    } satisfies Result
  }

  return {
    title: execution.title,
    output: execution.output,
    metadata: execution.metadata,
    grantRevision: admission.grantRevision,
  } satisfies Result
})

