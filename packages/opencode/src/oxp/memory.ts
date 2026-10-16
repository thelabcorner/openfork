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
      const startedAt = performance.now()
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
      // Memory read grants do NOT imply Session supervision grants. Federated
      // recall is an opt-in cross-plane lookup, never an authority escalation.
      const wantsHistory = input.action === "search" && input.sources !== "memory"
      const sessionAdmission = wantsHistory
        ? yield* authority.authorize({
            plane: "supervision",
            operation: "session.search",
            phase: "supervise",
            rootID: input.rootID,
          }).pipe(Effect.catch((error) =>
            error._tag === "OXP_AUTH_DENIED" || error._tag === "OXP_AUTH_REVOKED"
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ))
        : undefined
      const authorizedAt = performance.now()
      const result = yield* ExchangeMemory.executeRuntime(params, {
        rootPath: root.canonicalPath,
        signal,
        sessionSearchAuthorized: sessionAdmission !== undefined,
        ...(readOnly
          ? {}
          : {
              beforeMutation: () => authority.revalidate(admission, "commit").pipe(Effect.asVoid),
            }),
      }).pipe(Effect.mapError((error) => mapExchangeError(error, signal)))
      const completedAt = performance.now()

      yield* authority.revalidate(admission, "egress")
      if (sessionAdmission) yield* authority.revalidate(sessionAdmission, "supervise")
      const exitedAt = performance.now()
      return {
        title: `Memory ${input.action}`,
        output: result.output,
        structured: result.structured,
        // End-to-end connector timing can be compared with these server-side
        // stages to distinguish host execution from transport/queue delays.
        metadata: {
          action: input.action,
          rootID: input.rootID,
          ...(result.metadata.runtimeTimingMs ? { runtimeTimingMs: result.metadata.runtimeTimingMs } : {}),
          timingMs: {
            authorization: Math.round(authorizedAt - startedAt),
            execution: Math.round(completedAt - authorizedAt),
            egress: Math.round(exitedAt - completedAt),
            total: Math.round(exitedAt - startedAt),
          },
        },
        ...(readOnly ? {} : { mutation: result.mutation }),
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [OxpAuthority.node] })

export * as OxpMemory from "./memory"
