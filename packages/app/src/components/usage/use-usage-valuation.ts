import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { useServerSync } from "@/context/server-sync"
import { safeQueryData } from "@/utils/safe-query-data"
import {
  buildFuzzyPricingFallbackMap,
  buildPricingFallbackMap,
  mergePricingFallbacks,
  resolveEffectiveCost,
  type CheapnessModel,
  type EffectiveCost,
} from "@/utils/model-cost"
import { computeSubsidy, type SubsidyReport, type SubsidyUsageRow } from "@/utils/usage-subsidy"

export type ValuationProvider = {
  id: string
  name?: string
  models: Record<
    string,
    | {
        id?: string
        name?: string
        family?: string
        cost?: Partial<CheapnessModel["cost"]>
      }
    | undefined
  >
}

const EMPTY_CATALOG: NormalizedProviderListResponse = { all: new Map(), connected: [], default: {} }

export type UsageValuation = {
  catalog: Accessor<CheapnessModel[]>
  catalogByKey: Accessor<Map<string, CheapnessModel>>
  exactFallback: Accessor<ReturnType<typeof buildPricingFallbackMap> | undefined>
  fuzzyFallback: Accessor<ReturnType<typeof buildFuzzyPricingFallbackMap> | undefined>
  /** Exact-then-fuzzy merged map, in the shape `sortByCheapness` expects. */
  mergedFallback: Accessor<Map<string, import("@/utils/model-cost").ModelCost> | undefined>
  /** Free/subsidised usage valued against the merged fallback chain. */
  subsidy: Accessor<SubsidyReport>
  /** Best-known rate card for a usage row, with `borrowed` set when inferred. */
  effectiveCostFor: (providerID: string, modelID: string) => EffectiveCost
  /** Catalog display name for a usage row, falling back to the raw model id. */
  nameFor: (providerID: string, modelID: string) => string
  /** False while the provider catalog is empty — nothing can be priced, and
   * callers must say so rather than render a confident $0. */
  catalogReady: Accessor<boolean>
}

/** Provider catalogs are user-extensible (custom providers, v1 configs), so a
 * model can arrive with a partial or absent cost block. Everything downstream
 * reads `cache.read`/`cache.write` unconditionally, so normalise once here. */
function normalizeCost(cost: Partial<CheapnessModel["cost"]> | undefined): CheapnessModel["cost"] {
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cache: { read: cost?.cache?.read ?? 0, write: cost?.cache?.write ?? 0 },
  }
}

function mergeProviders(global: Iterable<ValuationProvider>, scoped: readonly ValuationProvider[]) {
  const merged = new Map<string, ValuationProvider>()
  for (const provider of [...global, ...scoped]) {
    const previous = merged.get(provider.id)
    merged.set(
      provider.id,
      previous ? { ...previous, ...provider, models: { ...previous.models, ...provider.models } } : provider,
    )
  }
  return [...merged.values()]
}

function toCatalog(providers: readonly ValuationProvider[]): CheapnessModel[] {
  return providers.flatMap((provider) =>
    Object.entries(provider.models).flatMap(([modelID, model]) =>
      model
        ? [
            {
              id: model.id ?? modelID,
              // Catalogs append this routing marker; it is not part of the
              // model's identity and makes fuzzy sibling matching less useful.
              name: (model.name ?? model.id ?? modelID).replace("(latest)", "").trim(),
              family: model.family,
              provider: { id: provider.id, name: provider.name },
              cost: normalizeCost(model.cost),
            },
          ]
        : [],
    ),
  )
}

function sameIdentities(
  previous: readonly { providerID: string; modelID: string }[],
  next: readonly { providerID: string; modelID: string }[],
) {
  return (
    previous.length === next.length &&
    previous.every((item, index) => item.providerID === next[index].providerID && item.modelID === next[index].modelID)
  )
}

/**
 * Shared pricing/valuation state for aggregate usage and session context.
 *
 * The global catalog is observed directly instead of through the global store
 * snapshot. This matters on directory-agnostic routes such as /usage: the
 * store can still be empty while its deferred provider query already has data.
 * A session may additionally supply its directory-scoped providers so custom
 * models remain identifiable and priceable.
 */
export function createUsageValuation(
  rows: Accessor<readonly SubsidyUsageRow[]>,
  scopedProviders: Accessor<readonly ValuationProvider[]> = () => [],
): UsageValuation {
  const serverSync = useServerSync()
  const providerQuery = useQuery(() => serverSync().queryOptions.providers(null))

  const catalog = createMemo(() => {
    const global = safeQueryData(providerQuery, EMPTY_CATALOG)
    return toCatalog(mergeProviders(global.all.values(), scopedProviders()))
  })

  const catalogByKey = createMemo(() => {
    const map = new Map<string, CheapnessModel>()
    for (const model of catalog()) map.set(`${model.provider.id}:${model.id}`, model)
    return map
  })

  const exactFallback = createMemo(() => {
    const list = catalog()
    if (list.length === 0) return undefined
    const map = buildPricingFallbackMap(list)
    return map.size > 0 ? map : undefined
  })

  // Token totals change throughout a streaming turn, but the identities that
  // need price inference usually do not. Preserve the prior array when those
  // identities are unchanged so fuzzy matching stays off the streaming path.
  const usedModels = createMemo((previous: readonly { providerID: string; modelID: string }[]) => {
    const unique = new Map<string, { providerID: string; modelID: string }>()
    for (const row of rows()) unique.set(`${row.providerID}\u0000${row.modelID}`, row)
    const next = [...unique.values()].sort(
      (a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID),
    )
    return sameIdentities(previous, next) ? previous : next
  }, [])

  const fuzzyFallback = createMemo(() => {
    const list = catalog()
    if (list.length === 0) return undefined

    // The full catalog is a useful donor pool, but only models that appear in
    // the current view need to be fuzzy-match queries. Building the old
    // all-unpriced × all-paid matrix was both unnecessary and very expensive.
    const paid = list.filter((model) => model.cost.input > 0 || model.cost.output > 0)
    const targets = usedModels().flatMap(({ providerID, modelID }) => {
      const model = catalogByKey().get(`${providerID}:${modelID}`)
      if (model && (model.cost.input > 0 || model.cost.output > 0)) return []
      if (exactFallback()?.has(modelID)) return []
      return [
        model ?? {
          id: modelID,
          name: modelID,
          provider: { id: providerID },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      ]
    })
    if (paid.length === 0 || targets.length === 0) return undefined
    const map = buildFuzzyPricingFallbackMap([...paid, ...targets])
    return map.size > 0 ? map : undefined
  })

  const mergedFallback = createMemo(() => mergePricingFallbacks(exactFallback(), fuzzyFallback()))

  const subsidy = createMemo<SubsidyReport>(() =>
    computeSubsidy({
      rows: rows(),
      catalogByKey: catalogByKey(),
      exactFallback: exactFallback(),
      fuzzyFallback: fuzzyFallback(),
    }),
  )

  const resolveModel = (providerID: string, modelID: string): CheapnessModel =>
    catalogByKey().get(`${providerID}:${modelID}`) ?? {
      id: modelID,
      name: modelID,
      provider: { id: providerID },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    }

  return {
    catalog,
    catalogByKey,
    exactFallback,
    fuzzyFallback,
    mergedFallback,
    subsidy,
    effectiveCostFor: (providerID, modelID) =>
      resolveEffectiveCost(resolveModel(providerID, modelID), exactFallback(), fuzzyFallback()),
    nameFor: (providerID, modelID) => resolveModel(providerID, modelID).name || modelID,
    catalogReady: () => catalog().length > 0,
  }
}
