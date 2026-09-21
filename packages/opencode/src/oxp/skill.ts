import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ExchangeError } from "@/exchange/error"
import { ExchangeSkill } from "@/exchange/skill"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({
    description: "Approved OXP root whose project-local skills may be discovered or loaded.",
  }),
  ...ExchangeSkill.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (
    input: Input,
    signal?: AbortSignal,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpSkill") {}
export const use = serviceUse(Service)

function mapExchangeError(error: ExchangeError.Error): OxpError.Error {
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.message) })
  if (error instanceof ExchangeError.NotFound) return new OxpError.NotFound({ detail: OxpError.boundDetail(error.message) })
  if (error instanceof ExchangeError.Cancelled) return new OxpError.Cancelled({ detail: OxpError.boundDetail(error.message) })
  if (error instanceof ExchangeError.AuthorityDenied) return new OxpError.AuthDenied({ detail: OxpError.boundDetail(error.message) })
  if (error instanceof ExchangeError.PathEscape) return new OxpError.PathEscape({ detail: OxpError.boundDetail(error.message) })
  if (error instanceof ExchangeError.Conflict) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.message) })
  return new OxpError.DependencyUnavailable({ detail: OxpError.boundDetail(error.message) })
}

function authorityError(error: OxpError.Error): ExchangeError.Error {
  switch (error._tag) {
    case "OXP_AUTH_DENIED":
    case "OXP_AUTH_REVOKED":
    case "OXP_ROOT_REQUIRED":
      return new ExchangeError.AuthorityDenied({ detail: error.message })
    case "OXP_PATH_ESCAPE":
      return new ExchangeError.PathEscape({ detail: error.message })
    case "OXP_NOT_FOUND":
      return new ExchangeError.NotFound({ detail: error.message })
    case "OXP_CANCELLED":
      return new ExchangeError.Cancelled({ detail: error.message })
    case "OXP_INVALID_ARGUMENT":
      return new ExchangeError.InvalidArgument({ detail: error.message })
    case "OXP_CONFLICT":
      return new ExchangeError.Conflict({ detail: error.message })
    default:
      return new ExchangeError.DependencyUnavailable({ detail: error.message })
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service
    const fs = yield* FSUtil.Service

    const execute = Effect.fn("OxpSkill.execute")(function* (input: Input, signal?: AbortSignal) {
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "skill.read",
        phase: "read",
        rootID: input.rootID,
      })
      if (!admission.root || "path" in admission.root) {
        return yield* new OxpError.RootRequired({ detail: "skill requires one explicit approved root" })
      }
      const root = admission.root
      const { rootID: _rootID, ...params } = input

      const result = yield* ExchangeSkill.execute(fs, params, {
        rootPath: root.canonicalPath,
        signal,
        resolvePath: (value) =>
          authority
            .authorize({
              plane: "augmentation",
              operation: "skill.read",
              phase: "read",
              rootID: input.rootID,
              path: value,
            })
            .pipe(
              Effect.mapError(authorityError),
              Effect.flatMap((scoped) => {
                if (!scoped.root || !("path" in scoped.root)) {
                  return Effect.fail(
                    new ExchangeError.InvalidArgument({
                      detail: "skill path did not resolve inside the approved root",
                    }),
                  )
                }
                return Effect.succeed({
                  path: scoped.root.path,
                  virtualPath: scoped.root.virtualPath,
                })
              }),
            ),
        toVirtualPath: (absolutePath) => roots.toVirtualPath(root.root, absolutePath),
        revalidate: () => authority.revalidate(admission, "egress").pipe(Effect.asVoid, Effect.mapError(authorityError)),
      }).pipe(Effect.mapError(mapExchangeError))

      return {
        ...result,
        mutation: { attempted: false, committed: false },
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpRoot.node, FSUtil.node],
})

export * as OxpSkill from "./skill"
