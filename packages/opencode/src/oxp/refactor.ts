import path from "node:path"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeRefactor } from "@/exchange/refactor"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({ description: "Approved root containing every source/plan path used by this refactor." }),
  ...ExchangeRefactor.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpRefactor") {}
export const use = serviceUse(Service)

const READ_ONLY = new Set<Input["mode"]>(["resolveSymbol", "findReferences", "preview"])

function mapExecutionError(error: unknown, signal?: AbortSignal, rootPath?: string, virtualRoot?: string): OxpError.Error {
  if (signal?.aborted) return new OxpError.Cancelled({ detail: "OXP refactor operation was cancelled" })
  if (OxpError.isError(error)) return error
  const raw = error instanceof Error ? error.message : "Refactor operation failed"
  const detail = rootPath && virtualRoot ? raw.split(rootPath).join(virtualRoot) : raw
  if (/outside the worktree|escapes the worktree|non-canonical path/i.test(detail)) {
    return new OxpError.PathEscape({ detail })
  }
  if (/Preview is stale|Destination exists/i.test(detail)) return new OxpError.Conflict({ detail })
  if (/not found or expired|expired or missing|ENOENT|no such file/i.test(detail)) {
    return new OxpError.NotFound({ detail })
  }
  if (/typescript.*resolvable|compiler|typecheck/i.test(detail)) {
    return new OxpError.DependencyUnavailable({ detail })
  }
  return new OxpError.InvalidArgument({ detail })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service
    const app = yield* AppProcess.Service
    const fs = yield* FSUtil.Service

    const execute = Effect.fn("OxpRefactor.execute")(function* (input: Input, signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP refactor operation was cancelled" })

      const rootAdmission = yield* authority.authorize({
        plane: "augmentation",
        operation: "refactor.read",
        phase: "read",
        rootID: input.rootID,
      })
      if (!rootAdmission.root || "path" in rootAdmission.root) {
        return yield* new OxpError.RootRequired({ detail: "refactor requires one explicit approved root" })
      }
      const root = rootAdmission.root

      const toRelative = Effect.fn("OxpRefactor.toRelative")(function* (value: string, allowMissing = false) {
        const resolved = yield* roots.resolvePath(value, { rootID: input.rootID, allowMissing })
        const rel = path.relative(root.canonicalPath, resolved.path)
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
          return yield* new OxpError.PathEscape({ detail: "Refactor path must name a file inside the approved root" })
        }
        return rel
      })

      const { rootID: _rootID, ...raw } = input
      const filePath = raw.filePath ? yield* toRelative(raw.filePath) : undefined
      const files = raw.files?.length
        ? yield* Effect.forEach(raw.files, (file) => toRelative(file), { concurrency: 8 })
        : undefined
      const from =
        raw.mode === "moveFileUpdateImports" && raw.from
          ? yield* toRelative(raw.from)
          : raw.from
      const to =
        raw.mode === "moveFileUpdateImports" && raw.to
          ? yield* toRelative(raw.to, true)
          : raw.to
      const params: ExchangeRefactor.Input = {
        ...raw,
        ...(filePath === undefined ? {} : { filePath }),
        ...(files === undefined ? {} : { files }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      }

      const authorizePath = (
        operation: "refactor.read" | "refactor.write",
        phase: "read" | "commit",
        candidate?: string,
        allowMissing = false,
      ) =>
        candidate
          ? authority.authorize({
              plane: "augmentation",
              operation,
              phase,
              rootID: input.rootID,
              path: candidate,
              allowMissing,
            }).pipe(Effect.asVoid)
          : authority.revalidate(rootAdmission, phase).pipe(Effect.asVoid)

      const access: ExchangeRefactor.Access = {
        worktree: root.canonicalPath,
        abort: signal ?? new AbortController().signal,
        ask: (request) => {
          const candidate =
            request.metadata && typeof request.metadata.filepath === "string"
              ? request.metadata.filepath
              : undefined
          return request.permission === "edit"
            ? authorizePath("refactor.write", "commit", candidate, true)
            : authorizePath("refactor.read", "read", candidate)
        },
        beforePlanMutation: (file) => authorizePath("refactor.write", "commit", file, true),
        beforeTypecheck: () =>
          authority.authorize({
            plane: "augmentation",
            operation: "refactor.process",
            phase: "spawn",
            rootID: input.rootID,
          }).pipe(Effect.asVoid),
      }

      const result = yield* ExchangeRefactor.execute(params, access).pipe(
        Effect.provideService(AppProcess.Service, app),
        Effect.provideService(FSUtil.Service, fs),
        Effect.catchCause((cause) =>
          Effect.fail(
            mapExecutionError(
              Cause.squash(cause),
              signal,
              root.canonicalPath,
              "/" + root.root.alias,
            ),
          ),
        ),
      )

      yield* authority.revalidate(rootAdmission, "egress")
      const output = result.output.replace(
        "Next call to apply: refactor(",
        "Next call to apply through OXP refactor args: ",
      )
      const sourceMutation = result.metadata.status === "applied"
      const planMutation = result.metadata.status === "preview" && !READ_ONLY.has(input.mode)
      const attempted = !READ_ONLY.has(input.mode)
      return {
        title: result.title,
        output,
        structured: {
          mode: input.mode,
          status: result.metadata.status,
          ...(result.metadata.previewId ? { previewId: result.metadata.previewId } : {}),
          changedFiles: result.metadata.changedFiles,
          edits: result.metadata.edits,
        },
        metadata: {
          ...result.metadata,
          rootID: input.rootID,
          sourceMutation,
          planMutation,
        },
        ...(attempted
          ? { mutation: { attempted: true, committed: sourceMutation || planMutation } }
          : {}),
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpRoot.node, AppProcess.node, FSUtil.node],
})

export * as OxpRefactor from "./refactor"
