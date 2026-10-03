import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Usage } from "@/usage/usage"
import { RootHttpApi } from "../api"
import { UsageSummaryQuery } from "../groups/usage"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { notFound } from "../errors"

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

    const sessionContext = Effect.fn("UsageHttpApi.sessionContext")(function* ({
      params,
    }: {
      params: { sessionID: string }
    }) {
      const usage = yield* Usage.Service
      const history = yield* usage.sessionContext(params.sessionID)
      if (!history) return yield* Effect.fail(notFound(`Session not found: ${params.sessionID}`))
      const telemetry = yield* SessionTelemetry.Service
      const live = yield* telemetry.snapshot([params.sessionID])
      return {
        history,
        telemetry: live[params.sessionID] ?? null,
      }
    })

    return handlers
      .handle("summary", summary)
      .handle("modelProfile", () => Effect.flatMap(Usage.Service, (usage) => usage.modelProfile()))
      .handle("pricingCatalog", () => Effect.flatMap(Usage.Service, (usage) => usage.pricingCatalog()))
      .handle("sessionContext", sessionContext)
  }),
)
