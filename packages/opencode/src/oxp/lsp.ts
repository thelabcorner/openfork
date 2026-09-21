import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { ExchangeError } from "@/exchange/error"
import { ExchangeLsp } from "@/exchange/lsp"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({ description: "Approved root that contains the LSP target file." }),
  ...ExchangeLsp.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpLsp") {}
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
  if (error instanceof OxpError.PathEscape) return new ExchangeError.PathEscape({ detail: error.message })
  if (error instanceof OxpError.NotFound) return new ExchangeError.NotFound({ detail: error.message })
  if (error instanceof OxpError.Cancelled) return new ExchangeError.Cancelled({ detail: error.message })
  if (error instanceof OxpError.InvalidArgument) return new ExchangeError.InvalidArgument({ detail: error.message })
  if (error instanceof OxpError.Conflict) return new ExchangeError.Conflict({ detail: error.message })
  if (error instanceof OxpError.AuthDenied || error instanceof OxpError.AuthRevoked || error instanceof OxpError.RootRequired) {
    return new ExchangeError.AuthorityDenied({ detail: error.message })
  }
  return new ExchangeError.DependencyUnavailable({ detail: error.message })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service

    const execute = Effect.fn("OxpLsp.execute")(function* (input: Input, signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP LSP operation was cancelled" })
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "lsp",
        phase: "read",
        rootID: input.rootID,
        path: input.filePath,
      })
      if (!admission.root || !("path" in admission.root)) {
        return yield* new OxpError.RootRequired({ detail: "lsp requires an explicit file inside an approved root" })
      }
      const target = admission.root
      const file = target.path

      const { rootID: _rootID, ...params } = input
      const result = yield* ExchangeLsp.execute(params, {
        rootPath: target.canonicalPath,
        filePath: file,
        virtualPath: target.virtualPath,
        signal,
        toVirtualPath: (absolutePath) => roots.toVirtualPath(target.root, absolutePath),
        revalidate: () => authority.revalidate(admission, "egress").pipe(Effect.asVoid, Effect.mapError(authorityError)),
      }).pipe(Effect.mapError(mapExchangeError))
      return {
        ...result,
        metadata: { ...result.metadata, rootID: input.rootID },
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpAuthority.node, OxpRoot.node] })

export * as OxpLsp from "./lsp"
