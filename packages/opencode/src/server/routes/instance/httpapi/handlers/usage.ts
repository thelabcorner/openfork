import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Usage } from "@/usage/usage"
import { RootHttpApi } from "../api"
import { UsageSummaryQuery } from "../groups/usage"

export const usageHandlers = HttpApiBuilder.group(RootHttpApi, "usage", (handlers) =>
  Effect.gen(function* () {
    const summary = Effect.fn("UsageHttpApi.summary")(function* (ctx: { query: typeof UsageSummaryQuery.Type }) {
      const usage = yield* Usage.Service
      return yield* usage.summary({
        since: ctx.query.since,
        until: ctx.query.until,
        resolution: ctx.query.resolution,
        projectID: ctx.query.projectID ?? null,
      })
    })

    return handlers
      .handle("summary", summary)
      .handle("modelProfile", () => Effect.flatMap(Usage.Service, (usage) => usage.modelProfile()))
      .handle("pricingCatalog", () => Effect.flatMap(Usage.Service, (usage) => usage.pricingCatalog()))
  }),
)
