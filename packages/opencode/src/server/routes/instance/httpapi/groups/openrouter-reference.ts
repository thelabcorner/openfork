import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const OpenRouterReferencePaths = {
  endpoints: "/experimental/openrouter-endpoints",
  telemetry: "/experimental/openrouter-telemetry",
} as const

// Keep the historical directory/workspace query keys in the wire contract so
// existing generated clients remain source-compatible. This Tier-0 route
// deliberately ignores them: OpenRouter endpoint topology is process-global
// reference data and must never bootstrap a workspace Instance.
export const OpenRouterEndpointsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
})

export const OpenRouterEndpointSchema = Schema.Struct({
  providerName: Schema.String,
  tag: Schema.String,
  provider: Schema.String,
  pricing: Schema.Struct({
    prompt: Schema.Number,
    completion: Schema.Number,
    cacheRead: Schema.Number,
  }),
  uptime: Schema.optional(Schema.Number),
  quantization: Schema.optional(Schema.String),
  contextLength: Schema.optional(Schema.Number),
  maxCompletionTokens: Schema.optional(Schema.Number),
  maxPromptTokens: Schema.optional(Schema.Number),
  supportedParameters: Schema.optional(Schema.Array(Schema.String)),
  supportsImplicitCaching: Schema.optional(Schema.Boolean),
  latencyP50: Schema.optional(Schema.Number),
  throughputP50: Schema.optional(Schema.Number),
  uptime5m: Schema.optional(Schema.Number),
  uptime1d: Schema.optional(Schema.Number),
  status: Schema.optional(Schema.Number),
}).annotate({ identifier: "OpenRouterEndpoint" })

export const OpenRouterEndpointsResponse = Schema.Array(OpenRouterEndpointSchema).annotate({
  identifier: "OpenRouterEndpoints",
})

export const OpenRouterTelemetryQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  timeRange: Schema.optional(Schema.Union([Schema.Literal("1w"), Schema.Literal("3d")])),
})

export const OpenRouterTelemetryItemSchema = Schema.Struct({
  endpointId: Schema.String,
  providerName: Schema.String,
  providerSlug: Schema.String,
  cacheHitPercent: Schema.Number,
  throughputTps: Schema.optional(Schema.Number),
}).annotate({ identifier: "OpenRouterTelemetryItem" })

export const OpenRouterTelemetryResponse = Schema.Array(OpenRouterTelemetryItemSchema).annotate({
  identifier: "OpenRouterTelemetry",
})

export const OpenRouterReferenceApi = HttpApi.make("openrouter-reference").add(
  HttpApiGroup.make("openrouterReference")
    .add(
      HttpApiEndpoint.get("endpoints", OpenRouterReferencePaths.endpoints, {
        query: OpenRouterEndpointsQuery,
        success: described(OpenRouterEndpointsResponse, "OpenRouter upstream providers"),
        error: HttpApiError.InternalServerError,
      }).annotateMerge(
        OpenApi.annotations({
          // Preserve the established unified-SDK surface even though the
          // transport owner is now a dedicated Tier-0 group.
          identifier: "experimental.openrouterEndpoints.get",
          summary: "Get OpenRouter upstream providers",
          description:
            "Read OpenRouter's public /models/{id}/endpoints through a bootstrap-free process-global proxy. Returns the upstream infrastructure providers serving a model, or an empty list when a model has none.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("openrouterTelemetry", OpenRouterReferencePaths.telemetry, {
        query: OpenRouterTelemetryQuery,
        success: described(OpenRouterTelemetryResponse, "OpenRouter telemetry"),
        error: HttpApiError.InternalServerError,
      }).annotateMerge(
        OpenApi.annotations({
          // Preserve the existing generated-client operation while moving the
          // owner out of InstanceContext.
          identifier: "experimental.openrouterTelemetry.get",
          summary: "Get OpenRouter telemetry",
          description:
            "Read OpenRouter effective-pricing and throughput reference telemetry through a bootstrap-free process-global proxy.",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(
      OpenApi.annotations({
        title: "openrouter-reference",
        description:
          "Tier-0 process-global OpenRouter reference metadata. Never initializes workspace configuration or an execution Instance.",
      }),
    ),
)
