import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeError } from "@/exchange/error"
import { ExchangePatch } from "@/exchange/patch"
import { OxpAuthority } from "./authority"
import { OxpConfig } from "./config"
import { OxpError } from "./error"
import { OxpGrounding } from "./grounding"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID,
  patchText: Schema.String,
  format: Schema.optional(Schema.Literals(["auto", "opencode", "git"])),
  apply: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("if-clean")])),
  showDiff: Schema.optional(Schema.Boolean),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpPatch") {}
export const use = serviceUse(Service)

function mapExchangeError(error: ExchangeError.Error): OxpError.Error {
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Cancelled) return new OxpError.Cancelled({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Conflict) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.NotFound) return new OxpError.NotFound({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.PathEscape) return new OxpError.PathEscape({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.AuthorityDenied) return new OxpError.AuthRevoked({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.AmbiguousCommit) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  return new OxpError.DependencyUnavailable({ detail: OxpError.boundDetail(error.detail) })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const grounding = yield* OxpGrounding.Service
    const fs = yield* FSUtil.Service

    const execute: Interface["execute"] = Effect.fn("OxpPatch.execute")(function* (input, signal) {
      const admitted = yield* authority.authorize({
        plane: "augmentation",
        operation: "patch",
        phase: "mutate",
        rootID: input.rootID,
      })
      if (!admitted.root || "path" in admitted.root) {
        return yield* new OxpError.RootRequired({ detail: "patch requires one explicit approved root" })
      }

      const execution = yield* ExchangePatch.execute(
        fs,
        {
          patchText: input.patchText,
          format: input.format,
          apply: input.apply,
          showDiff: input.showDiff,
        },
        {
          resolve: (relativePath, allowMissing) =>
            Effect.gen(function* () {
              const resolved = yield* authority.authorize({
                plane: "augmentation",
                operation: "patch",
                phase: "mutate",
                rootID: input.rootID,
                path: relativePath,
                allowMissing,
              })
              if (!resolved.root || !("path" in resolved.root)) {
                return yield* new OxpError.RootRequired({ detail: "Patch path did not resolve" })
              }
              return { path: resolved.root.path, displayPath: resolved.root.virtualPath }
            }),
          revalidate: () => authority.revalidate(admitted, "commit").pipe(Effect.asVoid),
          beforeCommit: () => Effect.void,
        },
        signal,
      ).pipe(Effect.mapError((error) => (OxpError.isError(error) ? error : mapExchangeError(error))))

      if (execution.result.mutation.committed) {
        const scopedGrounding = grounding.scoped((yield* config.get()).connector.id)
        for (const touch of execution.touched) {
          if (touch.type === "delete" || touch.type === "move") scopedGrounding.remove(input.rootID, touch.sourcePath)
          if (!touch.targetPath) continue
          const stat = yield* fs.stat(touch.targetPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (stat) scopedGrounding.note(input.rootID, touch.targetPath, OxpGrounding.statFingerprint(stat))
          else scopedGrounding.remove(input.rootID, touch.targetPath)
        }
      }

      return execution.result satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpConfig.node, OxpGrounding.node, FSUtil.node],
})

export * as OxpPatch from "./patch"
