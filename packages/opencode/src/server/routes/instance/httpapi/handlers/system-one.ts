import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { LLMError } from "@opencode-ai/llm"
import { Provider } from "@/provider/provider"
import { SystemOne } from "@/system-one/system-one"
import { InstanceHttpApi } from "../api"
import {
  ForbiddenError,
  InvalidRequestError,
  ModelNotFoundError,
  QuotaExceededError,
  RateLimitError,
  TimeoutError,
  UnauthorizedError,
  UpstreamError,
} from "../errors"

function upstreamStatus(error: LLMError): number | undefined {
  if ("http" in error.reason) return error.reason.http?.response?.status
  if ("status" in error.reason && typeof error.reason.status === "number") return error.reason.status
  return undefined
}

export function mapSystemOneError(error: SystemOne.Error) {
  if (error instanceof Provider.ModelNotFoundError) {
    return new ModelNotFoundError({
      providerID: error.providerID,
      modelID: error.modelID,
      suggestions: [...(error.suggestions ?? [])],
      message: error.message,
    })
  }
  if (error instanceof Provider.UnsupportedModelPrimitiveError) {
    return new InvalidRequestError({
      message: error.message,
      kind: "unsupported-model-primitive",
      field: "modelID",
    })
  }
  if (!(error instanceof LLMError)) {
    return new UpstreamError({ service: "system-one", message: "System One inference failed" })
  }

  switch (error.reason._tag) {
    case "Authentication":
      return error.reason.kind === "insufficient-permissions"
        ? new ForbiddenError({ message: error.reason.message })
        : new UnauthorizedError({ message: error.reason.message })
    case "InvalidRequest":
      return new InvalidRequestError({
        message: error.reason.message,
        kind: "system-one-request",
      })
    case "RateLimit":
      return new RateLimitError({
        service: "system-one",
        message: error.reason.message,
        retryAfterMs: error.reason.retryAfterMs,
      })
    case "QuotaExceeded":
      return new QuotaExceededError({
        service: "system-one",
        message: error.reason.message,
      })
    case "Transport":
      return error.reason.kind === "Timeout"
        ? new TimeoutError({ message: error.reason.message, operation: "system-one.infer" })
        : new UpstreamError({
            service: "system-one",
            status: upstreamStatus(error),
            message: error.reason.message,
          })
    default:
      return new UpstreamError({
        service: "system-one",
        status: upstreamStatus(error),
        message: error.reason.message,
      })
  }
}

export const systemOneHandlers = HttpApiBuilder.group(InstanceHttpApi, "system-one", (handlers) =>
  Effect.gen(function* () {
    const systemOne = yield* SystemOne.Service
    return handlers.handle("infer", (ctx) => systemOne.infer(ctx.payload).pipe(Effect.mapError(mapSystemOneError)))
  }),
)
