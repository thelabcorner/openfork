export * as OfxpRefactorCapability from "./refactor"

import path from "node:path"
import { Cause, Effect, Schema } from "effect"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeRefactor } from "@/exchange/refactor"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import { ExchangeTypecheck } from "@/exchange/typecheck"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpPrincipal } from "../principal"
import { OfxpRoot } from "../root"
import { OfxpProcessCapability } from "./process"

export const Parameters = ExchangeRefactor.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly invocations: OfxpInvocation.Interface
  readonly process: OfxpProcessCapability.Interface
  readonly app: AppProcess.Interface
  readonly fs: FSUtil.Interface
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly grantRevision: number
}

const READ_ONLY = new Set<ExchangeRefactor.Input["mode"]>(["resolveSymbol", "findReferences", "preview"])

function relativeInside(rootPath: string, absolutePath: string) {
  const relative = path.relative(rootPath, absolutePath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ExchangeError.PathEscape({ detail: "Refactor path escapes the approved OFXP root" })
  }
  return relative === "" ? undefined : relative.split(path.sep).join("/")
}

function mapExecutionError(
  error: unknown,
  signal: AbortSignal | undefined,
  rootPath: string,
  virtualRoot: string,
): Error {
  if (
    error instanceof OfxpPeer.OfxpPeerSchema.NotFoundError ||
    error instanceof OfxpPeer.OfxpPeerSchema.StaleRevisionError ||
    error instanceof OfxpPeer.OfxpPeerSchema.AuthorityDeniedError ||
    error instanceof OfxpRoot.InvalidPathError ||
    error instanceof OfxpRoot.RootChangedError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.NotFoundError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.CollisionError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.InvalidTransitionError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.ValidationError ||
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
  if (signal?.aborted) return new ExchangeError.Cancelled({ detail: "OFXP refactor operation was cancelled" })
  const raw = error instanceof Error ? error.message : "Refactor operation failed"
  const detail = raw
    .split(rootPath)
    .join(virtualRoot)
    .split(rootPath.replaceAll("\\", "/"))
    .join(virtualRoot)
    .split(rootPath.replaceAll("/", "\\"))
    .join(virtualRoot)
  if (/outside the worktree|escapes the worktree|non-canonical path/i.test(detail)) {
    return new ExchangeError.PathEscape({ detail })
  }
  if (/Preview is stale|Destination exists/i.test(detail)) return new ExchangeError.Conflict({ detail })
  if (/not found or expired|expired or missing|ENOENT|no such file/i.test(detail)) {
    return new ExchangeError.NotFound({ detail })
  }
  if (/typescript.*resolvable|compiler|typecheck/i.test(detail)) {
    return new ExchangeError.DependencyUnavailable({ detail })
  }
  return new ExchangeError.InvalidArgument({ detail })
}

export const execute = Effect.fn("OfxpRefactorCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  if (!call.rootID) return yield* new ExchangeError.InvalidArgument({ detail: "OFXP refactor requires an approved root" })
  const rootID = call.rootID
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP refactor arguments are invalid" }),
  })
  const mutating = !READ_ONLY.has(input.mode)
  const readAdmission = yield* deps.peers.authorize({
    peerID: peer.peerID,
    capability: "read",
    rootID,
  })
  const root = yield* deps.roots.verify(readAdmission)
  const grantRevision = readAdmission.grantRevision
  if (mutating) {
    yield* deps.peers.authorize({
      peerID: peer.peerID,
      capability: "write",
      rootID,
      expectedGrantRevision: grantRevision,
    })
  }
  const principal = OfxpPrincipal.key(peer.peerID, call.context)

  const authorize = (capability: "read" | "write" | "process") =>
    deps.peers.authorize({
      peerID: peer.peerID,
      capability,
      rootID,
      expectedGrantRevision: grantRevision,
    })

  const resolveRelative = Effect.fn("OfxpRefactorCapability.resolveRelative")(function* (
    value: string,
    allowMissing = false,
  ) {
    const fresh = yield* authorize("read")
    const resolved = yield* deps.roots.resolve(fresh, value, { allowMissing })
    return resolved.relativePath
  })

  const filePath = input.filePath ? yield* resolveRelative(input.filePath) : undefined
  const files = input.files?.length
    ? yield* Effect.forEach(input.files, (file) => resolveRelative(file), { concurrency: 8 })
    : undefined
  const from =
    input.mode === "moveFileUpdateImports" && input.from
      ? yield* resolveRelative(input.from)
      : input.from
  const to =
    input.mode === "moveFileUpdateImports" && input.to
      ? yield* resolveRelative(input.to, true)
      : input.to
  const params: ExchangeRefactor.Input = {
    ...input,
    ...(filePath === undefined ? {} : { filePath }),
    ...(files === undefined ? {} : { files }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  }

  let receipt: Ofxp.InvocationReceipt | undefined
  let started = false
  const targetRef = root.virtualPath
  if (mutating) {
    const admitted = yield* deps.invocations.admit({
      invocationID: call.context.invocationID,
      sourcePeerID: peer.peerID,
      operation: `refactor.${input.mode}`,
      commitClass: "non_idempotent_mutation",
      requestDigest: ExchangeRequestDigest.sha256("ofxp:refactor:v1", {
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
          title: `refactor ${input.mode}`,
          output: `OFXP refactor invocation ${receipt.invocationID} was already committed; no duplicate refactor mutation was executed.`,
          metadata: { mode: input.mode, duplicate: true, receipt },
          grantRevision,
        } satisfies Result
      }
      if (receipt.state === "started") {
        return yield* new ExchangeError.AmbiguousCommit({
          detail: `OFXP refactor invocation ${receipt.invocationID} crossed its mutation boundary; inspect the preview/source state before retrying`,
          targetRef,
        })
      }
      if (receipt.state === "cancelled") {
        return yield* new ExchangeError.Cancelled({
          detail: `OFXP refactor invocation ${receipt.invocationID} was already cancelled`,
        })
      }
      if (receipt.state === "failed") {
        return yield* new ExchangeError.Conflict({
          detail: `OFXP refactor invocation ${receipt.invocationID} already failed; use a new InvocationID`,
        })
      }
    }
  }

  const authorizeAbsolute = Effect.fn("OfxpRefactorCapability.authorizeAbsolute")(function* (
    capability: "read" | "write",
    absolutePath?: string,
    allowMissing = false,
  ) {
    const fresh = yield* authorize(capability)
    if (!absolutePath) {
      yield* deps.roots.verify(fresh)
      return root.rootPath
    }
    const relative = yield* Effect.try({
      try: () => relativeInside(root.rootPath, absolutePath),
      catch: (error) =>
        error instanceof ExchangeError.PathEscape
          ? error
          : new ExchangeError.PathEscape({ detail: "Refactor path escapes the approved OFXP root" }),
    })
    return (yield* deps.roots.resolve(fresh, relative, { allowMissing })).path
  })

  const prepareMutation = Effect.fn("OfxpRefactorCapability.prepareMutation")(function* (absolutePath?: string) {
    yield* authorizeAbsolute("write", absolutePath, true)
    if (!mutating || started) return
    receipt = yield* deps.invocations.prepare({
      invocationID: call.context.invocationID,
      targetRef,
    })
    started = true
  })

  const processRevalidate = () =>
    authorize("process").pipe(
      Effect.flatMap((fresh) => deps.roots.verify(fresh)),
      Effect.asVoid,
    )

  const access: ExchangeRefactor.Access = {
    worktree: root.rootPath,
    abort: signal ?? new AbortController().signal,
    ask: (request) => {
      const candidate =
        request.metadata && typeof request.metadata.filepath === "string"
          ? request.metadata.filepath
          : undefined
      return request.permission === "edit"
        ? prepareMutation(candidate)
        : authorizeAbsolute("read", candidate).pipe(Effect.asVoid)
    },
    beforePlanMutation: (file) => prepareMutation(file),
    beforeTypecheck: processRevalidate,
    runTypecheck: (request) =>
      ExchangeTypecheck.execute(
        {
          mode: "files",
          files: request.files.map((file) => relativeInside(root.rootPath, file) ?? "."),
          maxErrors: request.maxErrors,
          timeoutMs: request.timeoutMs,
        },
        {
          rootPath: root.rootPath,
          directory: root.rootPath,
          authorizePath: (absolutePath) =>
            authorizeAbsolute("read", absolutePath).pipe(Effect.map((resolved) => resolved)),
          toVirtualPath: (absolutePath) => OfxpRoot.toVirtualPath(root, absolutePath),
          run: (owned) =>
            Effect.gen(function* () {
              const workdir = yield* Effect.try({
                try: () => relativeInside(root.rootPath, owned.cwd),
                catch: (error) =>
                  error instanceof ExchangeError.PathEscape
                    ? error
                    : new ExchangeError.PathEscape({ detail: "Refactor typecheck workdir escapes the approved OFXP root" }),
              })
              return yield* deps.process.runArgv(
                peer,
                call.context,
                {
                  rootID,
                  workdir,
                  argv: owned.argv,
                  env: owned.env,
                  title: owned.title,
                  operation: owned.operation,
                  timeoutMs: owned.timeoutMs,
                  outputCapBytes: owned.outputCapBytes,
                  expectedGrantRevision: grantRevision,
                },
                owned.signal ?? signal,
              )
            }),
          revalidate: () =>
            authorize("read").pipe(
              Effect.flatMap((fresh) => deps.roots.verify(fresh)),
              Effect.andThen(processRevalidate()),
              Effect.asVoid,
            ),
        },
        request.signal,
      ).pipe(
        Effect.map((result) => {
          const errors = (result.metadata as { errors?: unknown }).errors
          return typeof errors === "number" ? errors : 0
        }),
        Effect.mapError((error) =>
          error instanceof Error
            ? error
            : new Error("OFXP refactor typecheck failed"),
        ),
      ),
  }

  const execution = yield* ExchangeRefactor.execute(params, access).pipe(
    Effect.provideService(AppProcess.Service, deps.app),
    Effect.provideService(FSUtil.Service, deps.fs),
    Effect.catchCause((cause) =>
      Effect.fail(
        mapExecutionError(Cause.squash(cause), signal, root.rootPath, root.virtualPath),
      ),
    ),
    Effect.catch((error) => {
      if (!mutating || !receipt) return Effect.fail(error)
      if (started || error instanceof ExchangeError.AmbiguousCommit) {
        return Effect.fail(
          error instanceof ExchangeError.AmbiguousCommit
            ? error
            : new ExchangeError.AmbiguousCommit({
                detail: `OFXP refactor invocation ${call.context.invocationID} may have changed preview/source state; inspect it before retrying`,
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

  yield* authorize("read").pipe(
    Effect.flatMap((fresh) => deps.roots.verify(fresh)),
    Effect.asVoid,
  )

  const metadata = {
    ...execution.metadata,
    sourceMutation: execution.metadata.status === "applied",
    planMutation: execution.metadata.status === "preview" && mutating,
  }
  if (mutating && receipt) {
    const resultDigest = ExchangeRequestDigest.sha256("ofxp:refactor-result:v1", {
      title: execution.title,
      output: execution.output,
      metadata,
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
              detail: `OFXP refactor operation completed, but its durable receipt could not be settled; reconcile InvocationID ${call.context.invocationID} before retrying`,
              targetRef,
            }),
        ),
      )
    return {
      title: execution.title,
      output: execution.output.replace(
        "Next call to apply: refactor(",
        "Next call to apply through OFXP refactor args: ",
      ),
      metadata: {
        ...metadata,
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
    metadata,
    grantRevision,
  } satisfies Result
})

