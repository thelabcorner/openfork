import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { ExchangeError } from "@/exchange/error"
import { ExchangeMemory } from "@/exchange/memory"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({ description: "Approved root whose project/workspace memory is addressed." }),
  ...ExchangeMemory.Parameters.fields,
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpMemory") {}
export const use = serviceUse(Service)

const READ_ACTIONS = new Set<Input["action"]>(["map", "search", "open", "get", "timeline"])

function mapExchangeError(error: unknown, signal?: AbortSignal): OxpError.Error {
  if (signal?.aborted || error instanceof ExchangeError.Cancelled) {
    return new OxpError.Cancelled({ detail: "OXP memory operation was cancelled" })
  }
  if (OxpError.isError(error)) return error
  if (error instanceof ExchangeError.InvalidArgument) return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.NotFound) return new OxpError.NotFound({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.Conflict) return new OxpError.Conflict({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.AuthorityDenied) return new OxpError.AuthRevoked({ detail: OxpError.boundDetail(error.detail) })
  if (error instanceof ExchangeError.PathEscape) return new OxpError.PathEscape({ detail: OxpError.boundDetail(error.detail) })
  return new OxpError.DependencyUnavailable({ detail: "OpenFork memory runtime is unavailable" })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service

    const execute = Effect.fn("OxpMemory.execute")(function* (input: Input, signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP memory operation was cancelled" })
      const readOnly = READ_ACTIONS.has(input.action)
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: readOnly ? "memory.read" : "memory.write",
        phase: readOnly ? "read" : "mutate",
        rootID: input.rootID,
      })
      if (!admission.root || "path" in admission.root) {
        return yield* new OxpError.RootRequired({ detail: "memory requires one explicit approved root" })
      }
      const root = admission.root
      const { rootID: _rootID, ...params } = input
      const result = yield* ExchangeMemory.executeRuntime(params, {
        rootPath: root.canonicalPath,
        signal,
        ...(readOnly
          ? {}
          : {
              beforeMutation: () => authority.revalidate(admission, "commit").pipe(Effect.asVoid),
            }),
      }).pipe(Effect.mapError((error) => mapExchangeError(error, signal)))

      yield* authority.revalidate(admission, "egress")
      return {
        title: `Memory ${input.action}`,
        output: result.output,
        structured: result.structured,
        metadata: { action: input.action, rootID: input.rootID },
        ...(readOnly ? {} : { mutation: result.mutation }),
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpAuthority.node] })

export * as OxpMemory from "./memory"
