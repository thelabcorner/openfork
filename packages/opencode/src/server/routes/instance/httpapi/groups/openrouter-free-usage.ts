import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"

// Keep directory/workspace query keys accepted for existing unified-SDK
// callers. This account-global report deliberately ignores them and never
// acquires a workspace route or execution Instance.
export const OpenRouterFreeUsageQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  includeValue: Schema.optional(QueryBoolean),
  forceRefresh: Schema.optional(QueryBoolean),
})

export const OpenRouterFreeUsageModelSchema = Schema.Struct({
  model: Schema.String,
  paidSibling: Schema.Union([Schema.String, Schema.Null]),
  requests: Schema.Number,
  tokens: Schema.Struct({
    prompt: Schema.Number,
    completion: Schema.Number,
    reasoning: Schema.Number,
    total: Schema.Number,
  }),
  value: Schema.Struct({
    equivalentPaidValueUsd: Schema.Union([Schema.Number, Schema.Null]),
    pricingFound: Schema.Boolean,
  }),
}).annotate({ identifier: "OpenRouterFreeUsageModel" })

export const OpenRouterFreeUsageResponse = Schema.Struct({
  free: Schema.Struct({
    remaining: Schema.Number,
    limit: Schema.Union([Schema.Literal(50), Schema.Literal(1000)]),
    remainingPercent: Schema.Number,
    used: Schema.Number,
    usedPercent: Schema.Number,
    status: Schema.Union([
      Schema.Literal("healthy"),
      Schema.Literal("draining"),
      Schema.Literal("low"),
      Schema.Literal("critical"),
      Schema.Literal("terminal"),
      Schema.Literal("depleted"),
    ]),
    tier: Schema.Struct({
      source: Schema.Union([Schema.Literal("override"), Schema.Literal("credits-api")]),
      totalCreditsPurchased: Schema.Union([Schema.Number, Schema.Null]),
    }),
    tokens: Schema.Struct({
      prompt: Schema.Number,
      completion: Schema.Number,
      reasoning: Schema.Number,
      total: Schema.Number,
    }),
    value: Schema.Struct({
      equivalentPaidValueUsd: Schema.Number,
      valuedRequests: Schema.Number,
      unvaluedRequests: Schema.Number,
      methodology: Schema.Literal("current-paid-sibling-list-price"),
      cacheAware: Schema.Literal(false),
      note: Schema.String,
    }),
    window: Schema.Struct({
      type: Schema.Literal("calendar-day"),
      timezone: Schema.Literal("UTC"),
      startedAt: Schema.String,
      resetsAt: Schema.String,
      secondsUntilReset: Schema.Number,
    }),
    reset: Schema.Struct({
      policy: Schema.Literal("midnight-utc"),
      confidence: Schema.Literal("high"),
      basis: Schema.String,
    }),
    rate: Schema.Struct({
      limitPerMinute: Schema.Literal(20),
      observedRequestsPerMinute: Schema.Number,
      source: Schema.Union([
        Schema.Literal("snapshot-delta"),
        Schema.Literal("day-average"),
        Schema.Literal("insufficient-data"),
      ]),
    }),
    projection: Schema.Struct({
      requestsPerHour: Schema.Number,
      rateSource: Schema.Union([
        Schema.Literal("snapshot-delta"),
        Schema.Literal("day-average"),
        Schema.Literal("insufficient-data"),
      ]),
      sustainableRequestsPerHour: Schema.Number,
      projectedRemainingAtReset: Schema.Number,
      willExhaustBeforeReset: Schema.Boolean,
      estimatedExhaustionAt: Schema.Union([Schema.String, Schema.Null]),
    }),
    models: Schema.Array(OpenRouterFreeUsageModelSchema),
  }),
  source: Schema.Struct({
    mode: Schema.Literal("openrouter-analytics"),
    scope: Schema.Literal("account"),
    analyticsAsOf: Schema.String,
    fetchedAt: Schema.String,
    stale: Schema.Boolean,
    analyticsRows: Schema.Number,
    analyticsTruncated: Schema.Boolean,
    upstreamCalls: Schema.Number,
  }),
}).annotate({ identifier: "OpenRouterFreeUsage" })

export const OpenRouterFreeUsagePath = "/experimental/openrouter-free-usage" as const

export const OpenRouterFreeUsageApi = HttpApi.make("openrouter-free-usage").add(
  HttpApiGroup.make("openrouterFreeUsage")
    .add(
      HttpApiEndpoint.get("get", OpenRouterFreeUsagePath, {
        query: OpenRouterFreeUsageQuery,
        success: described(OpenRouterFreeUsageResponse, "OpenRouter free usage"),
        error: HttpApiError.InternalServerError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.openrouterFreeUsage.get",
          summary: "Get OpenRouter free usage",
          description:
            "Read account-scoped OpenRouter free-model usage through a bootstrap-free process-global proxy. The usage report is independent of the selected workspace.",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(
      OpenApi.annotations({
        title: "openrouter-free-usage",
        description:
          "Tier-0 account-global OpenRouter usage. Never initializes workspace configuration or an execution Instance.",
      }),
    ),
)
