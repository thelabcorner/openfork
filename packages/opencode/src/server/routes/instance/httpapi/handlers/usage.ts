import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Usage } from "@/usage/usage"
import { RootHttpApi } from "../api"
import { UsageSummaryQuery } from "../groups/usage"
import type { WorkloadRequest } from "@/usage/workload"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { InvalidRequestError, notFound } from "../errors"

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

    const workload = Effect.fn("UsageHttpApi.workload")(function* (ctx: { query: WorkloadRequest }) {
      const usage = yield* Usage.Service
      const { since, until, providerID, modelID, projectID, limit } = ctx.query
      if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0 || until <= since ||
        until > Date.now() + 86_400_000 || (modelID !== undefined && !providerID) ||
        (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) ||
        [providerID, modelID, projectID].some((value) => value !== undefined && (value.length === 0 || value.length > 256))) {
        return yield* new InvalidRequestError({ message: "Invalid workload range or selectors" })
      }
      return yield* usage.workload({ since, until, providerID, modelID, projectID, limit })
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
      .handle("workload", workload)
      .handle("modelProfile", () => Effect.flatMap(Usage.Service, (usage) => usage.modelProfile()))
      .handle("pricingCatalog", () => Effect.flatMap(Usage.Service, (usage) => usage.pricingCatalog()))
      .handle("sessionContext", sessionContext)
  }),
)
