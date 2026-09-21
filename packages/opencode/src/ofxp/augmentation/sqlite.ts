export * as OfxpSqliteCapability from "./sqlite"

import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpInvocation } from "@opencode-ai/core/ofxp-invocation"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeRequestDigest } from "@/exchange/request-digest"
import { ExchangeSqlite } from "@/exchange/sqlite"
import type { PeerCertificateIdentity } from "../certificate"
import { OfxpPrincipal } from "../principal"
import { OfxpRoot } from "../root"

export const Parameters = ExchangeSqlite.Parameters

export interface Dependencies {
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
  readonly invocations: OfxpInvocation.Interface
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly grantRevision: number
}

type PathAdmission = {
  readonly capability: "read" | "write"
  readonly relativePath: string
  readonly native: string
  readonly virtual: string
  readonly allowMissing: boolean
}

function preserveControlError(error: unknown) {
  return (
    error instanceof OfxpPeer.OfxpPeerSchema.NotFoundError ||
    error instanceof OfxpPeer.OfxpPeerSchema.StaleRevisionError ||
    error instanceof OfxpPeer.OfxpPeerSchema.AuthorityDeniedError ||
    error instanceof OfxpRoot.InvalidPathError ||
    error instanceof OfxpRoot.RootChangedError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.NotFoundError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.CollisionError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.InvalidTransitionError ||
    error instanceof OfxpInvocation.OfxpInvocationSchema.ValidationError
  )
}

function mapExecutionError(error: unknown, signal?: AbortSignal) {
  if (preserveControlError(error)) return error
  if (
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
  if (signal?.aborted) return new ExchangeError.Cancelled({ detail: "OFXP SQLite operation was cancelled" })
  const detail = error instanceof Error ? error.message : "SQLite operation failed"
  if (/not found|no such table|Not a SQLite database|is a directory/i.test(detail)) {
    return new ExchangeError.NotFound({ detail })
  }
  if (/locked|busy/i.test(detail)) return new ExchangeError.Conflict({ detail })
  if (
    /requires|Single statement|not supported|NUL bytes|starting with|Too many attach|already exists|Unsupported sqlite action/i.test(
      detail,
    )
  ) {
    return new ExchangeError.InvalidArgument({ detail })
  }
  return new ExchangeError.DependencyUnavailable({ detail: "OpenFork SQLite execution failed" })
}

export const execute = Effect.fn("OfxpSqliteCapability.execute")(function* (
  deps: Dependencies,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
  signal?: AbortSignal,
) {
  if (!call.rootID) return yield* new ExchangeError.InvalidArgument({ detail: "OFXP SQLite requires an approved root" })
  const rootID = call.rootID
  const input = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Parameters)(call.args, { onExcessProperty: "error" }),
    catch: () => new ExchangeError.InvalidArgument({ detail: "OFXP SQLite arguments are invalid" }),
  })
  const mutating = input.action === "run" || input.action === "export"
  const primaryCapability: "read" | "write" = input.action === "run" ? "write" : "read"
  const initial = yield* deps.peers.authorize({
    peerID: peer.peerID,
    capability: primaryCapability,
    rootID,
  })
  const root = yield* deps.roots.verify(initial)
  const grantRevision = initial.grantRevision
  const principal = OfxpPrincipal.key(peer.peerID, call.context)

  const authorize = (capability: "read" | "write") =>
    deps.peers.authorize({
      peerID: peer.peerID,
      capability,
      rootID,
      expectedGrantRevision: grantRevision,
    })

  const admissions = new Map<string, PathAdmission>()
  const key = (value: string) => FSUtil.normalizePath(value)
  const admit = Effect.fn("OfxpSqliteCapability.admitPath")(function* (
    capability: "read" | "write",
    relativePath: string,
    allowMissing = false,
    authorization?: OfxpPeer.Authorization,
  ) {
    const fresh = authorization ?? (yield* authorize(capability))
    const resolved = yield* deps.roots.resolve(fresh, relativePath, { allowMissing })
    const item: PathAdmission = {
      capability,
      relativePath: resolved.relativePath,
      native: resolved.path,
      virtual: resolved.virtualPath,
      allowMissing,
    }
    admissions.set(key(item.native), item)
    return item
  })

  const primary = yield* admit(primaryCapability, input.db, input.action === "run", initial)
  for (const attached of input.attach ?? []) {
    yield* admit(input.action === "run" ? "write" : "read", attached)
  }
  let exportTarget: PathAdmission | undefined
  if (input.action === "export") {
    if (!input.outputPath) return yield* new ExchangeError.InvalidArgument({ detail: "sqlite.export requires outputPath" })
    exportTarget = yield* admit("write", input.outputPath, true)
  }

  const retained = Effect.fn("OfxpSqliteCapability.retained")(function* (
    target: Readonly<ExchangeSqlite.Resolved>,
    capability: "read" | "write",
  ) {
    const item = admissions.get(key(target.abs))
    if (!item || item.capability !== capability) {
      return yield* new ExchangeError.AuthorityDenied({
        detail: `OFXP SQLite ${capability} lost its path admission`,
      })
    }
    return item
  })

  const revalidate = Effect.fn("OfxpSqliteCapability.revalidate")(function* (
    target: Readonly<ExchangeSqlite.Resolved>,
    capability: "read" | "write",
  ) {
    const item = yield* retained(target, capability)
    const fresh = yield* authorize(capability)
    const resolved = yield* deps.roots.resolve(fresh, item.relativePath, { allowMissing: item.allowMissing })
    if (FSUtil.normalizePath(resolved.path) !== FSUtil.normalizePath(item.native)) {
      return yield* new OfxpRoot.RootChangedError({ detail: "OFXP SQLite path identity changed" })
    }
  })

  let receipt: Ofxp.InvocationReceipt | undefined
  let started = false
  const targetRef = input.action === "export" ? exportTarget?.virtual : primary.virtual
  if (mutating) {
    const admitted = yield* deps.invocations.admit({
      invocationID: call.context.invocationID,
      sourcePeerID: peer.peerID,
      operation: `sqlite.${input.action}`,
      commitClass: "non_idempotent_mutation",
      requestDigest: ExchangeRequestDigest.sha256("ofxp:sqlite:v1", {
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
          title: receipt.targetRef ?? targetRef ?? "sqlite",
          output: `OFXP SQLite invocation ${receipt.invocationID} was already committed; no duplicate SQLite mutation was executed.`,
          metadata: { action: input.action, duplicate: true, receipt },
          grantRevision,
        } satisfies Result
      }
      if (receipt.state === "started") {
        return yield* new ExchangeError.AmbiguousCommit({
          detail: `OFXP SQLite invocation ${receipt.invocationID} crossed its mutation boundary; inspect the database/output before retrying`,
          targetRef: receipt.targetRef ?? targetRef,
        })
      }
      if (receipt.state === "cancelled") {
        return yield* new ExchangeError.Cancelled({
          detail: `OFXP SQLite invocation ${receipt.invocationID} was already cancelled`,
        })
      }
      if (receipt.state === "failed") {
        return yield* new ExchangeError.Conflict({
          detail: `OFXP SQLite invocation ${receipt.invocationID} already failed; use a new InvocationID`,
        })
      }
    }
  }

  const access: ExchangeSqlite.SqliteAccess = {
    read: (target) => revalidate(target, "read"),
    write: (target) => revalidate(target, "write"),
    beforeMutation: (target, _metadata) =>
      Effect.gen(function* () {
        yield* revalidate(target, "write")
        if (!mutating || started) return
        receipt = yield* deps.invocations.prepare({
          invocationID: call.context.invocationID,
          targetRef: targetRef ?? admissions.get(key(target.abs))?.virtual ?? root.virtualPath,
        })
        started = true
      }),
    commit: (target) => revalidate(target, "write"),
  }

  const execution = yield* ExchangeSqlite.execute(
    input,
    { directory: root.rootPath, worktree: root.rootPath },
    access,
  ).pipe(
    Effect.mapError((error) => mapExecutionError(error, signal)),
    Effect.catch((error) => {
      if (!mutating || !receipt) return Effect.fail(error)
      if (started || error instanceof ExchangeError.AmbiguousCommit) {
        return Effect.fail(
          error instanceof ExchangeError.AmbiguousCommit
            ? error
            : new ExchangeError.AmbiguousCommit({
                detail: `OFXP SQLite invocation ${call.context.invocationID} may have changed the database/output; inspect it before retrying`,
                targetRef: receipt.targetRef ?? targetRef,
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

  for (const item of admissions.values()) {
    const fresh = yield* authorize(item.capability)
    const resolved = yield* deps.roots.resolve(fresh, item.relativePath, { allowMissing: item.allowMissing })
    if (FSUtil.normalizePath(resolved.path) !== FSUtil.normalizePath(item.native)) {
      return yield* new OfxpRoot.RootChangedError({ detail: "OFXP SQLite path identity changed before egress" })
    }
  }

  if (mutating && receipt) {
    const resultDigest = ExchangeRequestDigest.sha256("ofxp:sqlite-result:v1", {
      title: execution.title,
      output: execution.output,
      metadata: execution.metadata,
    })
    const settled = yield* deps.invocations
      .settle({
        invocationID: call.context.invocationID,
        state: "committed",
        targetRef: receipt.targetRef ?? targetRef,
        resultDigest,
      })
      .pipe(
        Effect.mapError(
          () =>
            new ExchangeError.AmbiguousCommit({
              detail: `OFXP SQLite operation completed, but its durable receipt could not be settled; reconcile InvocationID ${call.context.invocationID} before retrying`,
              targetRef: receipt?.targetRef ?? targetRef,
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

