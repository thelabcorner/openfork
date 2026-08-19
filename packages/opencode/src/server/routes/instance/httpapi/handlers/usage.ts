import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Usage } from "@/usage/usage"
import { InstanceHttpApi } from "../api"
import { UsageSummaryQuery } from "../groups/usage"

export const usageHandlers = HttpApiBuilder.group(InstanceHttpApi, "usage", (handlers) =>
  Effect.gen(function* () {
    const usage = yield* Usage.Service

    const summary = Effect.fn("UsageHttpApi.summary")(function* (ctx: { query: typeof UsageSummaryQuery.Type }) {
      return yield* usage.summary({
        since: ctx.query.since,
        until: ctx.query.until,
        resolution: ctx.query.resolution,
        projectID: ctx.query.projectID ?? null,
      })
    })

    return handlers.handle("summary", summary)
  }),
)
