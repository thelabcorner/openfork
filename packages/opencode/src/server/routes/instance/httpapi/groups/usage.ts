import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Usage } from "@/usage/usage"
import { described } from "./metadata"
import { Authorization } from "../middleware/authorization"

export const UsagePaths = {
  summary: "/usage/summary",
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
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({ title: "usage", description: "Global usage analytics." })),
)
