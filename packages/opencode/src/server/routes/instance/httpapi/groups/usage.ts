import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Usage } from "@/usage/usage"
import { described } from "./metadata"
import { Authorization } from "../middleware/authorization"

export const UsagePaths = {
  summary: "/usage/summary",
  modelProfile: "/usage/model-profile",
  pricingCatalog: "/usage/pricing-catalog",
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
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({ title: "usage", description: "Global usage analytics." })),
)
