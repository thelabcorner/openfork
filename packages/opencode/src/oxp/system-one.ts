import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { SystemOne as Contract } from "@opencode-ai/schema/system-one"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"
import { OxpSystemOneControl } from "./system-one-control"

const MAX_TIMEOUT_MS = 120_000

export const Parameters = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({
    description: "Approved OXP root whose OpenFork provider catalog/config owns this inference.",
  }),
  providerID: Contract.InferInput.fields.providerID,
  modelID: Contract.InferInput.fields.modelID,
  accountID: Contract.InferInput.fields.accountID,
  affinityID: Contract.InferInput.fields.affinityID,
  state: Contract.InferInput.fields.state,
  questions: Contract.InferInput.fields.questions,
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS)),
  ).annotate({
    description: "Positive inference deadline in milliseconds, capped at 120000.",
  }),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (
    input: Input,
    signal?: AbortSignal,
  ) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpSystemOne") {}
export const use = serviceUse(Service)

function metadata(error: unknown): Record<string, string | number | boolean> | undefined {
  if (!error || typeof error !== "object") return
  const source = error as Record<string, unknown>
  const out: Record<string, string | number | boolean> = {}
  for (const key of ["providerID", "modelID", "primitive", "required", "retryAfterMs"] as const) {
    const value = source[key]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

function mapRuntimeError(error: unknown, signal?: AbortSignal): OxpError.Error {
  if (signal?.aborted) return new OxpError.Cancelled({ detail: "OXP System One inference was cancelled" })
  if (!error || typeof error !== "object") {
    return new OxpError.DependencyUnavailable({ detail: "System One inference is unavailable" })
  }

  const source = error as {
    _tag?: unknown
    message?: unknown
    reason?: { _tag?: unknown; message?: unknown; kind?: unknown; retryAfterMs?: unknown }
  }
  const detail = typeof source.message === "string" && source.message ? source.message : "System One inference failed"
  const meta = metadata(error)

  if (source._tag === "ProviderModelNotFoundError") {
    return new OxpError.NotFound({ detail, metadata: meta })
  }
  if (source._tag === "ProviderUnsupportedModelPrimitiveError") {
    return new OxpError.InvalidArgument({ detail, metadata: meta })
  }
  if (source._tag !== "LLM.Error" || !source.reason) {
    return new OxpError.DependencyUnavailable({ detail: "System One inference is unavailable" })
  }

  const reason = source.reason
  const reasonDetail = typeof reason.message === "string" && reason.message ? reason.message : detail
  switch (reason._tag) {
    case "InvalidRequest":
    case "ContentPolicy":
      return new OxpError.InvalidArgument({ detail: reasonDetail })
    case "Authentication":
    case "QuotaExceeded":
      return new OxpError.ProviderAccountUnavailable({ detail: reasonDetail })
    case "RateLimit":
      return new OxpError.Busy({
        detail: reasonDetail,
        metadata: typeof reason.retryAfterMs === "number" ? { retryAfterMs: reason.retryAfterMs } : undefined,
      })
    case "Transport":
      return reason.kind === "Timeout"
        ? new OxpError.Timeout({ detail: reasonDetail })
        : new OxpError.IntegrationOffline({ detail: reasonDetail })
    default:
      return new OxpError.IntegrationOffline({ detail: reasonDetail })
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const control = yield* OxpSystemOneControl.Service

    const execute = Effect.fn("OxpSystemOne.execute")(function* (input: Input, signal?: AbortSignal) {
      if (signal?.aborted) return yield* new OxpError.Cancelled({ detail: "OXP System One inference was cancelled" })

      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "integration.system-one.infer",
        phase: "network",
        rootID: input.rootID,
      })
      if (!admission.root || "path" in admission.root) {
        return yield* new OxpError.RootRequired({ detail: "system-one requires one explicit approved root" })
      }
      const root = admission.root

      const { rootID: _rootID, ...inferInput } = input
      const result = yield* control
        .infer(
          {
            directory: root.canonicalPath,
            signal,
            commitGuard: () =>
              Effect.runPromise(
                authority.revalidate(admission, "network").pipe(Effect.asVoid),
              ),
          },
          inferInput as Contract.InferInput,
        )
        .pipe(Effect.mapError((error) => mapRuntimeError(error, signal)))

      yield* authority.revalidate(admission, "egress")
      return {
        title: `System One · ${result.model}`,
        output: JSON.stringify(result),
        structured: result,
        metadata: {
          providerID: input.providerID,
          modelID: input.modelID,
          ...(input.accountID ? { accountID: input.accountID } : {}),
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          cost: result.cost.total,
        },
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpSystemOneControl.node],
})

export * as OxpSystemOne from "./system-one"
