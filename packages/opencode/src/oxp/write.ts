import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeError } from "@/exchange/error"
import { ExchangeWrite } from "@/exchange/write"
import { TypecheckScope } from "@/tool/typecheck-scope"
import { OxpAuthority } from "./authority"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpGrounding } from "./grounding"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"
import { OxpTypecheck } from "./typecheck"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({
    description: "Approved root that owns the target file.",
  }),
  path: Schema.String.annotate({
    description: "Target path inside rootID. The file may be missing: write creates it; existing files are fully replaced.",
  }),
  content: Schema.String.annotate({
    description:
      "Complete desired text content for the file. Prefer this direct field for file-authoring intent; process remains available for general scripts and commands.",
  }),
  runTypecheck: Schema.optional(Schema.Boolean),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (
    input: Input,
    signal?: AbortSignal,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpWrite") {}
export const use = serviceUse(Service)

function relativeWithin(root: string, target: string) {
  const rel = path.relative(root, target)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  return rel === "" ? "." : rel.split(path.sep).join("/")
}

function mapExchangeError(error: ExchangeError.Error): OxpError.Error {
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Cancelled) return new OxpError.Cancelled({ detail: "OXP write was cancelled" })
  if (error instanceof ExchangeError.Conflict) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.AmbiguousCommit) {
    return new OxpError.AmbiguousExternalResult({ detail: OxpError.boundDetail(error.detail) })
  }
  return new OxpError.DependencyUnavailable({ detail: "OXP write dependency is unavailable" })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const grounding = yield* OxpGrounding.Service
    const fs = yield* FSUtil.Service
    const typecheck = yield* OxpTypecheck.Service

    const execute = Effect.fn("OxpWrite.execute")(function* (input: Input, signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP write was cancelled" })
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "write",
        phase: "mutate",
        rootID: input.rootID,
        path: input.path,
        allowMissing: true,
      })
      if (!admission.root || !("path" in admission.root)) {
        return yield* new OxpError.RootRequired({ detail: "write requires an approved file path" })
      }
      const target = admission.root.path
      const virtualPath = admission.root.virtualPath
      const root = admission.root.root
      const rootPath = admission.root.canonicalPath
      const principal = (yield* config.get()).connector.id
      const scopedGrounding = grounding.scoped(principal)
      const grounded = scopedGrounding.get(root.id, target)

      if (input.runTypecheck && TypecheckScope.isTsFile(target)) {
        yield* authority.authorize({
          plane: "augmentation",
          operation: "typecheck.run",
          phase: "spawn",
          rootID: input.rootID,
        })
      }
      const execution = yield* ExchangeWrite.execute(
        fs,
        {
          path: target,
          displayPath: virtualPath,
          content: input.content,
          expectedFingerprint: grounded,
          signal,
          projectionMarker: "<note>OXP write diff truncated; inspect the file for complete post-state</note>",
        },
        {
          revalidate: () =>
            authority.revalidate(admission, "commit").pipe(
              Effect.flatMap((fresh) => {
                if (!fresh.root || !("path" in fresh.root)) {
                  return Effect.fail(new OxpError.AuthRevoked({ detail: "OXP write authority changed before commit" }))
                }
                if (FSUtil.normalizePath(fresh.root.path) !== FSUtil.normalizePath(target)) {
                  return Effect.fail(new OxpError.AuthRevoked({ detail: "OXP write target identity changed before commit" }))
                }
                return Effect.void
              }),
            ),
        },
      ).pipe(Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))))

      if (execution.fingerprint) scopedGrounding.note(root.id, target, execution.fingerprint)
      let output = execution.result.output

      if (execution.mutation.committed && input.runTypecheck && TypecheckScope.isTsFile(target)) {
        const parent = relativeWithin(rootPath, path.dirname(target))
        if (parent !== undefined) {
          const checked = yield* typecheck
            .execute(
              {
                rootID: input.rootID,
                workdir: parent,
                mode: "file",
                filePath: path.basename(target),
                timeoutMs: 30_000,
              },
              signal,
            )
            .pipe(Effect.catch((error) => Effect.succeed(undefined)))
          if (checked) output += "\n\n" + checked.output
          else output += "\n\n<typecheck status=\"unavailable\">Post-write typecheck could not be completed.</typecheck>"
        }
      }

      return {
        ...execution.result,
        output,
        mutation: execution.mutation,
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpConfig.node, OxpGrounding.node, OxpTypecheck.node, FSUtil.node],
})

export * as OxpWrite from "./write"
