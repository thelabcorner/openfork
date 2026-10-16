import { Effect, Exit } from "effect"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { Usage } from "@/usage/usage"
import { Quota } from "@/quota/quota"
import { ModelsQuery } from "@/models/query"
import { ModelsQuota } from "@/models/quota"
import * as Tool from "./tool"
import DESCRIPTION from "./models.txt"

export const Parameters = ModelsQuery.Parameters
export type Metadata = { readonly action: string; readonly view: unknown }

/**
 * Native Session adapter. All observations come from existing owners.
 * Usage is one bounded indexed aggregation; quota is fetched for one provider
 * only on explicit request. No model resolution, credentials or inference.
 */
export const ModelsTool = Tool.define<typeof Parameters, Metadata, Provider.Service | ModelsDev.Service | Usage.Service | Quota.Service>(
  "models",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const catalog = yield* ModelsDev.Service
    const usage = yield* Usage.Service
    const quota = yield* Quota.Service
    return {
      exposure: "lazy" as const,
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params) => Effect.gen(function* () {
        const invalid = (detail: string) => new Tool.InvalidArgumentsError({ tool: "models", detail })
        if (params.includeQuota && !params.providerID)
          return yield* invalid("includeQuota requires exactly one providerID to prevent provider-wide network fanout")
        if (params.includeQuota && params.scope === "catalog")
          return yield* invalid("Quota belongs to configured provider accounts; use scope=configured")
        if (params.sort === "usage" && !params.includeUsage)
          return yield* invalid("sort=usage requires includeUsage=true")
        const providers = params.scope === "catalog" ? yield* catalog.get() : yield* provider.list()
        const rows = ModelsQuery.rowsFromProviders(providers)
        let index: Map<string, number> | undefined
        let usageCoverage: { source: string; totalRows: number; coveredRows: number; truncated: boolean } | undefined
        if (params.includeUsage) {
          const until = Date.now()
          const result = yield* usage.inspect({
            action: "breakdown", dimension: "model",
            since: until - 30 * 86_400_000, until, limit: 100, sort: "messages",
          })
          if (result.action !== "breakdown") return yield* invalid("Usage owner did not return a model breakdown")
          index = new Map()
          for (const entry of result.rows) {
            if (!entry.providerID || !entry.modelID) continue
            index.set(ModelsQuery.identity(entry.providerID, entry.modelID), entry.messages)
          }
          usageCoverage = {
            source: "durable-settled-usage-last-30d-top-100",
            totalRows: result.totalRows,
            coveredRows: result.rows.length,
            truncated: result.truncated,
          }
        }
        const view = yield* Effect.try({
          try: () => ModelsQuery.queryModels(rows, params, index),
          catch: (cause) => invalid(cause instanceof Error ? cause.message : "Invalid models query"),
        })
        let quotaSnapshot: ReturnType<typeof ModelsQuota.projectQuota> | undefined
        if (params.includeQuota && params.providerID) {
          const response = yield* Effect.exit(quota.get({ providerID: params.providerID }))
          quotaSnapshot = Exit.isSuccess(response)
            ? ModelsQuota.projectQuota(response.value, new Set(view.action !== "providers" ? view.models.map((row) => row.modelID) : []))
            : {
                source: "provider-account-advisory-not-route-authority", ok: false,
                observedAt: Date.now(), state: "unsupported-or-error", models: Object.create(null),
                windows: [], totalWindows: 0,
              }
        }
        const enriched = view.action !== "providers" && quotaSnapshot ? {
          ...view,
          models: view.models.map((row) => {
            const state = quotaSnapshot.models[row.modelID]
            return state ? { ...row, quota: state } : row
          }),
        } : view
        const result = {
          ...enriched, source: params.scope === "catalog" ? "public-models-dev" : "configured-provider-catalog",
          ...(usageCoverage ? { usageCoverage } : {}),
          ...(quotaSnapshot ? { quotaSnapshot } : {}),
          advisory: "Published zero prices do not establish free access. Quota snapshots are advisory, may be stale and never block routing.",
        }
        const list = enriched.action !== "providers" ? enriched.models.map((m) =>
          `${m.providerID}/${m.modelID} | ${m.name} | ctx=${m.context ?? "?"} | in=${m.inputCost ?? "?"} out=${m.outputCost ?? "?"}${m.usageMessages === undefined ? "" : ` | 30d uses=${m.usageMessages}`}`
        ) : enriched.providers.map((p) => `${p.providerID}: ${p.models} models`)
        return {
          title: "Models",
          output: [`Models · ${result.source} · ${enriched.returned}/${enriched.total}`, ...list,
            usageCoverage ? `Usage: top ${usageCoverage.coveredRows}/${usageCoverage.totalRows} models, 30d; missing usage is unknown, not zero.` : "",
            quotaSnapshot ? `Quota: ${quotaSnapshot.state}; provider windows: ${quotaSnapshot.windows.map((w) =>
              `${w.name}=${w.remainingPercent ?? "?"}%${w.resetAt ? ` (reset ${new Date(w.resetAt).toISOString()})` : ""}`
            ).join(", ") || "not reported"}; model/account observations advisory only.` : "",
          ].filter(Boolean).join("\n"),
          metadata: { action: params.action ?? "list", view: result },
          data: result,
        }
      }),
    }
  }),
)
