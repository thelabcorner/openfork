import { Auth } from "@/auth"
import { OpenRouterFreeUsageTracker } from "@/openrouter/free-usage/tracker"
import type { FreeUsageReport } from "@/openrouter/free-usage/types"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OpenRouterFreeUsageApi, OpenRouterFreeUsageQuery } from "../groups/openrouter-free-usage"

// Account-global process owner. Workspace routing and InstanceContext are not
// dependencies of this handler.
const openRouterFreeUsageTrackers = new Map<string, OpenRouterFreeUsageTracker>()

function degradedFreeUsageReport(note: string): FreeUsageReport {
  const fetchedAt = new Date()
  const resetsAt = new Date(fetchedAt.getTime() + 86_400_000)
  return {
    free: {
      remaining: 0,
      limit: 50,
      remainingPercent: 0,
      used: 0,
      usedPercent: 0,
      status: "depleted",
      tier: { source: "override", totalCreditsPurchased: null },
      tokens: { prompt: 0, completion: 0, reasoning: 0, total: 0 },
      value: {
        equivalentPaidValueUsd: 0,
        valuedRequests: 0,
        unvaluedRequests: 0,
        methodology: "current-paid-sibling-list-price",
        cacheAware: false,
        note,
      },
      window: {
        type: "calendar-day",
        timezone: "UTC",
        startedAt: fetchedAt.toISOString(),
        resetsAt: resetsAt.toISOString(),
        secondsUntilReset: 86_400,
      },
      reset: {
        policy: "midnight-utc",
        confidence: "high",
        basis: "No usable analytics data available.",
      },
      rate: { limitPerMinute: 20, observedRequestsPerMinute: 0, source: "insufficient-data" },
      projection: {
        requestsPerHour: 0,
        rateSource: "insufficient-data",
        sustainableRequestsPerHour: 0,
        projectedRemainingAtReset: 0,
        willExhaustBeforeReset: false,
        estimatedExhaustionAt: null,
      },
      models: [],
    },
    source: {
      mode: "openrouter-analytics",
      scope: "account",
      analyticsAsOf: fetchedAt.toISOString(),
      fetchedAt: fetchedAt.toISOString(),
      stale: true,
      analyticsRows: 0,
      analyticsTruncated: false,
      upstreamCalls: 0,
    },
  }
}

export const openRouterFreeUsageHandlers = HttpApiBuilder.group(
  OpenRouterFreeUsageApi,
  "openrouterFreeUsage",
  (handlers) =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const credential = yield* Credential.Service

      const get = Effect.fn("OpenRouterFreeUsageHttpApi.get")(function* (ctx: {
        query: typeof OpenRouterFreeUsageQuery.Type
      }) {
        const envKey = process.env.OPENROUTER_MANAGEMENT_KEY?.trim()
        let managementKey: string | undefined = envKey && envKey.length > 0 ? envKey : undefined
        if (!managementKey) {
          const stored = yield* auth.get("openrouter-management").pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (stored?.type === "api") managementKey = stored.key.trim() || undefined
          if (stored?.type === "oauth") managementKey = stored.access.trim() || undefined
          if (stored?.type === "wellknown") managementKey = stored.token.trim() || undefined
        }
        if (!managementKey) {
          const integrationID = Integration.ID.make("openrouter")
          const list = yield* credential
            .list(integrationID)
            .pipe(Effect.catch(() => Effect.succeed([] as Credential.Info[])))
          const active = list.find((entry) => entry.active) ?? list[0]
          if (active) {
            if (active.value.type === "key" && typeof active.value.key === "string" && active.value.key.length > 0) {
              managementKey = active.value.key
            } else if (
              active.value.type === "oauth" &&
              typeof (active.value as unknown as { access: string }).access === "string"
            ) {
              managementKey = (active.value as unknown as { access: string }).access
            }
          }
        }
        if (!managementKey) {
          const stored = yield* auth.get("openrouter").pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (stored?.type === "api") managementKey = stored.key.trim() || undefined
          if (stored?.type === "oauth") managementKey = stored.access.trim() || undefined
          if (stored?.type === "wellknown") managementKey = stored.token.trim() || undefined
        }
        if (!managementKey) {
          const fallback = process.env.OPENROUTER_API_KEY?.trim()
          if (fallback && fallback.length > 0) managementKey = fallback
        }
        if (!managementKey) return degradedFreeUsageReport("No OpenRouter key configured; usage unavailable.")

        const namespace = `openrouter-free-usage:${managementKey.slice(0, 12)}`
        let tracker = openRouterFreeUsageTrackers.get(managementKey)
        if (!tracker) {
          tracker = new OpenRouterFreeUsageTracker({
            managementKey,
            cacheNamespace: namespace,
          })
          openRouterFreeUsageTrackers.set(managementKey, tracker)
        }
        const includeValue = ctx.query.includeValue ?? true
        const forceRefresh = ctx.query.forceRefresh ?? false
        return yield* Effect.tryPromise({
          try: () => tracker!.getUsage({ includeValue, forceRefresh }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch(() =>
            Effect.succeed(
              degradedFreeUsageReport("OpenRouter usage unavailable; a Management key is required for analytics."),
            ),
          ),
        )
      })

      return handlers.handle("get", get)
    }),
)
