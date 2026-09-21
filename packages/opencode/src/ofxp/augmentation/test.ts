export * as OfxpTestCapability from "./test"

import path from "node:path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import { ExchangeTest } from "@/exchange/test"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpPrincipal } from "../principal"
import { OfxpRoot } from "../root"
import { OfxpProcessCapability } from "./process"

export const Parameters = Schema.Struct({
  workdir: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  ...ExchangeTest.Parameters.fields,
})

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly invocations: OfxpInvocation.Interface
  readonly process: OfxpProcessCapability.Interface
  readonly fs: FSUtil.Interface
  readonly rg: Ripgrep.Interface
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
    throw new ExchangeError.PathEscape({ detail: "Test path escapes the approved OFXP root" })
  }
  return relative === "" ? undefined : relative.split(path.sep).join("/")
}

export const execute = Effect.fn("OfxpTestCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  if (!call.rootID) return yield* new ExchangeError.InvalidArgument({ detail: "OFXP test requires an approved root" })
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP test arguments are invalid" }),
  })
  const action = input.action ?? "run"
  const authority: Ofxp.CapabilityClass = action === "list" ? "read" : "process"
  const admission = yield* deps.peers.authorize({ peerID: peer.peerID, capability: authority, rootID: call.rootID })
  const root = yield* deps.roots.verify(admission)
  const selected = input.workdir ? yield* deps.roots.resolve(admission, input.workdir) : root
  const rootWorkdir = relativeInside(root.rootPath, selected.path) ?? "."
  const workspace: ExchangeTest.Workspace = {
    rootPath: root.rootPath,
    directory: selected.path,
    rootWorkdir,
    virtualDirectory: selected.virtualPath,
    alias: root.alias,
  }

  const reauthorize = () =>
    deps.peers.authorize({
      peerID: peer.peerID,
      capability: authority,
      rootID: call.rootID,
      expectedGrantRevision: admission.grantRevision,
    })

  const ownerKey = OfxpPrincipal.key(peer.peerID, call.context)
  const targetRef = input.path ? `${selected.virtualPath}/${input.path}`.replaceAll("//", "/") : selected.virtualPath
  let receipt: Ofxp.InvocationReceipt | undefined
  let prepared = false

  if (action === "run") {
    const requestDigest = ExchangeRequestDigest.sha256("ofxp:test-run:v1", {
      rootID: call.rootID,
      ownerKey,
      workdir: rootWorkdir,
      path: input.path ?? null,
      testNamePattern: input.testNamePattern ?? null,
      runtime: input.runtime ?? "auto",
      timeoutMs: Math.min(Math.max(input.timeoutMs ?? 120_000, 100), 600_000),
      full: input.full === true,
    })
    const admitted = yield* deps.invocations.admit({
      invocationID: call.context.invocationID,
      sourcePeerID: peer.peerID,
      operation: "test.run",
      commitClass: "non_idempotent_mutation",
      requestDigest,
      targetRef,
    })
    receipt = admitted.receipt
    if (!admitted.fresh) {
      if (receipt.state === "committed") {
        return {
          title: "test run",
          output: `OFXP test invocation ${receipt.invocationID} was already committed; no duplicate test process was launched.`,
          metadata: { action: "run", duplicate: true, receipt, workdir: rootWorkdir },
          grantRevision: admission.grantRevision,
        } satisfies Result
      }
      if (receipt.state === "started") {
        return yield* new ExchangeError.AmbiguousCommit({
          detail: `OFXP test invocation ${receipt.invocationID} crossed its process-start boundary; do not replay it blindly`,
          targetRef,
        })
      }
      if (receipt.state === "cancelled") {
        return yield* new ExchangeError.Cancelled({ detail: `OFXP test invocation ${receipt.invocationID} was already cancelled` })
      }
      if (receipt.state === "failed") {
        return yield* new ExchangeError.Conflict({ detail: `OFXP test invocation ${receipt.invocationID} already failed; use a new InvocationID` })
      }
    }
  }

  const result = yield* ExchangeTest.execute<unknown>(
    { fs: deps.fs, rg: deps.rg },
    workspace,
    input,
    {
      authorizePath: (absolutePath) =>
        Effect.gen(function* () {
          const relative = yield* Effect.try({
            try: () => relativeInside(root.rootPath, absolutePath),
            catch: (error) =>
              error instanceof ExchangeError.PathEscape
                ? error
                : new ExchangeError.PathEscape({ detail: "Test path escapes the approved OFXP root" }),
          })
          const fresh = yield* reauthorize()
          return (yield* deps.roots.resolve(fresh, relative)).path
        }),
      run: (request) =>
        Effect.gen(function* () {
          const workdir = yield* Effect.try({
            try: () => relativeInside(root.rootPath, request.cwd),
            catch: (error) =>
              error instanceof ExchangeError.PathEscape
                ? error
                : new ExchangeError.PathEscape({ detail: "Test subprocess workdir escapes the approved OFXP root" }),
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
              ...(action === "run"
                ? {
                    beforeStart: () =>
                      deps.invocations
                        .prepare({ invocationID: call.context.invocationID, targetRef })
                        .pipe(Effect.tap((next) => Effect.sync(() => { receipt = next; prepared = true })), Effect.asVoid),
                  }
                : {}),
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
  ).pipe(
    Effect.catch((error) => {
      if (action !== "run" || !receipt) return Effect.fail(error)
      if (prepared) {
        return Effect.fail(
          new ExchangeError.AmbiguousCommit({
            detail: `OFXP test invocation ${call.context.invocationID} crossed its process-start boundary and did not complete with a durable result; do not replay it blindly`,
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

  if (action === "run" && receipt) {
    const resultDigest = ExchangeRequestDigest.sha256("ofxp:test-result:v1", {
      title: result.title,
      output: result.output,
      metadata: result.metadata,
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
              detail: `OFXP test invocation ${call.context.invocationID} completed, but its durable receipt could not be committed; reconcile before retrying`,
              targetRef,
            }),
        ),
      )
    return {
      title: result.title,
      output: result.output,
      metadata: { ...result.metadata, receipt: settled, resultDigest },
      grantRevision: admission.grantRevision,
    } satisfies Result
  }

  return {
    title: result.title,
    output: result.output,
    metadata: result.metadata,
    grantRevision: admission.grantRevision,
  } satisfies Result
})

