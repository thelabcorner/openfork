import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeSqlite } from "@/exchange/sqlite"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({ description: "Approved root containing every SQLite database/output path used by this call." }),
  ...ExchangeSqlite.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpSqlite") {}
export const use = serviceUse(Service)

function mapExecutionError(error: unknown, signal?: AbortSignal): OxpError.Error {
  if (signal?.aborted) return new OxpError.Cancelled({ detail: "OXP SQLite operation was cancelled" })
  if (OxpError.isError(error)) return error
  const detail = error instanceof Error ? error.message : "SQLite operation failed"
  if (/not found|no such table|Not a SQLite database|is a directory/i.test(detail)) {
    return new OxpError.NotFound({ detail })
  }
  if (/locked|busy/i.test(detail)) return new OxpError.Busy({ detail })
  if (/requires|Single statement|not supported|NUL bytes|starting with|Too many attach|already exists|Unsupported sqlite action/i.test(detail)) {
    return new OxpError.InvalidArgument({ detail })
  }
  return new OxpError.DependencyUnavailable({ detail: "OpenFork SQLite execution failed" })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service

    const execute = Effect.fn("OxpSqlite.execute")(function* (input: Input, signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP SQLite operation was cancelled" })
      const root = yield* roots.resolveRoot(input.rootID)
      const primaryPhase = input.action === "run" ? "mutate" as const : "read" as const
      const toNative = (value: string) => path.isAbsolute(value) ? value : path.join(root.canonicalPath, value)

      // Fail closed before the shared executor performs even metadata/header
      // reads. `run` can mutate attached databases, while `export` reads every
      // database and writes one output file, so each path is independently
      // admitted instead of inheriting authority from the primary DB.
      const readAdmissions = new Map<string, OxpAuthority.Admission>()
      const writeAdmissions = new Map<string, OxpAuthority.Admission>()
      const admissions: OxpAuthority.Admission[] = []
      const remember = (admission: OxpAuthority.Admission, mode: "read" | "write") => {
        const resolved = admission.root
        if (!resolved || !("path" in resolved)) return
        const key = FSUtil.normalizePath(resolved.path)
        ;(mode === "read" ? readAdmissions : writeAdmissions).set(key, admission)
        admissions.push(admission)
      }

      const preflight = [input.db, ...(input.attach ?? [])]
      for (const candidate of preflight) {
        const mode = input.action === "run" ? "write" as const : "read" as const
        const admission = yield* authority.authorize({
          plane: "augmentation",
          operation: mode === "write" ? "sqlite.write" : "sqlite.read",
          phase: primaryPhase,
          rootID: input.rootID,
          path: toNative(candidate),
          ...(input.action === "run" ? { allowMissing: true } : {}),
        })
        remember(admission, mode)
      }
      if (input.action === "export") {
        if (!input.outputPath) return yield* new OxpError.InvalidArgument({ detail: "sqlite.export requires outputPath" })
        const admission = yield* authority.authorize({
          plane: "augmentation",
          operation: "sqlite.write",
          phase: "mutate",
          rootID: input.rootID,
          path: toNative(input.outputPath),
          allowMissing: true,
        })
        remember(admission, "write")
      }

      const admitted = (target: { readonly abs: string }, mode: "read" | "write") => {
        const key = FSUtil.normalizePath(target.abs)
        return (mode === "read" ? readAdmissions : writeAdmissions).get(key)
      }
      const access: ExchangeSqlite.SqliteAccess = {
        read: (target) => {
          const admission = admitted(target, "read")
          return admission
            ? authority.revalidate(admission, "read").pipe(Effect.asVoid)
            : Effect.fail(new OxpError.AuthRevoked({ detail: "SQLite read lost its path admission" }))
        },
        write: (target) => {
          const admission = admitted(target, "write")
          return admission
            ? authority.revalidate(admission, "mutate").pipe(Effect.asVoid)
            : Effect.fail(new OxpError.AuthRevoked({ detail: "SQLite write lost its path admission" }))
        },
        commit: (target) => {
          const admission = admitted(target, "write")
          return admission
            ? authority.revalidate(admission, "commit").pipe(Effect.asVoid)
            : Effect.fail(new OxpError.AuthRevoked({ detail: "SQLite commit lost its write admission" }))
        },
      }

      const { rootID: _rootID, ...params } = input
      const result = yield* ExchangeSqlite.execute(
        params,
        { directory: root.canonicalPath, worktree: root.canonicalPath },
        access,
      ).pipe(Effect.mapError((error) => mapExecutionError(error, signal)))

      for (const admission of admissions) yield* authority.revalidate(admission, "egress")
      const mutating = input.action === "run" || input.action === "export"
      const committed = input.action === "export" || (input.action === "run" && input.dryRun === false)
      return {
        title: result.title,
        output: result.output,
        structured: { action: input.action, metadata: result.metadata },
        metadata: { ...result.metadata, rootID: input.rootID },
        ...(mutating ? { mutation: { attempted: true, committed } } : {}),
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpAuthority.node, OxpRoot.node] })

export * as OxpSqlite from "./sqlite"
