import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Usage } from "@/usage/usage"
import { WorkloadRequest, WorkloadSnapshot } from "@/usage/workload"
import { described } from "./metadata"
import { Authorization } from "../middleware/authorization"
import { ApiNotFoundError, InvalidRequestError } from "../errors"

export const UsagePaths = {
  summary: "/usage/summary",
  workload: "/usage/workload",
  modelProfile: "/usage/model-profile",
  pricingCatalog: "/usage/pricing-catalog",
  sessionContext: "/usage/session/:sessionID/context",
} as const

export const UsageSummaryQuery = Schema.Struct({
  since: Schema.NumberFromString,
  until: Schema.NumberFromString,
  resolution: Schema.Literals(["hour", "day"]),
  projectID: Schema.optional(Schema.String),
})

export const UsageApi = HttpApi.make("usage").add(
  HttpApiGroup.make("usage")
    .add(
      HttpApiEndpoint.get("summary", UsagePaths.summary, {
        query: UsageSummaryQuery,
        success: described(Usage.UsageSummary, "Global usage summary"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "usage.summary",
          summary: "Get global usage summary",
          description:
            "Aggregate token and cost usage across every session in the database, bucketed by provider, model, variant, project, and time.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("workload", UsagePaths.workload, {
        query: WorkloadRequest,
        success: described(WorkloadSnapshot, "Settled native tool and generation workload"),
        error: [InvalidRequestError],
      }).annotateMerge(OpenApi.annotations({
        identifier: "usage.workload",
        summary: "Get native tool and latency workload",
        description: "Tier-0 scalar-only, time-windowed tool outcomes/durations and distinct host-observed first-token/generation clocks. Historical tool coverage is explicitly partial.",
      })),
    )
    .add(
      HttpApiEndpoint.get("modelProfile", UsagePaths.modelProfile, {
        success: described(Usage.ModelProfile, "Personal model usage profile"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "usage.modelProfile",
          summary: "Get personal model usage profile",
          description:
            "Return compact per-model cost and cache-hit aggregates from recent settled generations without hydrating session history.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("pricingCatalog", UsagePaths.pricingCatalog, {
        success: described(Usage.PricingCatalog, "Global usage pricing catalog"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "usage.pricingCatalog",
          summary: "Get the global usage pricing catalog",
          description:
            "Return model display metadata and base rate cards for usage valuation without loading workspace provider configuration.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("sessionContext", UsagePaths.sessionContext, {
        params: { sessionID: Schema.String },
        success: described(Usage.SessionContextSnapshot, "Session context projection"),
        error: [ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "usage.sessionContext",
          summary: "Get authoritative session context analytics",
          description:
            "Return a bootstrap-free session context snapshot from durable scalar projections plus the bounded live telemetry overlay. Never hydrates conversation history into the client.",
        }),
      ),
    )
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({ title: "usage", description: "Global usage analytics." })),
)
